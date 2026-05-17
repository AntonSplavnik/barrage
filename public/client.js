import { createMusicController } from "./music.js";

const isMobile = window.matchMedia?.("(pointer: coarse)").matches ?? false;
import { createSoundEffectsController } from "./sound_manager.js";
import { createCameraController } from "./camera_control.js";
import { applyRenderResolutionLimit } from "./render-effects.js";
import { createVfxManager } from "./vfx-manager.js";
import { createTrebuchetShotArcPrediction } from "./trebuche-shot-arc-prediction.js";
import {
  appendLevelGlb,
  loadFragmentTemplatesFromGlb,
  registerTrebuchetArmNodesFromGlb,
  registerTrebuchetLoadTargetsFromGlb,
  registerVisualRootsFromGlb,
} from "./client-glb-parser.js";
import { BARRAGE_CONFIG } from "./config.js";
import { createInterpolator } from "./interpolation.js";

const {
  Color3,
  Engine,
  FreeCamera,
  HemisphericLight,
  MeshBuilder,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  Vector3,
} = BABYLON;

const CONFIG = BARRAGE_CONFIG;
const LEVEL_URL = CONFIG.levelUrl ?? "/assets/level1.glb";
const canvas = document.getElementById("game");
const hudEl = document.getElementById("hud");
const mediaControlsEl = document.getElementById("media-controls");
const connectionEl = document.getElementById("connection");
const playerEl = document.getElementById("player");
const musicToggleEl = document.getElementById("music-toggle");
const sfxToggleEl = document.getElementById("sfx-toggle");
const resetEl = document.getElementById("reset");
const restartServerEl = document.getElementById("restart-server");
const lobbyEl = document.getElementById("lobby");
const lobbyStatusEl = document.getElementById("lobby-status");
const lobbyPanelEl = document.querySelector(".lobby-panel");
const lobbyTitleEl = document.getElementById("lobby-title");
const roundCounterEl = document.getElementById("round-counter");

lobbyStatusEl.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-copy-url]");
  if (!btn) return;
  const url = btn.dataset.copyUrl;
  navigator.clipboard.writeText(url).then(() => {
    const prev = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = prev; }, 1500);
  });
});
const crownsLeftEl = document.getElementById("crowns-left");
const crownsRightEl = document.getElementById("crowns-right");
const portraitLeftEl = document.getElementById("player-portrait-left");
const portraitRightEl = document.getElementById("player-portrait-right");
const hudOpponentEl = document.getElementById("hud-opponent");
const opponentPlayerEl = document.getElementById("opponent-player");

const engine = new Engine(canvas, true, { audioEngine: true });
const scene = new Scene(engine);
window.addEventListener("keydown", (e) => {
  if (e.key === "I" && e.shiftKey) scene.debugLayer.isVisible() ? scene.debugLayer.hide() : scene.debugLayer.show();
});
scene.clearColor.set(0.62, 0.72, 0.78, 1);
scene.imageProcessingConfiguration.exposure = CONFIG.exposure ?? 1.0;
scene.imageProcessingConfiguration.contrast = CONFIG.contrast ?? 1.0;

const visualObjects = new Map();
const visualBaseRotations = new Map();
const latestObjectStates = new Map();
const initialBlockVisuals = new Map();
const shrinkObservers = new Map();
const missileSeenUnloaded = new Set();
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
let dragPivotMarker = null;
let dragPivotMarkerMaterial = null;
let dragPivotLocalPoint = null;
let currentRoomId = null;
let currentLevelUrl = LEVEL_URL;
let loadedLevelUrl = null;
let loadingLevelUrl = null;
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
const soundEffectsController = createSoundEffectsController(sfxToggleEl, scene, {
  onStatus: setStatus,
});
let shotArcPrediction = createTrebuchetShotArcPrediction(scene, CONFIG);
const vfxManager = createVfxManager(scene);
const cameraControl = createCameraController(scene, () => myPlayerId, { mobile: isMobile });

applyRenderResolutionLimit(engine, CONFIG);

function setStatus(text) {
  connectionEl.textContent = text;
}

let _lobbyFadeTimer = null;
let _lobbyHideTimer = null;

