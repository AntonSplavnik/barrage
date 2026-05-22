import { engine, scene, canvas, CONFIG } from "./engine.js";
import { getServerConfig } from "./network.js";
import { childRole, descendantsOf, isTrebuchetArmRoot, isMissileName, colliderNodesFor } from "./utils.js";
import { visualObjects, visualBaseRotations, trebuchetArmNodes, trebuchetLoadTargets, latestObjectStates, findGameplayRoot } from "./state.js";
import { getTemplateRoot } from "./templateRegistry.js";
import { createShotArcRenderer } from "./shotArcRenderer.js";
import { vertexShader, fragmentShader } from "../shaders/skyGradient.js";

const crackStageVisuals = new Map();
const fragmentVisuals = new Map();

let shotArcRenderer = null;

export function getShotArcRenderer() {
  return shotArcRenderer;
}

const {
  ArcRotateCamera,
  Color3,
  DirectionalLight,
  HemisphericLight,
  MeshBuilder,
  SceneLoader,
  ShaderMaterial,
  ShadowGenerator,
  StandardMaterial,
  Vector3,
} = BABYLON;

let activeShadowGenerators = [];
let skyMesh = null;

const FIELD_WIDTH = 90;
const FIELD_HEIGHT = 30;
const FIELD_CENTER_Y = 14.7;
const BASE_RADIUS = 100;
const BASE_FOV = 0.3996;

