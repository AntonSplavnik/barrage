import { scene, CONFIG } from "./engine.js";
import { latestObjectStates, trebuchetLoadTargets, setOnAimUpdate } from "./state.js";
import { degreesToRadians, isForwardPullPoint, clampAimTailPoint } from "./utils.js";

const { Color3, MeshBuilder, StandardMaterial, Vector3 } = BABYLON;

let aimArrowShaft = null;
let aimArrowHeadLeft = null;
let aimArrowHeadRight = null;
let aimArrowMaterial = null;

let pointerModeRef = () => "drag";
let selectedEntityIdRef = () => null;
let aimWorldPointRef = () => null;

export function setAimRefs(getPointerMode, getSelectedEntityId, getAimWorldPoint) {
  pointerModeRef = getPointerMode;
  selectedEntityIdRef = getSelectedEntityId;
  aimWorldPointRef = getAimWorldPoint;
}

export function createAimArrowMeshes() {
  if (!aimArrowMaterial) {
    aimArrowMaterial = new StandardMaterial("AimArrowMaterial", scene);
    aimArrowMaterial.diffuseColor = Color3.FromHexString(CONFIG.aimArrowStartColor ?? "#ffffff");
    aimArrowMaterial.emissiveColor = Color3.FromHexString(CONFIG.aimArrowStartColor ?? "#ffffff");
    aimArrowMaterial.specularColor = Color3.Black();
    aimArrowMaterial.disableLighting = true;
    aimArrowMaterial.disableDepthWrite = true;
    aimArrowMaterial.depthFunction = BABYLON.Engine.ALWAYS;
  }

  if (!aimArrowShaft) {
    aimArrowShaft = MeshBuilder.CreateTube("AimArrowShaft", {
      path: [Vector3.Zero(), Vector3.Right()],
      radius: CONFIG.aimArrowRadius ?? 0.06,
      updatable: true,
    }, scene);
    aimArrowShaft.material = aimArrowMaterial;
    aimArrowShaft.isPickable = false;
    aimArrowShaft.renderingGroupId = 2;
    aimArrowShaft.alwaysSelectAsActiveMesh = true;
    aimArrowShaft.setEnabled(false);
  }

  if (!aimArrowHeadLeft) {
    aimArrowHeadLeft = MeshBuilder.CreateTube("AimArrowHeadLeft", {
      path: [Vector3.Zero(), Vector3.Right()],
      radius: CONFIG.aimArrowRadius ?? 0.06,
      updatable: true,
    }, scene);
    aimArrowHeadLeft.material = aimArrowMaterial;
    aimArrowHeadLeft.isPickable = false;
    aimArrowHeadLeft.renderingGroupId = 2;
    aimArrowHeadLeft.alwaysSelectAsActiveMesh = true;
    aimArrowHeadLeft.setEnabled(false);
  }

  if (!aimArrowHeadRight) {
    aimArrowHeadRight = MeshBuilder.CreateTube("AimArrowHeadRight", {
      path: [Vector3.Zero(), Vector3.Right()],
      radius: CONFIG.aimArrowRadius ?? 0.06,
      updatable: true,
    }, scene);
    aimArrowHeadRight.material = aimArrowMaterial;
    aimArrowHeadRight.isPickable = false;
    aimArrowHeadRight.renderingGroupId = 2;
    aimArrowHeadRight.alwaysSelectAsActiveMesh = true;
    aimArrowHeadRight.setEnabled(false);
  }
}

export function hideAimArrow() {
  aimArrowShaft?.setEnabled(false);
  aimArrowHeadLeft?.setEnabled(false);
  aimArrowHeadRight?.setEnabled(false);
}

function updateAimArrowColor(extensionRatio) {
  if (!aimArrowMaterial) return;

  const startColor = Color3.FromHexString(CONFIG.aimArrowStartColor ?? "#ffffff");
  const endColor = Color3.FromHexString(CONFIG.aimArrowEndColor ?? "#39ff14");
  const t = Math.min(1, Math.max(0, extensionRatio));
  const color = new Color3(
    startColor.r + (endColor.r - startColor.r) * t,
    startColor.g + (endColor.g - startColor.g) * t,
    startColor.b + (endColor.b - startColor.b) * t,
  );
  aimArrowMaterial.diffuseColor = color;
  aimArrowMaterial.emissiveColor = color;
}

