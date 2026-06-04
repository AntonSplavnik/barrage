import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { BARRAGE_CONFIG } from "../public/config.js";

function canGrabInFlightMissile(object, { isMissileBombName, isMissileName }) {
  if (!object.inFlight || !isMissileName(object.id)) return true;
  return isMissileBombName(object.id)
    ? BARRAGE_CONFIG.grabBombInFlight === true
    : BARRAGE_CONFIG.grabMissilesInFlight === true;
}

function canGrabMissileEverywhere(object, { isMissileBombName, isMissileName }) {
  if (object.inFlight || !isMissileName(object.id)) return false;
  return isMissileBombName(object.id)
    ? BARRAGE_CONFIG.grabBombsEverywhere === true
    : BARRAGE_CONFIG.grabMissilesEverywhere === true;
}

export function createInputHandler({
  armStateAiming,
  armStateReleasing,
  beginTrebuchetRelease,
  broadcast,
  broadcastSoundEffectStart,
  canGrab,
  constrainedPointForObject,
  constrainWorldBounds,
  dragState,
  gameObjects,
  getActiveRoom,
  getTick,
  isInPlayerZone,
  isMissileBombName,
  isMissileName,
  loadTargetForTrebuchet,
  localPointForObject,
  physicsAggregates,
  playerSide,
  releaseDrag,
  reloadRoom,
  restArmAngleForTrebuchet,
  setPhysicsBodyTrigger,
  stopTrebuchetStretchSound,
  syncPhysicsBodyFromObject,
  updateTrebuchetAim,
  usableReleaseVelocity,
  usesMagneticDrag,
  zoneLimitX,
}) {
  return function applyInput(client, message) {
    if (message.type !== "input") return;

    if (message.action === "reset") {
      reloadRoom?.().catch((err) => console.error("Room reload failed:", err));
      return;
    }

    if (message.action === "dragStart") {
      const object = gameObjects().get(message.entityId);
      if (!object || !message.point) return;
      if (!object.dynamic) { console.log("[grab] REJECT not dynamic", message.entityId); return; }
      if (object.draggedBy) { console.log("[grab] REJECT draggedBy", message.entityId, object.draggedBy); return; }
      if (object.loadedInto) { console.log("[grab] REJECT loadedInto", message.entityId, object.loadedInto); return; }
      if (object.isFragment) { console.log("[grab] REJECT isFragment", message.entityId); return; }
      if (!canGrabInFlightMissile(object, { isMissileBombName, isMissileName })) { console.log("[grab] REJECT inFlight", message.entityId); return; }
      if (!canGrabMissileEverywhere(object, { isMissileBombName, isMissileName }) && !canGrab(client.playerId, object)) { console.log("[grab] REJECT canGrab", client.playerId, message.entityId, "x=", object.x); return; }
      console.log("[grab] OK", client.playerId, message.entityId, "x=", object.x);

      object.draggedBy = client.playerId;
      if (isMissileName(object.id)) {
        setPhysicsBodyTrigger(object, true);
      }
      if (usesMagneticDrag(object)) {
        const aggregate = physicsAggregates().get(object.id);
        aggregate?.body.setLinearVelocity(Vector3.Zero());
        aggregate?.body.setAngularVelocity(Vector3.Zero());
      } else {
        object.vx = 0;
        object.vy = 0;
        object.vz = 0;
      }
      dragState().set(object.id, {
        lastTime: Date.now(),
        lastPoint: message.point,
        ...(usesMagneticDrag(object) ? { grabLocalPoint: localPointForObject(object, message.point) } : {}),
      });
    }

    if (message.action === "aimStart") {
      const missile = gameObjects().get(message.entityId);
      if (!missile || !message.point || !missile.loadedInto) return;
      if (!canGrab(client.playerId, missile)) return;

      const trebuchet = gameObjects().get(missile.loadedInto);
      if (!trebuchet || !trebuchet.loaded || trebuchet.fireState === armStateReleasing) return;

      const aimStart = loadTargetForTrebuchet(trebuchet) ?? missile;
      trebuchet.fireState = armStateAiming;
      trebuchet.aimedBy = client.playerId;
      trebuchet.aimStart = {
        x: aimStart.x,
        y: aimStart.y,
        z: aimStart.z,
      };
      trebuchet.aimCurrent = trebuchet.aimStart;
      trebuchet.pendingShot = null;
      trebuchet.releaseElapsedMs = 0;
      trebuchet.armAngle = restArmAngleForTrebuchet(trebuchet);
      trebuchet.stretchSoundActive = true;
      broadcastSoundEffectStart("trebuchet_stretch", trebuchet.id, trebuchet);
    }

    if (message.action === "aimMove") {
      const missile = gameObjects().get(message.entityId);
      if (!missile || !message.point || !missile.loadedInto) return;

      const trebuchet = gameObjects().get(missile.loadedInto);
      if (!trebuchet || trebuchet.aimedBy !== client.playerId || trebuchet.fireState !== armStateAiming) return;

      updateTrebuchetAim(trebuchet, message.point);
    }

    if (message.action === "aimRelease") {
      const missile = gameObjects().get(message.entityId);
      if (!missile || !message.point || !missile.loadedInto) return;

      const trebuchet = gameObjects().get(missile.loadedInto);
      if (!trebuchet || trebuchet.aimedBy !== client.playerId || trebuchet.fireState !== armStateAiming) return;

      updateTrebuchetAim(trebuchet, message.point);
      stopTrebuchetStretchSound(trebuchet);
      beginTrebuchetRelease(trebuchet);
    }

    if (message.action === "dragMove") {
      const object = gameObjects().get(message.entityId);
      if (!object || !message.point) return;
      if (object.draggedBy !== client.playerId) return;

      const now = Date.now();
      const previous = dragState().get(object.id);
      const dt = Math.max(0.001, (now - (previous?.lastTime ?? now)) / 1000);
      const next = constrainedPointForObject(object, message.point);

      const side = playerSide(client.playerId);
      if (!canGrabMissileEverywhere(object, { isMissileBombName, isMissileName }) && side && !isInPlayerZone(side, next.x)) {
        if (!usesMagneticDrag(object)) {
          object.x = zoneLimitX(side);
          object.y = next.y;
          object.z = next.z;
        }
        releaseDrag(object, { x: 0, y: 0, z: 0 });
        return;
      }

      const nextX = next.x;
      const nextY = next.y;
      const nextZ = next.z;

      object.dragVx = (nextX - object.x) / dt;
      object.dragVy = (nextY - object.y) / dt;
      object.dragVz = (nextZ - object.z) / dt;
      if (usesMagneticDrag(object)) {
        const previousDrag = dragState().get(object.id);
        dragState().set(object.id, {
          lastTime: now,
          lastPoint: next,
          grabLocalPoint: previousDrag?.grabLocalPoint ?? localPointForObject(object, next),
        });
        return;
      }

      object.x = nextX;
      object.y = nextY;
      object.z = nextZ;
      constrainWorldBounds(object);
      syncPhysicsBodyFromObject(object, { x: 0, y: 0, z: 0 });
      object.vx = 0;
      object.vy = 0;
      object.vz = 0;
      dragState().set(object.id, { lastTime: now, lastPoint: next });
    }

    if (message.action === "dragEnd") {
      const object = gameObjects().get(message.entityId);
      if (!object || !message.point) return;
      if (object.draggedBy !== client.playerId) return;

      if (usesMagneticDrag(object)) {
        releaseDrag(object, usableReleaseVelocity(object, message));
        return;
      }

      const next = constrainedPointForObject(object, message.point);
      object.x = next.x;
      object.y = next.y;
      object.z = next.z;
      releaseDrag(object, usableReleaseVelocity(object, { ...message, point: next }));
    }

    if (message.action === "fire") {
      broadcast({
        type: "event",
        tick: getTick(),
        events: [
          {
            kind: "fire",
            playerId: client.playerId,
            start: message.start,
            end: message.end,
          },
        ],
      });
    }
  };
}
