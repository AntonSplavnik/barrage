import { gameObjects, gameState } from "./state.js";
import { resetMatch, resetRoundState } from "./modeRunner.js";
import {
  restArmAngleForTrebuchet,
  ARM_STATE_AIMING,
  ARM_STATE_RELEASING,
} from "./entities.js";
import { handleDragStart, handleDragMove, handleDragEnd } from "./drag.js";
import { updateTrebuchetAim, beginTrebuchetRelease } from "./trebuchet.js";
import { broadcast } from "../net/broadcast.js";
import { broadcastSfx, broadcastSfxStart, broadcastSfxStop } from "./sound.js";

export function applyInput(client, message) {
  if (message.type !== "input") return;

  if (message.action === "reset") {
    if (gameState.matchOver) {
      resetMatch();
    } else {
      resetRoundState();
      broadcast({
        type: "event",
        tick: 0,
        events: [{ kind: "reset", playerId: client.playerId }],
      });
    }
    return;
  }

  if (gameState.matchOver) return;

  if (message.action === "dragStart") return handleDragStart(client, message);
  if (message.action === "dragMove") return handleDragMove(client, message);
  if (message.action === "dragEnd") return handleDragEnd(client, message);

  if (message.action === "aimStart") {
    const missile = gameObjects.get(message.entityId);
    if (!missile || !message.point || !missile.loadedInto) return;

    const trebuchet = gameObjects.get(missile.loadedInto);
    if (!trebuchet || !trebuchet.loaded || trebuchet.fireState === ARM_STATE_RELEASING) return;
    if (trebuchet.player && trebuchet.player !== client.id) return;

    trebuchet.fireState = ARM_STATE_AIMING;
    trebuchet.aimedBy = client.id;
    trebuchet.aimStart = {
      x: Number(message.point.x),
      y: Number(message.point.y ?? missile.y),
      z: Number(message.point.z),
    };
    trebuchet.aimCurrent = trebuchet.aimStart;
    trebuchet.pendingShot = null;
    trebuchet.releaseElapsedMs = 0;
    trebuchet.armAngle = restArmAngleForTrebuchet();
    broadcastSfxStart("trebuchet_stretch", trebuchet.id, { x: trebuchet.x });
  }

  if (message.action === "aimMove") {
    const missile = gameObjects.get(message.entityId);
    if (!missile || !message.point || !missile.loadedInto) return;

    const trebuchet = gameObjects.get(missile.loadedInto);
    if (!trebuchet || trebuchet.aimedBy !== client.id || trebuchet.fireState !== ARM_STATE_AIMING) return;

    updateTrebuchetAim(trebuchet, message.point);
  }

  if (message.action === "aimRelease") {
    const missile = gameObjects.get(message.entityId);
    if (!missile || !message.point || !missile.loadedInto) return;

    const trebuchet = gameObjects.get(missile.loadedInto);
    if (!trebuchet || trebuchet.aimedBy !== client.id) return;
    broadcastSfxStop(trebuchet.id);
    if (trebuchet.fireState !== ARM_STATE_AIMING) return;

    broadcastSfx("trebuchet_release", { x: trebuchet.x });
    updateTrebuchetAim(trebuchet, message.point);
    beginTrebuchetRelease(trebuchet);
  }

  if (message.action === "fire") {
    broadcast({
      type: "event",
      tick: 0,
      events: [{
        kind: "fire",
        playerId: client.playerId,
        start: message.start,
        end: message.end,
      }],
    });
  }
}
