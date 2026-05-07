import { createMusicController } from "./music.js";
import { BARRAGE_CONFIG } from "./config.js";

const {
  ArcRotateCamera,
  Color3,
  Engine,
  HemisphericLight,
  MeshBuilder,
  Scene,
  SceneLoader,
  ShadowGenerator,
  StandardMaterial,
  Vector3,
} = BABYLON;

const CONFIG = BARRAGE_CONFIG;
const LEVEL_URL = CONFIG.levelUrl ?? "/assets/level1.glb";
const canvas = document.getElementById("game");
const hudEl = document.getElementById("hud");
const connectionEl = document.getElementById("connection");
const playerEl = document.getElementById("player");
const musicToggleEl = document.getElementById("music-toggle");
const resetEl = document.getElementById("reset");
const restartServerEl = document.getElementById("restart-server");
const lobbyEl = document.getElementById("lobby");
const lobbyStatusEl = document.getElementById("lobby-status");
const lobbyPanelEl = document.querySelector(".lobby-panel");
const roundCounterEl = document.getElementById("round-counter");
const crownsLeftEl = document.getElementById("crowns-left");
const crownsRightEl = document.getElementById("crowns-right");
const hudOpponentEl = document.getElementById("hud-opponent");
const opponentPlayerEl = document.getElementById("opponent-player");

const engine = new Engine(canvas, true);
const scene = new Scene(engine);
scene.clearColor.set(0.62, 0.72, 0.78, 1);
scene.imageProcessingConfiguration.exposure = CONFIG.exposure ?? 1.0;
scene.imageProcessingConfiguration.contrast = CONFIG.contrast ?? 1.0;

const visualObjects = new Map();
const visualBaseRotations = new Map();
const latestObjectStates = new Map();
const trebuchetArmNodes = new Map();
const trebuchetLoadTargets = new Map();
let seq = 0;
let selectedEntityId = null;
let pointerMode = "drag";
let shadowGenerator = null;
let dragDepth = 0;
let latestDragPoint = null;
let releaseSamples = [];
let releaseSampleTimer = null;
let releaseVelocity = { x: 0, y: 0, z: 0 };
let aimWorldPoint = null;
let aimArrowShaft = null;
let aimArrowHeadLeft = null;
let aimArrowHeadRight = null;
let aimArrowMaterial = null;
let currentRoomId = null;
let currentLevelUrl = LEVEL_URL;
let loadedLevelUrl = null;
let levelSwitchPromise = Promise.resolve();
let isMatched = false;
let myPlayerId = null;
const fragmentTemplateNodes = { L: [], R: [] };
const hitVisualTemplates = { L: {}, R: {} };
let displayedRound = 0;
let displayedScores = {};
const musicController = createMusicController(musicToggleEl, {
  onStatus: setStatus,
});

function setStatus(text) {
  connectionEl.textContent = text;
}

function setLobbyStatus(text, visible = true, winnerPlayerId = null) {
  lobbyStatusEl.textContent = text;
  lobbyEl.classList.toggle("is-visible", visible);
  lobbyPanelEl.classList.remove("winner-odd", "winner-even");
  if (winnerPlayerId) {
    const num = parseInt(winnerPlayerId.split("_")[1], 10);
    if (Number.isFinite(num)) {
      lobbyPanelEl.classList.add(num % 2 === 1 ? "winner-odd" : "winner-even");
    }
  }
}

function updateRoundCounter(roundNumber) {
  if (roundNumber === displayedRound) return;
  displayedRound = roundNumber;
  roundCounterEl.textContent = `Round ${roundNumber}`;
  roundCounterEl.classList.add("is-visible");
}