function releasePointForTrebuchet(trebuchetId) {
  const target = trebuchetLoadTargets.get(trebuchetId);
  if (!target?.targetNode) return null;

  const restRadians = degreesToRadians(CONFIG.trebuchetArmRestRotationZDegrees ?? 15);

  if (target.armNode) {
    const originalZ = target.armNode.rotationQuaternion?.toEulerAngles().z ?? target.armNode.rotation.z;
    target.armNode.rotationQuaternion = null;
    target.armNode.rotation.z = restRadians;
    target.rootNode?.computeWorldMatrix(true);
    target.armNode.computeWorldMatrix(true);
    target.targetNode.computeWorldMatrix(true);
    const position = target.targetNode.getAbsolutePosition().clone();
    target.armNode.rotation.z = originalZ;
    target.armNode.computeWorldMatrix(true);
    target.targetNode.computeWorldMatrix(true);
    return position;
  }

  target.rootNode?.computeWorldMatrix(true);
  target.targetNode.computeWorldMatrix(true);
  return target.targetNode.getAbsolutePosition().clone();
}

export function updateAimArrow() {
  const pointerMode = pointerModeRef();
  const selectedEntityId = selectedEntityIdRef();
  const aimWorldPoint = aimWorldPointRef();

  if (pointerMode !== "aim" || !selectedEntityId || !aimWorldPoint) {
    hideAimArrow();
    return;
  }

  const missileState = latestObjectStates.get(selectedEntityId);
  const trebuchetId = missileState?.loadedInto;
  if (!trebuchetId) {
    hideAimArrow();
    return;
  }

  const headPoint = releasePointForTrebuchet(trebuchetId);
  if (!headPoint) {
    hideAimArrow();
    return;
  }

  const trebuchetState = latestObjectStates.get(trebuchetId);
  if (!trebuchetState || !isForwardPullPoint(trebuchetState, aimWorldPoint, headPoint)) {
    hideAimArrow();
    return;
  }

  const tailPoint = clampAimTailPoint(headPoint, aimWorldPoint.clone(), CONFIG);
  tailPoint.z = headPoint.z + (CONFIG.aimArrowZOffset ?? 0.05);
  headPoint.z += CONFIG.aimArrowZOffset ?? 0.05;

  const backVector = tailPoint.subtract(headPoint);
  const arrowLength = backVector.length();
  if (arrowLength < (CONFIG.aimArrowMinLength ?? 0.12)) {
    hideAimArrow();
    return;
  }

  const backDir = backVector.scale(1 / arrowLength);
  const extensionRatio = arrowLength / Math.max(0.001, CONFIG.aimArrowMaxLength ?? CONFIG.aimMaxPullDistance ?? 4.5);
  updateAimArrowColor(extensionRatio);
  const headLength = Math.min(
    CONFIG.aimArrowHeadLengthMax ?? 0.75,
    Math.max(CONFIG.aimArrowHeadLengthMin ?? 0.2, arrowLength * (CONFIG.aimArrowHeadLengthScale ?? 0.18)),
  );
  const headWidth = Math.max(CONFIG.aimArrowHeadWidth ?? 0.12, headLength * (CONFIG.aimArrowHeadWidthScale ?? 0.45));
  const sideDir = new Vector3(-backDir.y, backDir.x, 0);
  const leftWing = headPoint.add(backDir.scale(headLength)).add(sideDir.scale(headWidth));
  const rightWing = headPoint.add(backDir.scale(headLength)).subtract(sideDir.scale(headWidth));

  MeshBuilder.CreateTube("AimArrowShaft", {
    path: [tailPoint, headPoint],
    radius: CONFIG.aimArrowRadius ?? 0.06,
    instance: aimArrowShaft,
  });
  MeshBuilder.CreateTube("AimArrowHeadLeft", {
    path: [leftWing, headPoint],
    radius: CONFIG.aimArrowRadius ?? 0.06,
    instance: aimArrowHeadLeft,
  });
  MeshBuilder.CreateTube("AimArrowHeadRight", {
    path: [rightWing, headPoint],
    radius: CONFIG.aimArrowRadius ?? 0.06,
    instance: aimArrowHeadRight,
  });

  aimArrowShaft.setEnabled(true);
  aimArrowHeadLeft.setEnabled(true);
  aimArrowHeadRight.setEnabled(true);
}

setOnAimUpdate(() => {
  if (pointerModeRef() === "aim" && selectedEntityIdRef()) {
    updateAimArrow();
  }
});
