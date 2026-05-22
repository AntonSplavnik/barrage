import { getServerConfig } from "./network.js";
import { latestObjectStates, trebuchetLoadTargets, setOnAimUpdate } from "./state.js";
import { degreesToRadians, isForwardPullPoint } from "./utils.js";
import { getShotArcRenderer } from "./level.js";

const { Vector3 } = BABYLON;

let pointerModeRef = () => "drag";
let selectedEntityIdRef = () => null;
let aimWorldPointRef = () => null;
let wasShowingArc = false;

export function setAimRefs(getPointerMode, getSelectedEntityId, getAimWorldPoint) {
  pointerModeRef = getPointerMode;
  selectedEntityIdRef = getSelectedEntityId;
  aimWorldPointRef = getAimWorldPoint;
}

function hideArc() {
  const renderer = getShotArcRenderer();
  if (renderer) {
    renderer.hide();
    wasShowingArc = false;
  }
}

function releasePointForTrebuchet(trebuchetId) {
  const target = trebuchetLoadTargets.get(trebuchetId);
  if (!target?.targetNode) return null;

  const restRadians = degreesToRadians(getServerConfig("trebuchetArmRestRotationZDegrees") ?? 15);

  if (target.armNode) {
    const trebState = latestObjectStates.get(trebuchetId);
    const armSign = trebState?.player === 2 ? -1 : 1;
    const originalZ = target.armNode.rotationQuaternion?.toEulerAngles().z ?? target.armNode.rotation.z;
    target.armNode.rotationQuaternion = null;
    target.armNode.rotation.z = armSign * restRadians;
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

export function updateAim() {
  const pointerMode = pointerModeRef();
  const selectedEntityId = selectedEntityIdRef();
  const aimWorldPoint = aimWorldPointRef();

  if (pointerMode !== "aim" || !selectedEntityId || !aimWorldPoint) {
    hideArc();
    return;
  }

  const missileState = latestObjectStates.get(selectedEntityId);
  const trebuchetId = missileState?.loadedInto;
  if (!trebuchetId) {
    hideArc();
    return;
  }

  const headPoint = releasePointForTrebuchet(trebuchetId);
  if (!headPoint) {
    hideArc();
    return;
  }

  const trebuchetState = latestObjectStates.get(trebuchetId);
  if (!trebuchetState || !isForwardPullPoint(trebuchetState, aimWorldPoint, headPoint)) {
    hideArc();
    return;
  }

  const renderer = getShotArcRenderer();
  if (renderer) {
    if (trebuchetState?.shotArcPoints) {
      renderer.update(trebuchetState.shotArcPoints, trebuchetState.powerRatio ?? 0);
      wasShowingArc = true;
    } else if (wasShowingArc && (trebuchetState?.fireState === "releasing" || trebuchetState?.fireState === "returning")) {
      renderer.fadeOut();
      wasShowingArc = false;
    } else {
      renderer.hide();
      wasShowingArc = false;
    }
  }
}

setOnAimUpdate(() => {
  if (pointerModeRef() === "aim" && selectedEntityIdRef()) {
    updateAim();
  }
});