function updateCrowns(scores) {
  if (JSON.stringify(scores) === JSON.stringify(displayedScores)) return;
  displayedScores = scores;
  let leftCount = 0;
  let rightCount = 0;
  for (const [playerId, wins] of Object.entries(scores)) {
    const num = parseInt(playerId.split("_")[1], 10);
    if (!Number.isFinite(num)) continue;
    if (num % 2 === 1) leftCount += wins;
    else rightCount += wins;
  }
  crownsLeftEl.textContent = "👑".repeat(leftCount);
  crownsRightEl.textContent = "👑".repeat(rightCount);
}

async function loadFragmentTemplates() {
  for (const side of ["L", "R"]) {
    for (const node of fragmentTemplateNodes[side]) {
      if (!node.isDisposed()) node.dispose();
    }
    fragmentTemplateNodes[side] = [];
  }

  for (const [side, file] of [["L", "/assets/fragmented_blockL.glb"], ["R", "/assets/fragmented_blockR.glb"]]) {
    try {
      const existingIds = new Set(scene.meshes.map((m) => m.uniqueId));
      await SceneLoader.AppendAsync("", file, scene);
      const newMeshes = scene.meshes.filter((m) => !existingIds.has(m.uniqueId) && m.name !== "__root__");

      fragmentTemplateNodes[side] = [];
      hitVisualTemplates[side] = {};

      for (const mesh of newMeshes) {
        mesh.setEnabled(false);
        const role = childRole(mesh.name);
        if (role === "Vis") {
          const hitMatch = mesh.name.match(/hit(\d+)/i);
          if (hitMatch) {
            const n = parseInt(hitMatch[1], 10);
            // Disable back-face culling to handle mirrored/flipped Blender exports
            if (mesh.material) mesh.material.backFaceCulling = false;
            hitVisualTemplates[side][n] = mesh;
            console.log(`[frag ${side}] hit visual ${n} stored, scale=(${mesh.scaling.x.toFixed(2)},${mesh.scaling.y.toFixed(2)},${mesh.scaling.z.toFixed(2)})`);
          }
        } else {
          fragmentTemplateNodes[side].push(mesh);
        }
      }
      console.log(`[frag ${side}] fragments=${fragmentTemplateNodes[side].length} hitVisuals=`, Object.keys(hitVisualTemplates[side]));
    } catch (err) {
      console.warn(`Could not load fragment templates for ${side}:`, err);
    }
  }
}

function switchLevelIfNeeded(levelUrl) {
  if (!levelUrl || levelUrl === loadedLevelUrl) return levelSwitchPromise;
  if (!loadedLevelUrl && levelUrl === currentLevelUrl) return levelSwitchPromise;

  currentLevelUrl = levelUrl;
  levelSwitchPromise = levelSwitchPromise.then(() => loadLevel(levelUrl, { replace: Boolean(loadedLevelUrl) }));
  return levelSwitchPromise;
}

function isMissileInFlight(object) {
  const lowerName = object.id?.toLowerCase() ?? "";
  if (!lowerName.includes("missile")) return false;
  if (object.loadedInto) return false;

  const speed = Math.hypot(object.vx || 0, object.vy || 0, object.vz || 0);
  const minSpeed = CONFIG.musicKickVoiceFlightVelocityMin ?? 10;
  return speed >= minSpeed;
}

function updateMusicFromState(message) {
  const kickVoiceGain = (message.objects || []).some(isMissileInFlight) ? 1 : 0;
  musicController.setKickVoiceGain(kickVoiceGain);
}

function protocolToBabylonRotation(rotDegrees) {
  return -(rotDegrees * Math.PI) / 180;
}

function degreesToRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function childRole(name) {
  if (name.includes("ColVis")) return "ColVis";
  if (name.includes("Visual") || name.includes("Vis")) return "Vis";
  if (name.includes("Collider") || name.includes("Col")) return "Col";
  return null;
}

