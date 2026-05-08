import { BARRAGE_CONFIG } from "./config.js";

const { Vector3 } = BABYLON;

export function createCameraController(scene, getPlayerId) {
  const CONFIG = BARRAGE_CONFIG;

  let battlefieldCamPos    = null;
  let battlefieldCamTarget = null;
  let playerCamPos         = null;
  let playerCamTarget      = null;
  let camAnimObserver      = null;
  let camReturnTimer       = null;

  function isLeftSidePlayer() {
    const id = getPlayerId();
    if (!id) return null;
    const num = parseInt(id.split("_")[1], 10);
    return Number.isFinite(num) ? num % 2 === 1 : null;
  }

  function camTargetOf(cam) {
    // Always compute from the camera's actual rendered forward direction.
    // cam.target is unreliable for imported GLB cameras — it often defaults
    // to Vector3.Zero() regardless of the camera's rotation, causing a
    // near-zero direction vector when setTarget is called and a sky snap.
    const dir = cam.getForwardRay(1).direction;
    return cam.position.add(dir.scale(20));
  }

  function snapshotBattlefieldCam() {
    const cam = scene.activeCamera;
    if (!cam) return;
    battlefieldCamPos    = cam.position.clone();
    battlefieldCamTarget = camTargetOf(cam);
  }

  function computePlayerCam() {
    if (!battlefieldCamPos || !battlefieldCamTarget) return;
    const left = isLeftSidePlayer();
    if (left === null) return;
    const sign   = left ? 1 : -1;
    const offsetX = (CONFIG.playerCamOffsetX ?? 8) * sign;
    const offsetZ =  CONFIG.playerCamOffsetZ ?? -6;
    const offsetY = CONFIG.playerCamOffsetY ?? 0;
    playerCamTarget = new Vector3(battlefieldCamTarget.x + offsetX, battlefieldCamTarget.y + offsetY, battlefieldCamTarget.z + offsetZ);
    playerCamPos    = new Vector3(battlefieldCamPos.x    + offsetX, battlefieldCamPos.y    + offsetY, battlefieldCamPos.z + offsetZ);
  }

  function ease(t) {
    return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
  }

  function animate(toPos, toTarget, durationMs, onComplete) {
    const cam = scene.activeCamera;
    if (!cam || !toPos || !toTarget) return;
    if (camAnimObserver) {
      scene.onBeforeRenderObservable.remove(camAnimObserver);
      camAnimObserver = null;
    }
    const fromPos    = cam.position.clone();
    const fromTarget = camTargetOf(cam);
    const startTime  = performance.now();
    camAnimObserver  = scene.onBeforeRenderObservable.add(() => {
      const t = Math.min(1, (performance.now() - startTime) / durationMs);
      const e = ease(t);
      cam.position.set(
        fromPos.x + (toPos.x - fromPos.x) * e,
        fromPos.y + (toPos.y - fromPos.y) * e,
        fromPos.z + (toPos.z - fromPos.z) * e,
      );
      cam.setTarget(new Vector3(
        fromTarget.x + (toTarget.x - fromTarget.x) * e,
        fromTarget.y + (toTarget.y - fromTarget.y) * e,
        fromTarget.z + (toTarget.z - fromTarget.z) * e,
      ));
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
    snapshotBattlefieldCam();
    computePlayerCam();
    if (playerCamPos) {
      animate(playerCamPos, playerCamTarget, CONFIG.cameraInitialPanMs ?? 1800);
    }
  }

  function onAimStart() {
    cancelReturn();
    if (playerCamPos) {
      animate(battlefieldCamPos, battlefieldCamTarget, CONFIG.cameraAimZoomOutMs ?? 250);
    }
  }

  function onAimRelease() {
    if (!playerCamPos) return;
    const delay    = CONFIG.cameraReturnDelayMs ?? 1200;
    const duration = CONFIG.cameraReturnMs ?? 900;
    camReturnTimer = setTimeout(() => {
      camReturnTimer = null;
      animate(playerCamPos, playerCamTarget, duration);
    }, delay);
  }

  function dispose() {
    cancelReturn();
    if (camAnimObserver) {
      scene.onBeforeRenderObservable.remove(camAnimObserver);
      camAnimObserver = null;
    }
    battlefieldCamPos    = null;
    battlefieldCamTarget = null;
    playerCamPos         = null;
    playerCamTarget      = null;
  }

  return { snapshotAndPan, onAimStart, onAimRelease, dispose };
}
