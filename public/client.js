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
const connectionEl = document.getElementById("connection");
const playerEl = document.getElementById("player");
const resetEl = document.getElementById("reset");

const engine = new Engine(canvas, true);
const scene = new Scene(engine);
scene.clearColor.set(0.62, 0.72, 0.78, 1);
scene.imageProcessingConfiguration.exposure = CONFIG.exposure ?? 1.0;
scene.imageProcessingConfiguration.contrast = CONFIG.contrast ?? 1.0;

const visualObjects = new Map();
const latestObjectStates = new Map();
const trebuchetArmNodes = new Map();
let seq = 0;
let selectedEntityId = null;
let pointerMode = "drag";
let shadowGenerator = null;
let dragDepth = 0;
let latestDragPoint = null;
let releaseSamples = [];
let releaseSampleTimer = null;
let releaseVelocity = { x: 0, y: 0, z: 0 };

function setStatus(text) {
  connectionEl.textContent = text;
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

async function loadLevel() {
  try {
    await SceneLoader.AppendAsync("", LEVEL_URL, scene);
    applyTrebuchetArmRestPose();
    registerVisualRoots();
    registerTrebuchetArmNodes();

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
    visual.rotation.z = protocolToBabylonRotation(object.rot || 0);

    const arm = trebuchetArmNodes.get(object.id);
    if (arm && typeof object.armAngle === "number") {
      arm.rotationQuaternion = null;
      arm.rotation.z = degreesToRadians(object.armAngle);
      arm.computeWorldMatrix(true);
    }
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
    playerEl.textContent = message.playerId;
  }

  if (message.type === "state") {
    applyState(message);
  }
});

socket.addEventListener("close", () => {
  setStatus("Disconnected");
});

function sendInput(action, payload) {
  if (socket.readyState !== WebSocket.OPEN) return;

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

  const now = performance.now();
  const previous = releaseSamples.at(-1);

  if (previous) {
    const distance = Math.hypot(
      latestDragPoint.x - previous.point.x,
      latestDragPoint.y - previous.point.y,
      latestDragPoint.z - previous.point.z,
    );

    if (distance < (CONFIG.releaseVelocityMinSampleDistance ?? 0.05)) {
      return;
    }
  }

  releaseSamples.push({
    time: now,
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
    const finalPoint = protocolPointFromWorld(point, selectedEntityId);
    sendInput("aimRelease", {
      entityId: selectedEntityId,
      point: finalPoint,
    });

    selectedEntityId = null;
    pointerMode = "drag";
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

loadLevel().then(() => {
  engine.runRenderLoop(() => {
    scene.render();
  });
});

window.addEventListener("resize", () => {
  engine.resize();
});

window.addEventListener("blur", () => {
  stopReleaseVelocitySampling();
});