function registerVisualRoots() {
  visualObjects.clear();
  visualBaseRotations.clear();

  const candidateRoots = [
    ...scene.transformNodes.filter((transform) => !transform.parent || transform.parent.name === "__root__"),
    ...scene.meshes.filter((mesh) => !mesh.parent || mesh.parent.name === "__root__"),
  ];
  const seenRootNames = new Set();

  for (const transform of candidateRoots) {
    if (transform.name === "__root__") continue;
    if (seenRootNames.has(transform.name)) continue;
    seenRootNames.add(transform.name);

    const descendants = descendantsOf(transform);
    const selfRole = childRole(transform.name);
    const visualChild = descendants.find((child) => {
      const role = childRole(child.name);
      return role === "Vis" || role === "ColVis";
    });
    const hasVisualRole = selfRole === "Vis" || selfRole === "ColVis" || Boolean(visualChild);

    if (!hasVisualRole) continue;

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

function registerTrebuchetArmNodes() {
  trebuchetArmNodes.clear();

  for (const transform of scene.transformNodes) {
    if (!isTrebuchetArmRoot(transform)) continue;

    const root = findGameplayRoot(transform);
    if (!root) continue;

    trebuchetArmNodes.set(root.name, transform);
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

function descendantsOf(transform) {
  const descendants = [];
  const stack = [...transform.getChildren()];

  while (stack.length > 0) {
    const child = stack.pop();
    descendants.push(child);

    if (typeof child.getChildren === "function") {
      stack.push(...child.getChildren());
    }
  }

  return descendants;
}

function isMissileName(name) {
  return name.toLowerCase().includes("missile");
}

function isDraggableRoot(root) {
  const name = root.name.toLowerCase();
  return name.includes("block")
    || name.includes("trebuche")
    || name.includes("missile")
    || name.includes("king");
}

function isTrebuchetArmName(name) {
  const lowerName = name.toLowerCase();
  return lowerName.includes("trebuche") && lowerName.includes("arm");
}

function isTrebuchetName(name) {
  return name.toLowerCase().includes("trebuche");
}

function colliderNodesFor(root) {
  const selfRole = childRole(root.name);
  const descendants = descendantsOf(root);
  const nodes = descendants.filter((child) => {
    const role = childRole(child.name);
    return role === "Col" || role === "ColVis";
  });

  if (selfRole === "Col" || selfRole === "ColVis") {
    nodes.push(root);
  }

  return nodes.length > 0 ? nodes : [root];
}

function boundsForNodes(nodes) {
  const bounds = nodes.reduce((accumulator, node) => {
    if (typeof node.getHierarchyBoundingVectors !== "function") return accumulator;

    const nodeBounds = node.getHierarchyBoundingVectors(true);
    return {
      minX: Math.min(accumulator.minX, nodeBounds.min.x),
      minY: Math.min(accumulator.minY, nodeBounds.min.y),
      minZ: Math.min(accumulator.minZ, nodeBounds.min.z),
      maxX: Math.max(accumulator.maxX, nodeBounds.max.x),
      maxY: Math.max(accumulator.maxY, nodeBounds.max.y),
      maxZ: Math.max(accumulator.maxZ, nodeBounds.max.z),
    };
  }, {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
  });

  if (!Number.isFinite(bounds.minX)) return null;
  return bounds;
}

function maxWorldScale(node) {
  const matrix = node.getWorldMatrix().m;
  return Math.max(
    Math.hypot(matrix[0], matrix[1], matrix[2]),
    Math.hypot(matrix[4], matrix[5], matrix[6]),
    Math.hypot(matrix[8], matrix[9], matrix[10]),
    0.0001,
  );
}

function createMissilePickColliders() {
  const scale = CONFIG.missilePickColliderScale ?? 1;
  if (scale <= 1) return;

  const material = new StandardMaterial("MissilePickColliderMat", scene);
  material.alpha = 0;

  for (const root of visualObjects.values()) {
    if (!isMissileName(root.name)) continue;

    const bounds = boundsForNodes(colliderNodesFor(root));
    if (!bounds) continue;

    const center = new Vector3(
      (bounds.minX + bounds.maxX) / 2,
      (bounds.minY + bounds.maxY) / 2,
      (bounds.minZ + bounds.maxZ) / 2,
    );
    const worldToRoot = root.getWorldMatrix().clone().invert();
    const worldDiameter = Math.max(
      bounds.maxX - bounds.minX,
      bounds.maxY - bounds.minY,
      bounds.maxZ - bounds.minZ,
      0.1,
    ) * scale;
    const pickCollider = MeshBuilder.CreateSphere(`${root.name}-PickCollider`, {
      diameter: worldDiameter / maxWorldScale(root),
      segments: 16,
    }, scene);

    pickCollider.parent = root;
    pickCollider.position = Vector3.TransformCoordinates(center, worldToRoot);
    pickCollider.material = material;
    pickCollider.visibility = 0;
    pickCollider.isPickable = true;
    pickCollider.receiveShadows = false;
  }
}

function isTrebuchetArmRoot(transform) {
  const lowerName = transform.name.toLowerCase();
  return isTrebuchetArmName(transform.name)
    && transform.parent
    && transform.parent.name.toLowerCase().includes("trebuche")
    && !lowerName.includes("visual")
    && !lowerName.includes("collider")
    && !lowerName.includes("col")
    && descendantsOf(transform).some((child) => child.name.toLowerCase().includes("missile-load-target"));
}

function isLeftSideTrebuchetName(name) {
  const lowerName = name.toLowerCase();
  return lowerName.includes("p1") || lowerName.includes("left") || lowerName.includes("1");
}

function findTrebuchetArmAncestor(node) {
  let current = node;

  while (current) {
    if (isTrebuchetArmRoot(current)) {
      return current;
    }

    current = current.parent;
  }

  return null;
}

function isForwardPullPoint(trebuchetId, point, releasePoint) {
  if (isLeftSideTrebuchetName(trebuchetId)) {
    return point.x > releasePoint.x;
  }

  return point.x < releasePoint.x;
}

function clampAimTailPoint(headPoint, tailPoint) {
  const backVector = tailPoint.subtract(headPoint);
  const arrowLength = backVector.length();
  const maxArrowLength = CONFIG.aimArrowMaxLength ?? CONFIG.aimMaxPullDistance ?? 6;

  if (arrowLength <= maxArrowLength || arrowLength <= 0.0001) {
    return tailPoint;
  }

  return headPoint.add(backVector.scale(maxArrowLength / arrowLength));
}

function findGameplayRoot(node) {
  let current = node;

  while (current) {
    if (visualObjects.has(current.name)) {
      return current;
    }

    current = current.parent;
  }

  return null;
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

  shadowGenerator = new ShadowGenerator(CONFIG.shadowMapSize ?? 2048, light);
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

function createAimArrowMeshes() {
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

function hideAimArrow() {
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

function updateAimArrow() {
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

  if (!isForwardPullPoint(trebuchetId, aimWorldPoint, headPoint)) {
    hideAimArrow();
    return;
  }

  const tailPoint = clampAimTailPoint(headPoint, aimWorldPoint.clone());
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

function disposeLevelScene() {
  hideAimArrow();
  aimArrowShaft?.dispose();
  aimArrowHeadLeft?.dispose();
  aimArrowHeadRight?.dispose();
  aimArrowShaft = null;
  aimArrowHeadLeft = null;
  aimArrowHeadRight = null;
  aimArrowMaterial = null;

  shadowGenerator?.dispose();
  shadowGenerator = null;

  for (const mesh of [...scene.meshes]) {
    mesh.dispose(false, true);
  }
  for (const transform of [...scene.transformNodes]) {
    transform.dispose(false, true);
  }
  for (const camera of [...scene.cameras]) {
    camera.dispose();
  }
  for (const light of [...scene.lights]) {
    light.dispose();
  }

  visualObjects.clear();
  visualBaseRotations.clear();
  latestObjectStates.clear();
  trebuchetArmNodes.clear();
  trebuchetLoadTargets.clear();
  scene.activeCamera = null;
}

async function loadLevel(levelUrl = LEVEL_URL, { replace = false } = {}) {
  if (replace) {
    disposeLevelScene();
  }

  try {
    await SceneLoader.AppendAsync("", levelUrl, scene);
    applyTrebuchetArmRestPose();
    registerVisualRoots();
    createMissilePickColliders();
    registerTrebuchetArmNodes();
    registerTrebuchetLoadTargets();
    createAimArrowMeshes();
    await loadFragmentTemplates();

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
  loadedLevelUrl = levelUrl;
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

function applyState(message) {
  for (const object of message.objects || []) {
    latestObjectStates.set(object.id, object);

    const visual = visualObjects.get(object.id);
    if (!visual) continue;

    visual.position.x = object.x;
    visual.position.y = object.y ?? visual.position.y;
    visual.position.z = object.z;
    visual.rotationQuaternion = null;
    const baseRotation = visualBaseRotations.get(object.id);
    if (baseRotation) {
      visual.rotation.x = baseRotation.x;
      visual.rotation.y = baseRotation.y;
      visual.rotation.z = baseRotation.z + protocolToBabylonRotation(object.rot || 0);
    } else {
      visual.rotation.z = protocolToBabylonRotation(object.rot || 0);
    }

    const arm = trebuchetArmNodes.get(object.id);
    if (arm && typeof object.armAngle === "number") {
      arm.rotationQuaternion = null;
      arm.rotation.z = degreesToRadians(object.armAngle);
      arm.computeWorldMatrix(true);
    }
  }

  if (pointerMode === "aim" && selectedEntityId) {
    updateAimArrow();
  }
}

const socketProtocol = window.location.protocol === "https:" ? "wss" : "ws";
const socket = new WebSocket(`${socketProtocol}://${window.location.host}`);

socket.addEventListener("open", () => {
  setStatus("Connected");
});

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);

  if (message.type === "welcome") {
    myPlayerId = message.playerId;
    playerEl.textContent = message.playerId;
    const playerNum = parseInt(message.playerId?.split("_")[1], 10);
    if (Number.isFinite(playerNum)) {
      hudEl.classList.remove("player-odd", "player-even");
      hudEl.classList.add(playerNum % 2 === 1 ? "player-odd" : "player-even");
    }
  }

  if (message.type === "lobby") {
    currentRoomId = message.roomId;
    currentLevelUrl = message.level ?? currentLevelUrl;
    isMatched = false;
    setLobbyStatus(message.status === "spectating"
      ? `${message.playerId} waiting for a player slot...`
      : `${message.playerId} waiting for opponent...`);
    if (message.status === "spectating") {
      switchLevelIfNeeded(currentLevelUrl);
    }
  }

  if (message.type === "matched") {
    currentRoomId = message.roomId;
    currentLevelUrl = message.level ?? currentLevelUrl;
    isMatched = false;
    playerEl.textContent = message.playerId;
    if (message.opponentId) {
      const oppNum = parseInt(message.opponentId.split("_")[1], 10);
      opponentPlayerEl.textContent = message.opponentId;
      hudOpponentEl.classList.remove("player-odd", "player-even");
      if (Number.isFinite(oppNum)) {
        hudOpponentEl.classList.add(oppNum % 2 === 1 ? "player-odd" : "player-even");
      }
      hudOpponentEl.style.display = "block";
    }
    updateRoundCounter(message.roundNumber);
    updateCrowns(message.scores ?? {});
    setLobbyStatus("Loading match...");
    switchLevelIfNeeded(currentLevelUrl).then(() => {
      isMatched = true;
      setLobbyStatus("", false);
    });
  }

  if (message.type === "roundEnded") {
    isMatched = false;
    updateCrowns(message.scores ?? {});
    setLobbyStatus(`${message.winner} won round ${message.roundNumber}`, true, message.winner);
  }

  if (message.type === "levelChanged") {
    if (message.roomId && currentRoomId && message.roomId !== currentRoomId) return;
    currentLevelUrl = message.level ?? currentLevelUrl;
    isMatched = false;
    updateRoundCounter(message.roundNumber);
    updateCrowns(message.scores ?? {});
    setLobbyStatus("Loading next level...");
    switchLevelIfNeeded(currentLevelUrl).then(() => {
      isMatched = true;
      setLobbyStatus("", false);
    });
  }

  if (message.type === "event") {
    for (const ev of message.events ?? []) {
      if (ev.kind === "blockHit") {
        const side = ev.blockId.toLowerCase().includes("blockl") ? "L" : "R";
        const template = hitVisualTemplates[side][ev.hits];
        if (template) {
          const originalBase = visualBaseRotations.get(ev.blockId) ?? { x: 0, y: 0, z: 0 };
          const current = visualObjects.get(ev.blockId);
          if (current) current.setEnabled(false);
          const clone = template.clone(`${ev.blockId}-hit${ev.hits}`, null, true);
          if (clone) {
            clone.setEnabled(true);
            visualObjects.set(ev.blockId, clone);
            visualBaseRotations.set(ev.blockId, originalBase);
            const state = latestObjectStates.get(ev.blockId);
            if (state) {
              clone.position.set(state.x, state.y ?? clone.position.y, state.z);
              clone.rotationQuaternion = null;
              clone.rotation.x = originalBase.x;
              clone.rotation.y = originalBase.y;
              clone.rotation.z = originalBase.z + protocolToBabylonRotation(state.rot || 0);
            }
          }
        }
      }

      if (ev.kind === "blockBroken") {
        const blockVisual = visualObjects.get(ev.blockId);
        if (blockVisual) blockVisual.setEnabled(false);

        const side = ev.blockId.toLowerCase().includes("blockl") ? "L" : "R";
        const templates = fragmentTemplateNodes[side];

        for (let i = 0; i < ev.fragIds.length; i++) {
          const template = templates[i];
          if (!template) continue;
          const clone = template.clone(ev.fragIds[i], null, true);
          if (!clone) continue;
          clone.setEnabled(true);
          visualObjects.set(ev.fragIds[i], clone);
          visualBaseRotations.set(ev.fragIds[i], { x: 0, y: 0, z: 0 });
        }
      }
    }
  }

  if (message.type === "state") {
    if (message.roomId && currentRoomId && message.roomId !== currentRoomId) return;
    updateRoundCounter(message.roundNumber);
    updateCrowns(message.scores ?? {});
    applyState(message);
    updateMusicFromState(message);
  }
});

socket.addEventListener("close", () => {
  setStatus("Disconnected");
  isMatched = false;
  hudOpponentEl.style.display = "none";
  setLobbyStatus("Disconnected");
});

function sendInput(action, payload) {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (!isMatched) return;

  socket.send(JSON.stringify({
    type: "input",
    seq: ++seq,
    action,
    ...payload,
  }));
}

resetEl.addEventListener("click", () => {
  sendInput("reset", {});
});

musicToggleEl.addEventListener("click", async () => {
  try {
    await musicController.toggle();
  } catch (error) {
    console.error("Failed to toggle music.", error);
    setStatus("Music failed");
  }
});

restartServerEl.addEventListener("click", async () => {
  restartServerEl.disabled = true;
  setStatus("Restarting server...");

  try {
    const response = await fetch("/admin/restart", {
      method: "POST",
    });

    if (!response.ok) {
      throw new Error(`Restart failed: ${response.status}`);
    }

    window.setTimeout(() => {
      window.location.reload();
    }, 1500);
  } catch (error) {
    console.error("Failed to restart server.", error);
    setStatus("Restart failed");
    restartServerEl.disabled = false;
  }
});

function pickPoint() {
  const pick = scene.pick(scene.pointerX, scene.pointerY);
  if (!pick?.pickedPoint) return null;

  return protocolPointFromWorld(pick.pickedPoint);
}

function shouldInvertXForEntity(entityId) {
  if (entityId.toLowerCase().includes("trebuche")) {
    return CONFIG.trebuchetInputInvertX;
  }

  return CONFIG.inputInvertX;
}

function protocolPointFromWorld(world, entityId = "") {
  return {
    x: (shouldInvertXForEntity(entityId) ? -1 : 1) * world.x,
    y: (CONFIG.inputInvertY ? -1 : 1) * world.y,
    z: (CONFIG.inputInvertZ ? -1 : 1) * world.z,
  };
}

function clampMagnitude(vector, maxMagnitude) {
  const magnitude = Math.hypot(vector.x, vector.y, vector.z);
  if (magnitude <= maxMagnitude || magnitude === 0) return vector;

  const scale = maxMagnitude / magnitude;
  return {
    x: vector.x * scale,
    y: vector.y * scale,
    z: vector.z * scale,
  };
}

function sampleReleasePoint() {
  if (!latestDragPoint) return;

  releaseSamples.push({
    time: performance.now(),
    point: latestDragPoint,
  });

  const maxSamples = Math.max(2, (CONFIG.releaseVelocityFrameWindow ?? 5) + 1);
  while (releaseSamples.length > maxSamples) {
    releaseSamples.shift();
  }
}

function startReleaseVelocitySampling(point) {
  latestDragPoint = point;
  releaseSamples = [];
  sampleReleasePoint();

  const sampleHz = CONFIG.releaseVelocitySampleHz ?? 60;
  releaseSampleTimer = window.setInterval(sampleReleasePoint, 1000 / sampleHz);
}

function stopReleaseVelocitySampling() {
  if (releaseSampleTimer) {
    window.clearInterval(releaseSampleTimer);
  }

  releaseSampleTimer = null;
}

function updateReleasePoint(point) {
  latestDragPoint = point;
}

function averageReleaseVelocity() {
  sampleReleasePoint();

  if (releaseSamples.length < 2) {
    return { x: 0, y: 0, z: 0 };
  }

  const frameWindow = CONFIG.releaseVelocityFrameWindow ?? 5;
  const samples = releaseSamples.slice(-Math.max(2, frameWindow + 1));
  const first = samples[0];
  const last = samples.at(-1);
  const dt = Math.max(0.001, (last.time - first.time) / 1000);
  const scale = CONFIG.releaseVelocityScale ?? 1.0;

  return clampMagnitude({
    x: ((last.point.x - first.point.x) / dt) * scale,
    y: ((last.point.y - first.point.y) / dt) * scale,
    z: ((last.point.z - first.point.z) / dt) * scale,
  }, CONFIG.normalReleaseVelocityMax ?? CONFIG.releaseVelocityMax ?? 8);
}

function pickDraggableRoot() {
  const pick = scene.pick(scene.pointerX, scene.pointerY, (mesh) => {
    const root = findGameplayRoot(mesh);
    return root && isDraggableRoot(root);
  });

  if (!pick?.hit || !pick.pickedMesh) return null;

  const root = findGameplayRoot(pick.pickedMesh);
  if (!root || !isDraggableRoot(root)) return null;

  return root;
}

function pointerWorldAtDragDepth() {
  const ray = scene.createPickingRay(scene.pointerX, scene.pointerY, BABYLON.Matrix.Identity(), scene.activeCamera);
  if (Math.abs(ray.direction.z) < 0.0001) return null;

  const distance = (dragDepth - ray.origin.z) / ray.direction.z;
  if (distance < 0) return null;

  return ray.origin.add(ray.direction.scale(distance));
}

function beginDrag() {
  if (!isMatched) return;

  const root = pickDraggableRoot();
  if (!root) return;

  selectedEntityId = root.name;
  pointerMode = "drag";
  dragDepth = root.getAbsolutePosition().z;

  const world = pointerWorldAtDragDepth() ?? root.getAbsolutePosition();
  const point = protocolPointFromWorld(world, selectedEntityId);

  const objectState = latestObjectStates.get(selectedEntityId);
  if (objectState?.loadedInto) {
    pointerMode = "aim";
    aimWorldPoint = world.clone();
    updateAimArrow();
    sendInput("aimStart", {
      entityId: selectedEntityId,
      trebuchetId: objectState.loadedInto,
      point,
    });
    return;
  }

  startReleaseVelocitySampling(point);
  releaseVelocity = { x: 0, y: 0, z: 0 };
  sendInput("dragStart", {
    entityId: selectedEntityId,
    point,
  });
}

function moveDrag() {
  if (!selectedEntityId) return;

  const world = pointerWorldAtDragDepth();
  if (!world) return;

  if (pointerMode === "aim") {
    aimWorldPoint = world.clone();
    updateAimArrow();
    const point = protocolPointFromWorld(world, selectedEntityId);
    sendInput("aimMove", {
      entityId: selectedEntityId,
      point,
    });
    return;
  }

  const point = protocolPointFromWorld(new Vector3(
    world.x,
    Math.max(world.y + (CONFIG.dragHeightOffset ?? 0.2), 0.2),
    world.z,
  ), selectedEntityId);
  updateReleasePoint(point);

  sendInput("dragMove", {
    entityId: selectedEntityId,
    point,
  });
}

function endDrag() {
  if (!selectedEntityId) return;

  const world = pointerWorldAtDragDepth();
  const visual = visualObjects.get(selectedEntityId);
  const fallback = visual?.getAbsolutePosition() ?? Vector3.Zero();
  const point = world ?? fallback;

  if (pointerMode === "aim") {
    aimWorldPoint = point.clone();
    updateAimArrow();
    const finalPoint = protocolPointFromWorld(point, selectedEntityId);
    sendInput("aimRelease", {
      entityId: selectedEntityId,
      point: finalPoint,
    });

    selectedEntityId = null;
    pointerMode = "drag";
    aimWorldPoint = null;
    hideAimArrow();
    return;
  }

  const finalPoint = protocolPointFromWorld(new Vector3(
      point.x,
      Math.max(point.y + (CONFIG.dragHeightOffset ?? 0.2), 0.2),
      point.z,
    ), selectedEntityId);
  updateReleasePoint(finalPoint);
  releaseVelocity = averageReleaseVelocity();
  stopReleaseVelocitySampling();

  sendInput("dragEnd", {
    entityId: selectedEntityId,
    point: finalPoint,
    velocity: releaseVelocity,
    rot: 0,
  });

  selectedEntityId = null;
  pointerMode = "drag";
  latestDragPoint = null;
  releaseSamples = [];
  releaseVelocity = { x: 0, y: 0, z: 0 };
  aimWorldPoint = null;
  hideAimArrow();

  if (CONFIG.cameraControlsEnabled) {
    scene.activeCamera.attachControl(canvas, true);
  }
}

scene.onPointerObservable.add((pointerInfo) => {
  if (pointerInfo.type === BABYLON.PointerEventTypes.POINTERDOWN) {
    beginDrag();
  }

  if (pointerInfo.type === BABYLON.PointerEventTypes.POINTERMOVE && selectedEntityId) {
    moveDrag();
  }

  if (pointerInfo.type === BABYLON.PointerEventTypes.POINTERUP && selectedEntityId) {
    endDrag();
  }
});

levelSwitchPromise = loadLevel(currentLevelUrl).then(() => {
  engine.runRenderLoop(() => {
    if (scene.activeCamera) {
      scene.render();
    }
  });
});

window.addEventListener("resize", () => {
  engine.resize();
});

window.addEventListener("blur", () => {
  stopReleaseVelocitySampling();
});
