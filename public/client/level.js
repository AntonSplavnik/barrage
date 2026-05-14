import { engine, scene, canvas, CONFIG } from "./engine.js";
import { childRole, descendantsOf, isTrebuchetArmRoot, isMissileName, colliderNodesFor } from "./utils.js";
import { visualObjects, visualBaseRotations, trebuchetArmNodes, trebuchetLoadTargets, latestObjectStates, findGameplayRoot } from "./state.js";
import { createAimArrowMeshes } from "./aim.js";
import { getTemplateRoot } from "./templateRegistry.js";

const crackStageVisuals = new Map();
const fragmentVisuals = new Map();

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

let activeShadowGenerator = null;

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

function isShadowCapableLight(light) {
  return light.getClassName() !== "HemisphericLight";
}

function shouldReceiveShadows(mesh) {
  const name = mesh.name.toLowerCase();
  return name.includes("ground") || name.includes("plane");
}

function setupShadows() {
  activeShadowGenerator = null;

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

  activeShadowGenerator = shadowGenerator;

  console.info("Shadows enabled", {
    light: light.name,
    casters: shadowGenerator.getShadowMap().renderList.length,
    mapSize: CONFIG.shadowMapSize ?? 2048,
  });
}

function templatePathFromId(objectId) {
  const lastUnderscore = objectId.lastIndexOf("_");
  if (lastUnderscore < 0) return objectId;
  return objectId.substring(0, lastUnderscore);
}

function registerCloneShadows(clone) {
  if (!activeShadowGenerator) return;
  const descendants = descendantsOf(clone);
  for (const node of descendants) {
    if (!node.getTotalVertices || node.getTotalVertices() === 0) continue;
    const role = childRole(node.name);
    if (role === "Vis" || role === "ColVis") {
      activeShadowGenerator.addShadowCaster(node, true);
    }
    if (role === "Col") {
      if (node.setEnabled) node.setEnabled(false);
    }
    node.receiveShadows = shouldReceiveShadows(node);
  }
}

function findHitStageMesh(templatePath, hitStage) {
  const templateRoot = getTemplateRoot(templatePath);
  if (!templateRoot) return null;

  const stageName = `hit${hitStage}-Visual`;
  const descendants = descendantsOf(templateRoot);
  return descendants.find((d) => d.name.includes(stageName)) ?? null;
}

export function updateCrackStage(objectId, hitStage, fragmentTemplate) {
  const visual = visualObjects.get(objectId);
  if (!visual || !fragmentTemplate) return;

  const prev = crackStageVisuals.get(objectId);
  if (prev) {
    prev.dispose(false, false);
    crackStageVisuals.delete(objectId);
  }

  if (!hitStage || hitStage <= 0) {
    const descendants = descendantsOf(visual);
    for (const node of descendants) {
      const role = childRole(node.name);
      if (role === "Vis" || role === "ColVis") {
        if (node.setEnabled) node.setEnabled(true);
      }
    }
    return;
  }

  const descendants = descendantsOf(visual);
  for (const node of descendants) {
    const role = childRole(node.name);
    if (role === "Vis" || role === "ColVis") {
      if (node.setEnabled) node.setEnabled(false);
    }
  }

  const sourceMesh = findHitStageMesh(fragmentTemplate, hitStage);
  if (!sourceMesh) return;

  const clone = sourceMesh.clone(`${objectId}-crack-${hitStage}`);
  clone.parent = visual;
  clone.position.set(0, 0, 0);
  clone.setEnabled(true);
  registerCloneShadows(clone);
  crackStageVisuals.set(objectId, clone);
}

function findFragMesh(templatePath, pieceIndex) {
  const templateRoot = getTemplateRoot(templatePath);
  if (!templateRoot) return null;

  const suffix = String(pieceIndex + 1).padStart(3, "0");
  const descendants = descendantsOf(templateRoot);
  return descendants.find((d) => d.name.includes(`Frag.${suffix}`)) ?? null;
}

export function createFragmentVisual(fragId, pieceIndex, fragmentTemplate) {
  if (fragmentVisuals.has(fragId)) return;

  const sourceMesh = findFragMesh(fragmentTemplate, pieceIndex);
  if (!sourceMesh) return;

  const clone = sourceMesh.clone(fragId);
  clone.parent = null;
  clone.setEnabled(true);
  registerCloneShadows(clone);
  fragmentVisuals.set(fragId, clone);
  visualObjects.set(fragId, clone);
  visualBaseRotations.set(fragId, { x: 0, y: 0, z: 0 });
}

export function hideBlockVisual(blockId) {
  const visual = visualObjects.get(blockId);
  if (visual) visual.setEnabled(false);

  const crack = crackStageVisuals.get(blockId);
  if (crack) {
    crack.dispose(false, false);
    crackStageVisuals.delete(blockId);
  }
}