function setupCameraAndLight() {
  for (const cam of [...scene.cameras]) cam.dispose();

  const camera = new ArcRotateCamera(
    "GameCamera",
    Math.PI / 2,
    Math.PI / 2,
    BASE_RADIUS,
    new Vector3(0, FIELD_CENTER_Y, 0),
    scene,
  );
  camera.fov = BASE_FOV;
  camera.minZ = 0.1;
  camera.maxZ = 500;
  scene.activeCamera = camera;

  if (CONFIG.cameraControlsEnabled) {
    camera.attachControl(canvas, true);
  } else {
    camera.detachControl();
  }

  fitCameraToAspect();

  const scale = CONFIG.importedLightIntensityScale ?? 1.0;
  for (const light of scene.lights) {
    light.intensity *= scale;
    if (light.parent) {
      light.parent.computeWorldMatrix(true);
      const worldMatrix = light.parent.getWorldMatrix();
      light.position = light.parent.getAbsolutePosition().clone();
      if (light.direction) {
        light.direction = Vector3.TransformNormal(new Vector3(0, 0, -1), worldMatrix).normalize();
      }
      light.parent = null;
    }
  }

  for (const mat of scene.materials) {
    mat.maxSimultaneousLights = 8;
  }

  const hemi = new HemisphericLight("AmbientFill", new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.4;
  hemi.groundColor = new Color3(0.2, 0.2, 0.25);
}

export function fitCameraToAspect() {
  const camera = scene.activeCamera;
  if (!camera) return;

  const aspect = engine.getRenderWidth() / engine.getRenderHeight();
  const fovV = camera.fov;
  const visibleH = 2 * BASE_RADIUS * Math.tan(fovV / 2);
  const visibleW = visibleH * aspect;

  let radius = BASE_RADIUS;
  if (visibleW < FIELD_WIDTH) {
    radius = (FIELD_WIDTH / 2) / (Math.tan(fovV / 2) * aspect);
  }
  if (visibleH < FIELD_HEIGHT) {
    const radiusForHeight = (FIELD_HEIGHT / 2) / Math.tan(fovV / 2);
    radius = Math.max(radius, radiusForHeight);
  }

  camera.radius = radius;
}

function setupSkyGradient() {
  if (skyMesh) {
    skyMesh.dispose(false, true);
  }

  const glbBg = scene.getMeshByName("bg");
  if (glbBg) glbBg.setEnabled(false);

  BABYLON.Effect.ShadersStore["skyGradientVertexShader"] = vertexShader;
  BABYLON.Effect.ShadersStore["skyGradientFragmentShader"] = fragmentShader;

  const mat = new ShaderMaterial("skyGradientMat", scene, {
    vertex: "skyGradient",
    fragment: "skyGradient",
  }, {
    attributes: ["position", "uv"],
    uniforms: ["worldViewProjection", "topColor", "midColor", "horizonColor", "midPoint", "exponent"],
  });

  mat.setColor3("topColor", new Color3(0.25, 0.47, 0.75));
  mat.setColor3("midColor", new Color3(0.55, 0.72, 0.88));
  mat.setColor3("horizonColor", new Color3(0.78, 0.85, 0.92));
  mat.setFloat("midPoint", 0.3);
  mat.setFloat("exponent", 0.8);
  mat.backFaceCulling = false;

  skyMesh = MeshBuilder.CreatePlane("skyPlane", { width: 500, height: 300 }, scene);
  skyMesh.material = mat;
  skyMesh.position.set(0, 80, -315);
  skyMesh.isPickable = false;
  skyMesh.receiveShadows = false;
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

function shouldReceiveShadows(mesh) {
  const name = mesh.name.toLowerCase();
  return name.includes("ground") || name.includes("plane");
}

function setupShadows() {
  activeShadowGenerators = [];

  if (!CONFIG.shadowsEnabled) return;

  const casterMeshes = [];
  for (const mesh of scene.meshes) {
    if (!mesh.getTotalVertices || mesh.getTotalVertices() === 0) continue;
    if (!mesh.isEnabled()) continue;
    if (mesh === skyMesh) {
      mesh.receiveShadows = false;
      continue;
    }

    const role = childRole(mesh.name);
    if (role === "Col") {
      mesh.receiveShadows = false;
      continue;
    }

    mesh.receiveShadows = shouldReceiveShadows(mesh);

    if (role === "Vis" || role === "ColVis" || !role) {
      casterMeshes.push(mesh);
    }
  }

  let dirLight = scene.lights.find(l => l.getClassName() === "DirectionalLight");
  if (!dirLight) {
    dirLight = new DirectionalLight("ShadowLight", new Vector3(-0.3, -1, -0.2), scene);
    dirLight.intensity = 0.3;
  }

  dirLight.intensity *= CONFIG.shadowLightIntensityScale ?? 1;

  const sceneCenter = new Vector3(0, FIELD_CENTER_Y, 0);
  const dir = dirLight.direction.normalizeToNew();
  dirLight.position = sceneCenter.subtract(dir.scale(200));

  dirLight.shadowMinZ = 1;
  dirLight.shadowMaxZ = 500;
  dirLight.shadowFrustumSize = 300;

  const dirSg = new ShadowGenerator(CONFIG.shadowMapSize ?? 2048, dirLight);
  dirSg.usePercentageCloserFiltering = true;
  dirSg.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
  dirSg.forceBackFacesOnly = true;
  dirSg.bias = CONFIG.shadowBias ?? 0.0005;
  dirSg.normalBias = CONFIG.shadowNormalBias ?? 0.02;

  for (const mesh of casterMeshes) dirSg.addShadowCaster(mesh, true);
  activeShadowGenerators.push(dirSg);

  const pointLights = scene.lights.filter(l => l.getClassName() === "PointLight");
  const pointMapSize = CONFIG.pointShadowMapSize ?? 1024;

  for (const pl of pointLights) {
    pl.shadowMinZ = 0.5;
    pl.shadowMaxZ = 150;

    const sg = new ShadowGenerator(pointMapSize, pl);
    sg.usePercentageCloserFiltering = true;
    sg.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    sg.forceBackFacesOnly = true;
    sg.bias = CONFIG.shadowBias ?? 0.0005;
    sg.normalBias = CONFIG.shadowNormalBias ?? 0.02;

    for (const mesh of casterMeshes) sg.addShadowCaster(mesh, true);
    activeShadowGenerators.push(sg);
  }
}

function templatePathFromId(objectId) {
  const lastUnderscore = objectId.lastIndexOf("_");
  if (lastUnderscore < 0) return objectId;
  return objectId.substring(0, lastUnderscore);
}

function registerCloneShadows(clone) {
  if (activeShadowGenerators.length === 0) return;
  const descendants = descendantsOf(clone);
  for (const node of descendants) {
    if (!node.getTotalVertices || node.getTotalVertices() === 0) continue;
    const role = childRole(node.name);
    if (role === "Col") {
      if (node.setEnabled) node.setEnabled(false);
    } else {
      for (const sg of activeShadowGenerators) sg.addShadowCaster(node, true);
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
  clone.rotationQuaternion = null;
  clone.rotation.set(0, Math.PI, 0);
  clone.setEnabled(true);
  if (clone.material) clone.material.backFaceCulling = false;
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

  const shrinkMs = (getServerConfig("fragmentShrinkMs") ?? 500);
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

export function removeStaleVisuals(objects) {
  const currentIds = new Set(objects.map((o) => o.id));

  for (const [id, visual] of visualObjects) {
    if (currentIds.has(id)) continue;
    if (fragmentVisuals.has(id)) continue;

    visual.dispose(false, false);
    visualObjects.delete(id);
    visualBaseRotations.delete(id);
    latestObjectStates.delete(id);
    trebuchetArmNodes.delete(id);
    trebuchetLoadTargets.delete(id);

    const crack = crackStageVisuals.get(id);
    if (crack) {
      crack.dispose(false, false);
      crackStageVisuals.delete(id);
    }
  }
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
    visualObjects.delete(visual.name);
    visualBaseRotations.delete(visual.name);
  }
  fragmentVisuals.clear();

  for (const visual of visualObjects.values()) {
    if (visual.setEnabled) visual.setEnabled(true);
    const descendants = descendantsOf(visual);
    for (const node of descendants) {
      const role = childRole(node.name);
      if (role === "Vis" || role === "ColVis") {
        if (node.setEnabled) node.setEnabled(true);
      }
      if (/hit\d+-Visual/.test(node.name) && node.setEnabled) {
        node.setEnabled(false);
      }
    }
  }
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
  if (shotArcRenderer) {
    shotArcRenderer.dispose();
    shotArcRenderer = null;
  }

  for (const generator of scene.shadowGenerators?.slice() ?? []) {
    generator.dispose();
  }
  activeShadowGenerators = [];

  for (const light of [...scene.lights]) light.dispose();

  if (skyMesh) {
    skyMesh.dispose(false, true);
    skyMesh = null;
  }

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

  setupCameraAndLight();
  setupSkyGradient();
  setupShadows();
  shotArcRenderer = createShotArcRenderer(scene, CONFIG);
  engine.resize();
}

export async function reloadLevel(url) {
  engine.stopRenderLoop();
  clearLevel();
  await loadLevel(url);
  engine.runRenderLoop(() => scene.render());
}
