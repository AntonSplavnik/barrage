import { engine, scene, canvas, CONFIG } from "./engine.js";
import { childRole, descendantsOf, isTrebuchetArmRoot, findTrebuchetArmAncestor, isMissileName, colliderNodesFor } from "./utils.js";
import { visualObjects, visualBaseRotations, trebuchetArmNodes, trebuchetLoadTargets, latestObjectStates, findGameplayRoot } from "./state.js";
import { createAimArrowMeshes } from "./aim.js";

const {
  ArcRotateCamera,
  Color3,
  HemisphericLight,
  MeshBuilder,
  SceneLoader,
  ShadowGenerator,
  StandardMaterial,
  Vector3,
} = BABYLON;

let currentLevelUrl = CONFIG.levelUrl ?? "/assets/level1.glb";

function registerVisualRoots() {
  visualObjects.clear();
  visualBaseRotations.clear();

  for (const transform of scene.transformNodes) {
    if (transform.parent && transform.parent.name !== "__root__") continue;

    const descendants = descendantsOf(transform);
    const visualChild = descendants.find((child) => {
      const role = childRole(child.name);
      return role === "Vis" || role === "ColVis";
    });

    if (!visualChild) continue;

    for (const child of descendants) {
      if (childRole(child.name) === "Col" && child.setEnabled) {
        child.setEnabled(false);
      }
    }

    visualObjects.set(transform.name, transform);
    const baseRotation = transform.rotationQuaternion?.toEulerAngles() ?? transform.rotation;
    visualBaseRotations.set(transform.name, {
      x: baseRotation.x,
      y: baseRotation.y,
      z: baseRotation.z,
    });
  }
}

function registerTrebuchetLoadTargets() {
  trebuchetLoadTargets.clear();

  for (const transform of scene.transformNodes) {
    if (!transform.name.toLowerCase().includes("missile-load-target")) continue;

    const root = findGameplayRoot(transform);
    if (!root) continue;

    trebuchetLoadTargets.set(root.name, {
      targetNode: transform,
      rootNode: root,
      armNode: findTrebuchetArmAncestor(transform),
    });
  }
}

function registerTrebuchetArmNodes() {
  trebuchetArmNodes.clear();

  for (const transform of scene.transformNodes) {
    if (!isTrebuchetArmRoot(transform)) continue;

    const root = findGameplayRoot(transform);
    if (!root) continue;

    trebuchetArmNodes.set(root.name, transform);
  }
}

function applyTrebuchetArmRestPose() {
  for (const transform of scene.transformNodes) {
    if (!isTrebuchetArmRoot(transform)) continue;

    const degrees = CONFIG.trebuchetArmRestRotationZDegrees ?? 15;
    const radians = (degrees * Math.PI) / 180;

    transform.rotationQuaternion = null;
    transform.rotation.z = radians;
    transform.computeWorldMatrix(true);
  }
}

function createFallbackScene() {
  const ground = MeshBuilder.CreateGround("Ground", { width: 14, height: 7 }, scene);
  const groundMat = new StandardMaterial("GroundMat", scene);
  groundMat.diffuseColor = new Color3(0.28, 0.46, 0.32);
  ground.material = groundMat;

  const block = MeshBuilder.CreateBox("Vis", { width: 1.4, height: 1.4, depth: 0.6 }, scene);
  const blockMat = new StandardMaterial("BlockMat", scene);
  blockMat.diffuseColor = new Color3(0.58, 0.36, 0.2);
  block.material = blockMat;
  block.position.set(-3, 0.7, 0);
  visualObjects.set("Block_Wood_P1_01", block);

  const king = MeshBuilder.CreateSphere("King_P1", { diameter: 0.8 }, scene);
  king.position.set(-5.5, 0.4, 0);
}

function ensureCameraAndLight() {
  if (scene.cameras.length > 0) {
    scene.activeCamera = scene.cameras[0];
  } else {
    scene.activeCamera = new ArcRotateCamera("FallbackCamera", Math.PI / 2, Math.PI / 3, 14, Vector3.Zero(), scene);
  }

  if (CONFIG.cameraControlsEnabled) {
    scene.activeCamera.attachControl(canvas, true);
  } else {
    scene.activeCamera.detachControl();
  }

  if (scene.lights.length === 0) {
    const fallbackLight = new HemisphericLight("FallbackLight", new Vector3(0, 1, 0), scene);
    fallbackLight.intensity = CONFIG.fallbackLightIntensity ?? 0.8;
  } else {
    const scale = CONFIG.importedLightIntensityScale ?? 1.0;
    for (const light of scene.lights) {
      light.intensity *= scale;
    }
  }

  console.info("Scene setup", {
    activeCamera: scene.activeCamera.name,
    cameraControlsEnabled: Boolean(CONFIG.cameraControlsEnabled),
    cameras: scene.cameras.map((camera) => camera.name),
    lights: scene.lights.map((light) => ({ name: light.name, intensity: light.intensity })),
  });
}

let missilePickColliderMat = null;