export function shrinkAndDisposeFragment(fragId) {
  const visual = fragmentVisuals.get(fragId);
  if (!visual) return;

  const shrinkMs = (window.BARRAGE_CONFIG?.fragmentShrinkMs ?? 500);
  const startTime = performance.now();
  const startScale = visual.scaling?.clone() ?? new BABYLON.Vector3(1, 1, 1);

  const observer = scene.onBeforeRenderObservable.add(() => {
    if (visual.isDisposed()) {
      scene.onBeforeRenderObservable.remove(observer);
      fragmentVisuals.delete(fragId);
      visualObjects.delete(fragId);
      visualBaseRotations.delete(fragId);
      return;
    }

    const elapsed = performance.now() - startTime;
    const t = Math.min(elapsed / shrinkMs, 1);
    const s = 1 - t;
    visual.scaling.set(startScale.x * s, startScale.y * s, startScale.z * s);

    if (t >= 1) {
      scene.onBeforeRenderObservable.remove(observer);
      visual.dispose(false, false);
      fragmentVisuals.delete(fragId);
      visualObjects.delete(fragId);
      visualBaseRotations.delete(fragId);
    }
  });
}

export function ensureVisualsForState(objects) {
  let created = false;

  for (const obj of objects) {
    if (visualObjects.has(obj.id)) continue;

    if (obj.isFragment) {
      createFragmentVisual(obj.id, obj.pieceIndex, obj.fragmentTemplate);
      continue;
    }

    const templatePath = templatePathFromId(obj.id);
    const templateRoot = getTemplateRoot(templatePath);
    if (!templateRoot) continue;

    const clone = templateRoot.clone(obj.id);
    clone.name = obj.id;
    clone.setEnabled(true);
    clone.position.set(obj.x, obj.y, obj.z);

    visualObjects.set(obj.id, clone);
    visualBaseRotations.set(obj.id, { x: 0, y: 0, z: 0 });

    const descendants = descendantsOf(clone);
    for (const node of descendants) {
      const role = childRole(node.name);
      if (role === "Col" && node.setEnabled) {
        node.setEnabled(false);
      }
      if (/hit\d+-Visual/.test(node.name) && node.setEnabled) {
        node.setEnabled(false);
      }
    }

    if (obj.id.startsWith("trebuchets/")) {
      for (const node of descendants) {
        if (isTrebuchetArmRoot(node)) {
          trebuchetArmNodes.set(obj.id, node);
          break;
        }
      }
      for (const node of descendants) {
        if (node.name.toLowerCase().includes("missile-load-target")) {
          trebuchetLoadTargets.set(obj.id, {
            targetNode: node,
            rootNode: clone,
            armNode: trebuchetArmNodes.get(obj.id) ?? null,
          });
          break;
        }
      }
    }

    if (obj.id.startsWith("missiles/")) {
      createMissilePickCollider(clone);
    }

    registerCloneShadows(clone);
    created = true;
  }

  return created;
}

export function clearDestructionVisuals() {
  for (const visual of crackStageVisuals.values()) {
    visual.dispose(false, false);
  }
  crackStageVisuals.clear();

  for (const visual of fragmentVisuals.values()) {
    if (!visual.isDisposed()) visual.dispose(false, false);
  }
  fragmentVisuals.clear();
}

function clearLevel() {
  // dispose(false, false): do NOT dispose shared materials/textures — templates reuse them
  for (const visual of visualObjects.values()) {
    visual.dispose(false, false);
  }
  visualObjects.clear();

  for (const visual of crackStageVisuals.values()) {
    visual.dispose(false, false);
  }
  crackStageVisuals.clear();

  for (const visual of fragmentVisuals.values()) {
    visual.dispose(false, false);
  }
  fragmentVisuals.clear();

  visualBaseRotations.clear();
  trebuchetArmNodes.clear();
  trebuchetLoadTargets.clear();
  latestObjectStates.clear();

  for (const generator of scene.shadowGenerators?.slice() ?? []) {
    generator.dispose();
  }
  activeShadowGenerator = null;

  const arenaRoots = scene.rootNodes.filter((n) => n.name === "__root__");
  for (const root of arenaRoots) {
    root.dispose(false, true);
  }
}

export async function loadLevel(url) {
  if (!url) return;

  try {
    await SceneLoader.AppendAsync("", url, scene);
  } catch (error) {
    console.error("Failed to load arena GLB:", error);
  }

  ensureCameraAndLight();
  setupShadows();
  createAimArrowMeshes();
  engine.resize();
}

export async function reloadLevel(url) {
  engine.stopRenderLoop();
  clearLevel();
  await loadLevel(url);
  engine.runRenderLoop(() => scene.render());
}