function setLobbyStatus(text, visible = true, winnerPlayerId = null) {
  clearTimeout(_lobbyFadeTimer);
  clearTimeout(_lobbyHideTimer);
  _lobbyFadeTimer = null;
  _lobbyHideTimer = null;
  lobbyTitleEl.style.opacity = "";
  lobbyPanelEl.classList.remove("panel-hidden");

  lobbyStatusEl.innerHTML = text;
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

function repositionCrowns() {
  const GAP = 8; // px gap between portrait edge and first crown
  if (portraitLeftEl.naturalWidth > 0) {
    const r = portraitLeftEl.getBoundingClientRect();
    crownsLeftEl.style.left = (r.right + GAP) + "px";
  }
  if (portraitRightEl.naturalWidth > 0) {
    const r = portraitRightEl.getBoundingClientRect();
    crownsRightEl.style.right = (window.innerWidth - r.left + GAP) + "px";
  }
}
portraitLeftEl.addEventListener("load", repositionCrowns);
portraitRightEl.addEventListener("load", repositionCrowns);
if (portraitLeftEl.complete)  repositionCrowns();
window.addEventListener("resize", repositionCrowns);

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

let _flyingCrown = null;

function newCrownSlotRect(targetEl, scores, isLeft) {
  let count = 0;
  for (const [pid, wins] of Object.entries(scores)) {
    const n = parseInt(pid.split("_")[1], 10);
    if (!Number.isFinite(n)) continue;
    if ((n % 2 === 1) === isLeft) count += wins;
  }

  const saved = targetEl.textContent;
  targetEl.textContent = "👑".repeat(count);
  let rect = null;
  if (count > 0 && targetEl.firstChild) {
    const CROWN_LEN = "👑".length; // 2 JS chars (surrogate pair)
    // Left element has fixed left edge — it grows rightward, newest crown is last.
    // Right element has fixed right edge — it grows leftward, newest crown is first.
    const slotIndex = isLeft ? count - 1 : 0;
    const range = document.createRange();
    range.setStart(targetEl.firstChild, slotIndex * CROWN_LEN);
    range.setEnd(targetEl.firstChild, (slotIndex + 1) * CROWN_LEN);
    rect = range.getBoundingClientRect();
  }
  targetEl.textContent = saved;
  return rect ?? targetEl.getBoundingClientRect();
}

function animateWinCrown(winnerPlayerId, scores) {
  if (_flyingCrown) { _flyingCrown.remove(); _flyingCrown = null; }

  const num = parseInt(winnerPlayerId.split("_")[1], 10);
  const isLeft = Number.isFinite(num) && num % 2 === 1;
  const targetEl = isLeft ? crownsLeftEl : crownsRightEl;

  const crown = document.createElement("span");
  crown.className = "win-crown-fly";
  crown.textContent = "👑";
  document.body.appendChild(crown);
  _flyingCrown = crown;

  crown.style.transformOrigin = "0 0";
  const crownW = crown.offsetWidth;
  const startX = (window.innerWidth  - crownW) / 2;
  const startY = (window.innerHeight - crown.offsetHeight) / 2;
  crown.style.left = startX + "px";
  crown.style.top  = startY + "px";

  // Measure the glyph rect within the flying crown's CSS box.
  // The emoji glyph doesn't always start at the box's top-left corner.
  const flyRange = document.createRange();
  flyRange.setStart(crown.firstChild, 0);
  flyRange.setEnd(crown.firstChild, "👑".length);
  const flyGlyph = flyRange.getBoundingClientRect();
  const glyphOffsetX = flyGlyph.left - startX;
  const glyphOffsetY = flyGlyph.top  - startY;

  const PAUSE_MS = 600;
  const FLY_MS   = 1600;

  setTimeout(() => {
    if (_flyingCrown !== crown) return;

    const slot = newCrownSlotRect(targetEl, scores, isLeft);
    const targetScale = slot.width / flyGlyph.width;
    // With transform-origin 0 0, the glyph lands at:
    //   (startX + dx + glyphOffsetX * s, startY + dy + glyphOffsetY * s)
    // We want that to equal (slot.left, slot.top).
    const dx = slot.left - startX - glyphOffsetX * targetScale;
    const dy = slot.top  - startY - glyphOffsetY * targetScale;

    const anim = crown.animate([
      { transform: "translate(0,0) scale(1)" },
      { transform: `translate(${dx}px,${dy}px) scale(${targetScale})` },
    ], { duration: FLY_MS, easing: "ease-in", fill: "forwards" });

    anim.onfinish = () => {
      if (_flyingCrown === crown) _flyingCrown = null;
      updateCrowns(scores);
      crown.remove();
    };
  }, PAUSE_MS);
}

async function loadFragmentTemplates() {
  return loadFragmentTemplatesFromGlb({
    childRole,
    fragmentTemplateNodes,
    hitVisualTemplates,
    scene,
  });
}

function switchLevelIfNeeded(levelUrl, { force = false } = {}) {
  if (!levelUrl) return levelSwitchPromise;
  if (!force && levelUrl === loadedLevelUrl) return levelSwitchPromise;
  if (!force && levelUrl === loadingLevelUrl) return levelSwitchPromise;

  currentLevelUrl = levelUrl;
  const requestedLevelUrl = levelUrl;
  loadingLevelUrl = requestedLevelUrl;
  levelSwitchPromise = levelSwitchPromise
    .catch(() => {})
    .then(async () => {
      if (!force && loadedLevelUrl === requestedLevelUrl) return;
      await loadLevel(requestedLevelUrl, { replace: Boolean(loadedLevelUrl) || force });
    })
    .catch((err) => {
      console.error("Level switch failed:", err);
    })
    .finally(() => {
      if (loadingLevelUrl === requestedLevelUrl) {
        loadingLevelUrl = null;
      }
    });
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

function worldXToPan(x) {
  const minX = CONFIG.soundPanWorldMinX ?? -45;
  const maxX = CONFIG.soundPanWorldMaxX ?? 45;
  if (maxX === minX) return 0;

  const t = Math.max(0, Math.min(1, (Number(x ?? 0) - minX) / (maxX - minX)));
  return t * 2 - 1;
}

function impactVolumeFor(effect, impactSpeed) {
  const minSpeed = CONFIG.impactSoundVelocityMin ?? 1.5;
  const maxSpeed = Math.max(minSpeed, CONFIG.impactSoundVelocityMax ?? 24);
  const minScale = CONFIG.impactSoundVolumeMinScale ?? 0.2;
  const maxScale = CONFIG.impactSoundVolumeMaxScale ?? 1.0;
  const baseVolume = CONFIG.soundEffects?.[effect]?.volume ?? 1;
  const t = maxSpeed === minSpeed ? 1 : Math.max(0, Math.min(1, (impactSpeed - minSpeed) / (maxSpeed - minSpeed)));
  return baseVolume * (minScale + (maxScale - minScale) * t);
}

function playSoundEffectEvent(ev) {
  if (ev.kind === "soundEffectStop") {
    soundEffectsController.stopEffect(ev.effect, ev.instanceId);
    return;
  }

  const volume = ev.impactSpeed != null
    ? impactVolumeFor(ev.effect, ev.impactSpeed)
    : ev.volume;

  const options = {
    volume,
    pitch: ev.pitch,
    pan: worldXToPan(ev.x),
    loop: ev.loop,
  };

  if (ev.kind === "soundEffectStart") {
    soundEffectsController.startEffect(ev.effect, ev.instanceId, options);
    return;
  }

  if (ev.kind === "soundEffect") {
    soundEffectsController.playEffect(ev.effect, options);
  }
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
  registerVisualRootsFromGlb({
    childRole,
    descendantsOf,
    scene,
    visualBaseRotations,
    visualObjects,
  });
}

function registerTrebuchetArmNodes() {
  registerTrebuchetArmNodesFromGlb({
    findGameplayRoot,
    isTrebuchetArmRoot,
    scene,
    trebuchetArmNodes,
  });
}

function registerTrebuchetLoadTargets() {
  registerTrebuchetLoadTargetsFromGlb({
    findGameplayRoot,
    findTrebuchetArmAncestor,
    scene,
    trebuchetLoadTargets,
  });
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

function isBlockName(name) {
  const lowerName = name.toLowerCase();
  return lowerName.includes("block") && !lowerName.includes("frag");
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

function usesMagneticDragVisual(root) {
  return isBlockName(root.name) || isTrebuchetName(root.name);
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
  if (Math.sign(point.x || 0) !== Math.sign(releasePoint.x || 0)) return false;
  return Math.abs(point.x) > Math.abs(releasePoint.x);
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
  // Read the GLB camera's world position as a starting point, then replace it
  // with a code-created FreeCamera to avoid the baked 16:9 aspect ratio in the
  // GLB camera's projection matrix which breaks the viewport framing math.
  const glbCamPos = scene.cameras.length > 0
    ? scene.cameras[0].globalPosition?.clone() ?? scene.cameras[0].position.clone()
    : new Vector3(0, 0, 100);
  for (const c of [...scene.cameras]) c.dispose();

  const cam = new FreeCamera("GameCamera", glbCamPos, scene);
  cam.fov       = CONFIG.cameraVFov ?? 0.4;  // vertical FOV in radians
  cam.minZ      = 0.1;
  cam.maxZ      = 500;
  cam.rotation.y = Math.PI;                  // face along -Z toward the action plane
  scene.activeCamera = cam;

  scene.activeCamera.detachControl();

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
    cameraControlsEnabled: Boolean(isMobile),
    cameras: scene.cameras.map((camera) => camera.name),
    lights: scene.lights.map((light) => ({ name: light.name, intensity: light.intensity })),
  });
}

function isShadowCapableLight(light) {
  return light.getClassName() !== "HemisphericLight";
}

function lightWorldPosition(light) {
  light.computeTransformedInformation?.();
  return light.getAbsolutePosition?.() ?? light.position ?? null;
}

function lightDistanceSquaredToOrigin(light) {
  const position = lightWorldPosition(light);
  if (!position) return Number.POSITIVE_INFINITY;
  return (position.x * position.x) + (position.y * position.y) + (position.z * position.z);
}

function describeLight(light) {
  const position = lightWorldPosition(light);
  return {
    name: light.name,
    type: light.getClassName(),
    position: position?.asArray?.() ?? null,
    intensity: light.intensity,
    distanceToOrigin: Math.sqrt(lightDistanceSquaredToOrigin(light)),
  };
}

function selectShadowLight() {
  const candidates = scene.lights.filter(isShadowCapableLight);
  return candidates.sort((a, b) => lightDistanceSquaredToOrigin(a) - lightDistanceSquaredToOrigin(b))[0] ?? null;
}

function disposeShadowGeneratorsExcept(selectedLight) {
  for (const light of scene.lights) {
    if (light === selectedLight) continue;

    const generators = light.getShadowGenerators?.();
    if (!generators) continue;

    for (const generator of [...generators.values()]) {
      generator.dispose();
    }
  }
}

function shouldReceiveShadows(mesh) {
  const name = mesh.name.toLowerCase();
  return name.includes("ground") || name.includes("plane");
}

function setupShadows() {
  if (!CONFIG.shadowsEnabled) return;

  shadowGenerator?.dispose();
  shadowGenerator = null;

  const light = selectShadowLight();
  if (!light) {
    console.info("Shadows disabled: no shadow-capable light found.");
    return;
  }

  disposeShadowGeneratorsExcept(light);

  shadowGenerator = new ShadowGenerator(CONFIG.shadowMapSize ?? 2048, light);
  shadowGenerator.useBlurExponentialShadowMap = CONFIG.shadowBlurEnabled ?? true;
  shadowGenerator.blurKernel = CONFIG.shadowBlurKernel ?? 4;
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
    light: describeLight(light),
    candidates: scene.lights.filter(isShadowCapableLight).map(describeLight),
    casters: shadowGenerator.getShadowMap().renderList.length,
    receivers: scene.meshes.filter((mesh) => mesh.receiveShadows).map((mesh) => mesh.name),
    blurEnabled: shadowGenerator.useBlurExponentialShadowMap,
    blurKernel: shadowGenerator.blurKernel,
    bias: shadowGenerator.bias,
    normalBias: shadowGenerator.normalBias,
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

function ensureDragPivotMarker() {
  if (dragPivotMarker && !dragPivotMarker.isDisposed()) return dragPivotMarker;

  const texture = new BABYLON.DynamicTexture("DragPivotHandTexture", { width: 160, height: 160 }, scene, true);
  texture.hasAlpha = true;
  texture.drawText("🖐", null, 112, "104px sans-serif", "white", "transparent", true, true);

  dragPivotMarkerMaterial = new StandardMaterial("DragPivotHandMaterial", scene);
  dragPivotMarkerMaterial.diffuseTexture = texture;
  dragPivotMarkerMaterial.opacityTexture = texture;
  dragPivotMarkerMaterial.emissiveColor = new Color3(1, 1, 1);
  dragPivotMarkerMaterial.disableLighting = true;
  dragPivotMarkerMaterial.backFaceCulling = false;

  dragPivotMarker = MeshBuilder.CreatePlane("DragPivotHand", { size: CONFIG.dragPivotMarkerSize ?? 0.9 }, scene);
  dragPivotMarker.material = dragPivotMarkerMaterial;
  dragPivotMarker.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
  dragPivotMarker.renderingGroupId = 2;
  dragPivotMarker.isPickable = false;
  dragPivotMarker.setEnabled(false);
  return dragPivotMarker;
}

function hideDragPivotMarker() {
  dragPivotLocalPoint = null;
  if (dragPivotMarker && !dragPivotMarker.isDisposed()) {
    dragPivotMarker.setEnabled(false);
  }
}

function showDragPivotMarker(root, worldPoint) {
  if (!usesMagneticDragVisual(root)) {
    hideDragPivotMarker();
    return;
  }

  root.computeWorldMatrix(true);
  dragPivotLocalPoint = Vector3.TransformCoordinates(worldPoint, root.getWorldMatrix().clone().invert());
  updateDragPivotMarker();
}

function updateDragPivotMarker() {
  if (!selectedEntityId || !dragPivotLocalPoint || pointerMode !== "drag") return;

  const root = visualObjects.get(selectedEntityId);
  if (!root) {
    hideDragPivotMarker();
    return;
  }

  root.computeWorldMatrix(true);
  const marker = ensureDragPivotMarker();
  marker.position.copyFrom(Vector3.TransformCoordinates(dragPivotLocalPoint, root.getWorldMatrix()));
  marker.setEnabled(true);
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
    target.armNode.rotation.z = armAngleSign(trebuchetId) * restRadians;
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
    shotArcPrediction.hide();
    return;
  }

  const missileState = latestObjectStates.get(selectedEntityId);
  const trebuchetId = missileState?.loadedInto;
  if (!trebuchetId) {
    hideAimArrow();
    shotArcPrediction.hide();
    return;
  }

  const headPoint = releasePointForTrebuchet(trebuchetId);
  if (!headPoint) {
    hideAimArrow();
    shotArcPrediction.hide();
    return;
  }

  if (!isForwardPullPoint(trebuchetId, aimWorldPoint, headPoint)) {
    hideAimArrow();
    shotArcPrediction.hide();
    return;
  }

  const shotStartPoint = headPoint.clone();
  const tailPoint = clampAimTailPoint(headPoint, aimWorldPoint.clone());
  const requestedPoint = protocolPointFromWorld(aimWorldPoint, selectedEntityId);
  const aimStart = protocolPointFromWorld(headPoint, selectedEntityId);
  const currentPoint = clampedAimCurrentPoint(aimStart, requestedPoint);
  const shotVelocity = shotVelocityForAim(trebuchetId, aimStart, currentPoint);
  shotArcPrediction.update({
    startPoint: shotStartPoint,
    velocity: shotVelocity,
  });

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
  vfxManager.clearEffects();
  shotArcPrediction?.dispose();
  shotArcPrediction = null;
  hideDragPivotMarker();
  dragPivotMarker = null;
  dragPivotMarkerMaterial = null;
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
  missileSeenUnloaded.clear();
  trebuchetLoadTargets.clear();
  cameraControl.dispose();
  initialBlockVisuals.clear();
  for (const { observer, mesh } of shrinkObservers.values()) {
    scene.onBeforeRenderObservable.remove(observer);
    if (!mesh.isDisposed()) mesh.dispose();
  }
  shrinkObservers.clear();
  scene.activeCamera = null;
}

async function loadLevel(levelUrl = LEVEL_URL, { replace = false } = {}) {
  if (replace) {
    disposeLevelScene();
    shotArcPrediction = createTrebuchetShotArcPrediction(scene, CONFIG);
  }

  try {
    await appendLevelGlb(scene, levelUrl);
    applyTrebuchetArmRestPose();
    registerVisualRoots();
    initialBlockVisuals.clear();
    for (const [id, mesh] of visualObjects) {
      if (id.toLowerCase().includes("block")) {
        initialBlockVisuals.set(id, { mesh, baseRotation: { ...visualBaseRotations.get(id) } });
      }
    }
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
  cameraControl.snapshotAndPan();
  setupShadows();
  applyRenderResolutionLimit(engine, CONFIG);
  engine.resize();
  loadedLevelUrl = levelUrl;
}

function armAngleSign(trebuchetId) {
  return isLeftSideTrebuchetName(trebuchetId) ? 1 : -1;
}

function applyTrebuchetArmRestPose() {
  for (const transform of scene.transformNodes) {
    if (!isTrebuchetArmRoot(transform)) continue;

    const degrees = CONFIG.trebuchetArmRestRotationZDegrees ?? 15;
    const radians = (degrees * Math.PI) / 180;
    const root = findGameplayRoot(transform);
    const sign = root ? armAngleSign(root.name) : 1;

    transform.rotationQuaternion = null;
    transform.rotation.z = sign * radians;
    transform.computeWorldMatrix(true);
  }
}

function applyState(message) {
  for (const object of message.objects || []) {
    if (isMissileName(object.id)) {
      if (!object.loadedInto) {
        missileSeenUnloaded.add(object.id);
      } else if (missileSeenUnloaded.has(object.id)) {
        missileSeenUnloaded.delete(object.id);
        cameraControl.onMissileLoaded();
      }
    }
    latestObjectStates.set(object.id, object);
  }
  interpolator.pushSnapshot(message);
}

function removeFragmentVisualReferences(fragId) {
  visualObjects.delete(fragId);
  visualBaseRotations.delete(fragId);
  latestObjectStates.delete(fragId);
}

function cancelFragmentShrink(fragId) {
  const existing = shrinkObservers.get(fragId);
  if (!existing) return null;

  scene.onBeforeRenderObservable.remove(existing.observer);
  shrinkObservers.delete(fragId);
  return existing.mesh;
}

function startFragmentShrink(fragId, durationMs, { detachFromState = false } = {}) {
  const existingMesh = cancelFragmentShrink(fragId);
  const mesh = visualObjects.get(fragId) ?? existingMesh;
  if (!mesh || mesh.isDisposed()) return;

  if (detachFromState) removeFragmentVisualReferences(fragId);

  const duration = Math.max(1, durationMs);
  const startScale = mesh.scaling.clone();
  const startTime = performance.now();
  const observer = scene.onBeforeRenderObservable.add(() => {
    if (mesh.isDisposed()) {
      scene.onBeforeRenderObservable.remove(observer);
      shrinkObservers.delete(fragId);
      removeFragmentVisualReferences(fragId);
      return;
    }

    const t = Math.min(1, (performance.now() - startTime) / duration);
    const s = 1 - t;
    mesh.scaling.set(startScale.x * s, startScale.y * s, startScale.z * s);
    if (t >= 1) {
      scene.onBeforeRenderObservable.remove(observer);
      shrinkObservers.delete(fragId);
      removeFragmentVisualReferences(fragId);
      mesh.dispose();
    }
  });
  shrinkObservers.set(fragId, { observer, mesh });
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
      const isOdd = playerNum % 2 === 1;
      hudEl.classList.remove("player-odd", "player-even");
      hudEl.classList.add(isOdd ? "player-odd" : "player-even");
      const hideHud = Boolean(CONFIG.hideHud);
      hudEl.classList.toggle("hud-hidden", hideHud);
      hudOpponentEl.classList.toggle("hud-hidden", hideHud);
      roundCounterEl.classList.toggle("hud-hidden", hideHud);
      mediaControlsEl.classList.remove("player-odd", "player-even");
      mediaControlsEl.classList.add(isOdd ? "player-odd" : "player-even");
    }
  }

  if (message.type === "lobby") {
    currentRoomId = message.roomId;
    currentLevelUrl = message.level ?? currentLevelUrl;
    isMatched = false;
    setLobbyStatus(message.status === "spectating"
      ? `${message.playerId} waiting for a player slot...`
      : `A two player battle. You are waiting for an opponent. <button class="copy-url-btn" data-copy-url="http://game-show.cloud-ip.cc/">Copy game URL</button> and give to a friend and prepare for combat!`);
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
      lobbyPanelEl.classList.add("panel-hidden");
      _lobbyFadeTimer = setTimeout(() => {
        lobbyTitleEl.style.opacity = "0";
        _lobbyHideTimer = setTimeout(() => setLobbyStatus("", false), 800);
      }, 5000);
    });
  }

  if (message.type === "roundEnded") {
    isMatched = false;
    animateWinCrown(message.winner, message.scores ?? {});
    cameraControl.onRoundWin(message.winner);
  }

  if (message.type === "levelChanged") {
    if (message.roomId && currentRoomId && message.roomId !== currentRoomId) return;
    currentLevelUrl = message.level ?? currentLevelUrl;
    isMatched = false;
    updateRoundCounter(message.roundNumber);
    updateCrowns(message.scores ?? {});
    setLobbyStatus(message.forceReload ? "Reloading..." : "Loading next level...");
    switchLevelIfNeeded(currentLevelUrl, { force: Boolean(message.forceReload) }).then(() => {
      isMatched = true;
      setLobbyStatus("", false);
    });
  }

  if (message.type === "event") {
    if (currentLevelUrl && loadedLevelUrl !== currentLevelUrl) return;

    for (const ev of message.events ?? []) {
      playSoundEffectEvent(ev);
      vfxManager.handleEvent(ev);



      if (ev.kind === "blockHit") {
        const side = ev.blockId.toLowerCase().includes("blockl") ? "L" : "R";
        const template = hitVisualTemplates[side][ev.hits];
        if (template) {
          const blockState = latestObjectStates.get(ev.blockId);
          soundEffectsController.playEffect("missile_crack_block", { pan: worldXToPan(blockState?.x) });

          const originalBase = visualBaseRotations.get(ev.blockId) ?? { x: 0, y: 0, z: 0 };
          const current = visualObjects.get(ev.blockId);
          if (current) {
            const isOriginal = initialBlockVisuals.get(ev.blockId)?.mesh === current;
            if (isOriginal) current.setEnabled(false);
            else current.dispose();
          }
          const clone = template.clone(ev.blockId, null, true);
          if (clone) {
            clone.setEnabled(true);
            clone.isVisible = true;
            visualObjects.set(ev.blockId, clone);
            visualBaseRotations.set(ev.blockId, originalBase);
          }
        }
      }

      if (ev.kind === "fragmentHit") {
        startFragmentShrink(ev.fragId, CONFIG.fragmentShrinkMs ?? 500, { detachFromState: true });
      }

      if (ev.kind === "objectRemoved") {
        const mesh = visualObjects.get(ev.objectId);
        if (mesh) mesh.setEnabled(false);
        visualObjects.delete(ev.objectId);
        latestObjectStates.delete(ev.objectId);
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
          clone.isVisible = true;
          visualObjects.set(ev.fragIds[i], clone);
          visualBaseRotations.set(ev.fragIds[i], { x: 0, y: 0, z: 0 });
          startFragmentShrink(ev.fragIds[i], CONFIG.fragmentSlowShrinkMs ?? 15000);
        }
      }
    }
  }

  if (message.type === "state") {
    if (message.roomId && currentRoomId && message.roomId !== currentRoomId) return;
    const stateLevelUrl = message.level ?? currentLevelUrl;
    if (stateLevelUrl && loadedLevelUrl !== stateLevelUrl) {
      switchLevelIfNeeded(stateLevelUrl);
      return;
    }

    updateRoundCounter(message.roundNumber);
    if (!_flyingCrown) updateCrowns(message.scores ?? {});
    applyState(message);
    updateMusicFromState(message);
  }
});

