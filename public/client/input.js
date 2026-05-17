import { scene, canvas, resetEl, restartServerEl, connectionEl, CONFIG } from "./engine.js";
import { isDraggableRoot } from "./utils.js";
import { visualObjects, latestObjectStates, findGameplayRoot } from "./state.js";
import { sendInput } from "./network.js";
import { setAimRefs, updateAimArrow, hideAimArrow } from "./aim.js";

const { Vector3 } = BABYLON;

let selectedEntityId = null;
let pointerMode = "drag";
let dragDepth = 0;
let aimWorldPoint = null;

setAimRefs(
  () => pointerMode,
  () => selectedEntityId,
  () => aimWorldPoint,
);

function setStatus(text) {
  connectionEl.textContent = text;
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
    aimWorldPoint = world.clone();
    updateAimArrow();
    sendInput("aimStart", {
      entityId: selectedEntityId,
      trebuchetId: objectState.loadedInto,
      point,
    });
    return;
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

  sendInput("dragEnd", {
    entityId: selectedEntityId,
    point: finalPoint,
  });

  selectedEntityId = null;
  pointerMode = "drag";
  aimWorldPoint = null;
  hideAimArrow();

  if (CONFIG.cameraControlsEnabled) {
    scene.activeCamera.attachControl(canvas, true);
  }
}

export function setupInput() {
  resetEl.addEventListener("click", () => {
    sendInput("reset", {});
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

}
