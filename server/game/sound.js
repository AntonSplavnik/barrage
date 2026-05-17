import { broadcast } from "../net/broadcast.js";
import { gameState } from "./state.js";

export function sfxEvent(effect, { speed = null, x = 0 } = {}) {
  return { kind: "sfx", effect, speed, x };
}

export function sfxStartEvent(effect, instanceId, { x = 0 } = {}) {
  return { kind: "sfxStart", effect, instanceId, x };
}

export function sfxStopEvent(instanceId) {
  return { kind: "sfxStop", instanceId };
}

export function broadcastSfx(effect, { speed = null, x = 0 } = {}) {
  broadcast({
    type: "event",
    tick: gameState.tick,
    events: [sfxEvent(effect, { speed, x })],
  });
}

export function broadcastSfxStart(effect, instanceId, { x = 0 } = {}) {
  broadcast({
    type: "event",
    tick: gameState.tick,
    events: [sfxStartEvent(effect, instanceId, { x })],
  });
}

export function broadcastSfxStop(instanceId) {
  broadcast({
    type: "event",
    tick: gameState.tick,
    events: [sfxStopEvent(instanceId)],
  });
}
