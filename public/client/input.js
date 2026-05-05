import { scene, canvas, resetEl, CONFIG } from "./engine.js";
import { isDraggableRoot, clampMagnitude } from "./utils.js";
import { visualObjects, latestObjectStates, findGameplayRoot } from "./state.js";
import { sendInput } from "./network.js";

const { Vector3 } = BABYLON;

let selectedEntityId = null;
let pointerMode = "drag";
let dragDepth = 0;
let latestDragPoint = null;
let releaseSamples = [];
let releaseSampleTimer = null;
let releaseVelocity = { x: 0, y: 0, z: 0 };

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

export function setupInput() {
  resetEl.addEventListener("click", () => {
    sendInput("reset", {});
  });

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

  window.addEventListener("blur", () => {
    stopReleaseVelocitySampling();
  });
}
