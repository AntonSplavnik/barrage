import { BARRAGE_CONFIG } from "./config.js";

const { Vector3 } = BABYLON;

export function createCameraController(scene, getPlayerId) {
  const CONFIG = BARRAGE_CONFIG;

  // Camera only ever translates — setTarget is never called because it fights
  // with the rotation the GLB loader baked into the camera.

  let battlefieldCamPos = null;
  let playerCamPos      = null;
  let camAnimObserver   = null;
  let camReturnTimer    = null;

  function isLeftSidePlayer() {
    const id = getPlayerId();
    if (!id) return null;
    const num = parseInt(id.split("_")[1], 10);
    return Number.isFinite(num) ? num % 2 === 1 : null;
  }

  // Compute world-space camera position for a given viewport X range.
  // Camera Z is solved so [xMin, xMax] at Z=0 fills the canvas horizontally.
  // Camera Y is solved so CONFIG.viewportBottomY sits at the bottom screen edge.
  // Assumes camera looks horizontally along -Z (camDir.y ≈ 0).
  function computeCamPos(xMin, xMax, bottomY) {
    const cam = scene.activeCamera;
    if (!cam) return null;

    const width       = xMax - xMin;
    const centreX     = (xMin + xMax) / 2;
    const aspectRatio = scene.getEngine().getAspectRatio(cam);
    const vFov        = cam.fov;
    const hFov        = 2 * Math.atan(Math.tan(vFov / 2) * aspectRatio);

    // Distance in Z so [xMin,xMax] exactly fills the canvas width at Z=0.
    const dist = (width / 2) / Math.tan(hFov / 2);

    // Camera Y so bottomY sits at the very bottom of the frame:
    // bottomY = camY - dist*tan(vFov/2)  →  camY = bottomY + dist*tan(vFov/2)
    const camY = bottomY + dist * Math.tan(vFov / 2);

    return new Vector3(centreX, camY, dist);
  }

  function initCameraPositions() {
    const cam = scene.activeCamera;
    if (cam) {
      const ar   = scene.getEngine().getAspectRatio(cam);
      const hFov = 2 * Math.atan(Math.tan(cam.fov / 2) * ar);
      console.log("[cam] vFov=" + (cam.fov * 180 / Math.PI).toFixed(1) + "deg hFov=" + (hFov * 180 / Math.PI).toFixed(1) + "deg aspect=" + ar.toFixed(3));
    }

    // Vertical boundary: read from the GLB plane if present, else fall back to config.
    // Horizontal limits always come from config.
    let bottomY = CONFIG.viewportBottomY ?? -8;
    const vbNode = scene.meshes.find(m => m.name.toLowerCase() === "viewport-vertical_boundary")
      ?? scene.transformNodes.find(m => m.name.toLowerCase() === "viewport-vertical_boundary");
    if (vbNode) {
      if (vbNode.isVisible !== undefined) vbNode.isVisible = false;
      // hide any mesh children too
      if (typeof vbNode.getChildMeshes === "function") {
        for (const child of vbNode.getChildMeshes()) child.isVisible = false;
      }
      vbNode.computeWorldMatrix(true);
      const { min, max } = vbNode.getHierarchyBoundingVectors(true);
      bottomY = (min.y + max.y) / 2;
      console.log("[cam] vertical_boundary Y=" + bottomY.toFixed(2) + " (from GLB node)");
    } else {
      console.log("[cam] vertical_boundary Y=" + bottomY.toFixed(2) + " (from config, node not found)");
    }

    battlefieldCamPos = computeCamPos(CONFIG.viewportBfXMin, CONFIG.viewportBfXMax, bottomY);

    // P1 = odd player numbers (left side, negative X in world space)
    // P2 = even player numbers (right side, positive X in world space)
    // Swap P1/P2 here if player 2 reports seeing player 1's side.
    const left = isLeftSidePlayer();
    if (left === true) {
      playerCamPos = computeCamPos(CONFIG.viewportP2XMin, CONFIG.viewportP2XMax, bottomY);
    } else if (left === false) {
      playerCamPos = computeCamPos(CONFIG.viewportP1XMin, CONFIG.viewportP1XMax, bottomY);
    } else {
      playerCamPos = null;
    }

    console.log("[cam] isLeftSide=" + left
      + " bf=(" + (battlefieldCamPos?.x.toFixed(1)) + "," + (battlefieldCamPos?.y.toFixed(1)) + "," + (battlefieldCamPos?.z.toFixed(1)) + ")"
      + " player=" + (playerCamPos ? "(" + playerCamPos.x.toFixed(1) + "," + playerCamPos.y.toFixed(1) + "," + playerCamPos.z.toFixed(1) + ")" : "null"));
  }

  function ease(t) {
    return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
  }

  function animate(toPos, durationMs, onComplete) {
    const cam = scene.activeCamera;
    if (!cam || !toPos) return;
    if (camAnimObserver) {
      scene.onBeforeRenderObservable.remove(camAnimObserver);
      camAnimObserver = null;
    }
    const fromPos   = cam.position.clone();
    const startTime = performance.now();
    camAnimObserver = scene.onBeforeRenderObservable.add(() => {
      const t = Math.min(1, (performance.now() - startTime) / durationMs);
      const e = ease(t);
      const px = fromPos.x + (toPos.x - fromPos.x) * e;
      const py = fromPos.y + (toPos.y - fromPos.y) * e;
      const pz = fromPos.z + (toPos.z - fromPos.z) * e;
      cam.position.set(px, py, pz);
      if (t >= 1) {
        scene.onBeforeRenderObservable.remove(camAnimObserver);
        camAnimObserver = null;
        onComplete?.();
      }
    });
  }

  function cancelReturn() {
    if (camReturnTimer !== null) {
      clearTimeout(camReturnTimer);
      camReturnTimer = null;
    }
  }

  // Public API

  function snapshotAndPan() {
    initCameraPositions();
    const cam = scene.activeCamera;
    if (cam && battlefieldCamPos) {
      cam.position.copyFrom(battlefieldCamPos);
    }
    if (playerCamPos) {
      animate(playerCamPos, CONFIG.cameraInitialPanMs ?? 1800);
    }
  }

  function onAimStart() {
    cancelReturn();
    animate(battlefieldCamPos, CONFIG.cameraAimZoomOutMs ?? 250);
  }

  function onAimRelease() {
    if (!playerCamPos) return;
    const delay    = CONFIG.cameraReturnDelayMs ?? 1200;
    const duration = CONFIG.cameraReturnMs ?? 900;
    camReturnTimer = setTimeout(() => {
      camReturnTimer = null;
      animate(playerCamPos, duration);
    }, delay);
  }

  function dispose() {
    cancelReturn();
    if (camAnimObserver) {
      scene.onBeforeRenderObservable.remove(camAnimObserver);
      camAnimObserver = null;
    }
    battlefieldCamPos = null;
    playerCamPos      = null;
  }

  return { snapshotAndPan, onAimStart, onAimRelease, dispose };
}