let idleDisconnected = false;
socket.addEventListener("message", (event) => {
  try {
    const msg = JSON.parse(event.data);
    if (msg.type === "idleDisconnect") idleDisconnected = true;
  } catch { /* handled by main message listener */ }
}, { capture: true });

socket.addEventListener("close", () => {
  setStatus("Disconnected");
  isMatched = false;
  hudOpponentEl.style.display = "none";
  if (idleDisconnected) {
    setLobbyStatus("Disconnected due to inactivity. Refresh to reconnect.");
  } else {
    setLobbyStatus("Disconnected");
  }
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

sfxToggleEl.addEventListener("click", async () => {
  try {
    await soundEffectsController.toggle();
  } catch (error) {
    console.error("Failed to toggle sound effects.", error);
    setStatus("SFX failed");
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

function shotVelocityForAim(trebuchetId, startPoint, currentPoint) {
  const powerScale = CONFIG.aimPowerScale ?? 8;
  const shotDirectionX = isLeftSideTrebuchetName(trebuchetId) ? -1 : 1;
  return clampMagnitude({
    x: Math.abs(startPoint.x - currentPoint.x) * powerScale * shotDirectionX,
    y: (startPoint.y - currentPoint.y) * powerScale,
    z: (startPoint.z - currentPoint.z) * powerScale,
  }, CONFIG.trebuchetFireVelocityMax ?? 40);
}

function clampedAimCurrentPoint(startPoint, requestedPoint) {
  const pullX = requestedPoint.x - startPoint.x;
  const pullY = requestedPoint.y - startPoint.y;
  const pullDistance = Math.hypot(pullX, pullY);
  const maxPullDistance = CONFIG.aimMaxPullDistance ?? 6;
  const clampedDistance = Math.min(pullDistance, maxPullDistance);
  const pullScale = pullDistance > 0.0001 ? clampedDistance / pullDistance : 0;

  return {
    x: startPoint.x + pullX * pullScale,
    y: startPoint.y + pullY * pullScale,
    z: requestedPoint.z,
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
  showDragPivotMarker(root, world);

  const objectState = latestObjectStates.get(selectedEntityId);
  if (objectState?.loadedInto) {
    hideDragPivotMarker();
    pointerMode = "aim";
    aimWorldPoint = world.clone();
    updateAimArrow();
    cameraControl.onAimStart();
    sendInput("aimStart", {
      entityId: selectedEntityId,
      trebuchetId: objectState.loadedInto,
      point,
    });
    return;
  }

  startReleaseVelocitySampling(point);
  releaseVelocity = { x: 0, y: 0, z: 0 };
  if (!isMissileName(selectedEntityId)) {
    cameraControl.onDragStart();
  }
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
    cameraControl.onAimRelease();

    selectedEntityId = null;
    pointerMode = "drag";
    aimWorldPoint = null;
    hideDragPivotMarker();
    shotArcPrediction.fadeOut();
    hideAimArrow();
    return;
  }

  const shouldReturnFromDragCamera = !isMissileName(selectedEntityId);
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

  if (shouldReturnFromDragCamera) {
    cameraControl.onDragEnd();
  }

  selectedEntityId = null;
  pointerMode = "drag";
  latestDragPoint = null;
  releaseSamples = [];
  releaseVelocity = { x: 0, y: 0, z: 0 };
  aimWorldPoint = null;
  hideDragPivotMarker();
  shotArcPrediction.hide();
  hideAimArrow();

}

scene.onPointerObservable.add((pointerInfo) => {
  if (pointerInfo.type === BABYLON.PointerEventTypes.POINTERDOWN) {
    cameraControl.onFirstInput();
    beginDrag();
  }

  if (pointerInfo.type === BABYLON.PointerEventTypes.POINTERMOVE && selectedEntityId) {
    moveDrag();
  }

  if (pointerInfo.type === BABYLON.PointerEventTypes.POINTERUP && selectedEntityId) {
    endDrag();
  }
});

const initialLevelUrl = currentLevelUrl;
loadingLevelUrl = initialLevelUrl;
levelSwitchPromise = loadLevel(initialLevelUrl).finally(() => {
  if (loadingLevelUrl === initialLevelUrl) {
    loadingLevelUrl = null;
  }
}).then(() => {
  engine.runRenderLoop(() => {
    if (scene.activeCamera) {
      scene.render();
    }
  });
});

const interpolator = createInterpolator({
  config: CONFIG,
  visualObjects,
  visualBaseRotations,
  trebuchetArmNodes,
  protocolToBabylonRotation,
  degreesToRadians,
  armAngleSign,
  getPointerMode: () => pointerMode,
  getSelectedEntityId: () => selectedEntityId,
  updateAimArrow,
  updateDragPivotMarker,
});
scene.onBeforeRenderObservable.add(interpolator.applyInterpolatedPositions);

window.addEventListener("resize", () => {
  applyRenderResolutionLimit(engine, CONFIG);
  engine.resize();
});

window.addEventListener("blur", () => {
  stopReleaseVelocitySampling();
});