function boundsForVisualNodes(nodes) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const node of nodes) {
    if (typeof node.getHierarchyBoundingVectors !== "function") continue;
    const b = node.getHierarchyBoundingVectors(true);
    minX = Math.min(minX, b.min.x);
    minY = Math.min(minY, b.min.y);
    minZ = Math.min(minZ, b.min.z);
    maxX = Math.max(maxX, b.max.x);
    maxY = Math.max(maxY, b.max.y);
    maxZ = Math.max(maxZ, b.max.z);
  }

  if (!Number.isFinite(minX)) return null;
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function maxWorldScale(node) {
  const m = node.getWorldMatrix().m;
  return Math.max(
    Math.hypot(m[0], m[1], m[2]),
    Math.hypot(m[4], m[5], m[6]),
    Math.hypot(m[8], m[9], m[10]),
    0.0001,
  );
}

export function createMissilePickCollider(root) {
  const scale = CONFIG.missilePickColliderScale ?? 1;
  if (scale <= 1) return;

  const bounds = boundsForVisualNodes(colliderNodesFor(root));
  if (!bounds) return;

  if (!missilePickColliderMat) {
    missilePickColliderMat = new StandardMaterial("MissilePickColliderMat", scene);
    missilePickColliderMat.disableLighting = true;
  }

  const sizeX = (bounds.maxX - bounds.minX) * scale;
  const sizeY = (bounds.maxY - bounds.minY) * scale;
  const sizeZ = (bounds.maxZ - bounds.minZ) * scale;
  const ws = maxWorldScale(root);

  const pickCollider = MeshBuilder.CreateBox(`${root.name}-PickCollider`, {
    width: Math.max(sizeX, 0.1) / ws,
    height: Math.max(sizeY, 0.1) / ws,
    depth: Math.max(sizeZ, 0.1) / ws,
  }, scene);

  const center = new Vector3(
    (bounds.minX + bounds.maxX) / 2,
    (bounds.minY + bounds.maxY) / 2,
    (bounds.minZ + bounds.maxZ) / 2,
  );
  const worldToRoot = root.getWorldMatrix().clone().invert();

  pickCollider.parent = root;
  pickCollider.position = Vector3.TransformCoordinates(center, worldToRoot);
  pickCollider.material = missilePickColliderMat;
  pickCollider.visibility = 0;
  pickCollider.isPickable = true;
  pickCollider.receiveShadows = false;
}

function createMissilePickColliders() {
  for (const root of visualObjects.values()) {
    if (isMissileName(root.name)) {
      createMissilePickCollider(root);
    }
  }
}

function isShadowCapableLight(light) {
  return light.getClassName() !== "HemisphericLight";
}

function shouldReceiveShadows(mesh) {
  const name = mesh.name.toLowerCase();
  return name.includes("ground") || name.includes("plane");
}

function setupShadows() {
  if (!CONFIG.shadowsEnabled) return;

  const light = scene.lights.find(isShadowCapableLight);
  if (!light) {
    console.info("Shadows disabled: no shadow-capable light found.");
    return;
  }

  const shadowGenerator = new ShadowGenerator(CONFIG.shadowMapSize ?? 2048, light);
  shadowGenerator.useBlurExponentialShadowMap = true;
  shadowGenerator.blurKernel = 16;
  shadowGenerator.bias = CONFIG.shadowBias ?? 0.0005;
  shadowGenerator.normalBias = CONFIG.shadowNormalBias ?? 0.02;

  for (const mesh of scene.meshes) {
    if (!mesh.getTotalVertices || mesh.getTotalVertices() === 0) continue;

    const role = childRole(mesh.name);
    if (role === "Col") {
      mesh.receiveShadows = false;
      continue;
    }

    mesh.receiveShadows = shouldReceiveShadows(mesh);

    if (role === "Vis" || role === "ColVis") {
      shadowGenerator.addShadowCaster(mesh, true);
    }
  }

  console.info("Shadows enabled", {
    light: light.name,
    casters: shadowGenerator.getShadowMap().renderList.length,
    mapSize: CONFIG.shadowMapSize ?? 2048,
  });
}

function clearLevel() {
  visualObjects.clear();
  visualBaseRotations.clear();
  trebuchetArmNodes.clear();
  trebuchetLoadTargets.clear();
  latestObjectStates.clear();

  for (const generator of scene.shadowGenerators?.slice() ?? []) {
    generator.dispose();
  }

  const rootNodes = scene.rootNodes.filter((n) => n.name === "__root__");
  for (const root of rootNodes) {
    root.dispose(false, true);
  }
}

export async function loadLevel(url) {
  const levelUrl = url ?? currentLevelUrl;
  currentLevelUrl = levelUrl;

  try {
    await SceneLoader.AppendAsync("", levelUrl, scene);
    applyTrebuchetArmRestPose();
    registerVisualRoots();
    createMissilePickColliders();
    registerTrebuchetArmNodes();
    registerTrebuchetLoadTargets();
    createAimArrowMeshes();

    if (visualObjects.size === 0) {
      createFallbackScene();
    }
  } catch (error) {
    console.error("Failed to load level GLB; using fallback scene.", error);
    createFallbackScene();
  }

  ensureCameraAndLight();
  setupShadows();
  engine.resize();
}

export async function reloadLevel(url) {
  engine.stopRenderLoop();
  clearLevel();
  await loadLevel(url);
  engine.runRenderLoop(() => scene.render());
}
