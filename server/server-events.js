function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function soundEffectEvent(effect, position = {}, overrides = {}) {
  return {
    kind: "soundEffect",
    effect,
    x: Number(position.x ?? 0),
    y: Number(position.y ?? 0),
    z: Number(position.z ?? 0),
    ...overrides,
  };
}

export function soundEffectStartEvent(effect, instanceId, position = {}, overrides = {}) {
  return {
    ...soundEffectEvent(effect, position, overrides),
    kind: "soundEffectStart",
    instanceId,
  };
}

export function soundEffectStopEvent(effect, instanceId) {
  return {
    kind: "soundEffectStop",
    effect,
    instanceId,
  };
}

export function impactPositionFor(object, other = null) {
  if (!other) return object;

  return {
    x: ((object.x ?? 0) + (other.x ?? 0)) / 2,
    y: ((object.y ?? 0) + (other.y ?? 0)) / 2,
    z: ((object.z ?? 0) + (other.z ?? 0)) / 2,
  };
}

export function relativeSpeedFor(object, other = null) {
  return Math.hypot(
    (object.vx ?? 0) - (other?.vx ?? 0),
    (object.vy ?? 0) - (other?.vy ?? 0),
    (object.vz ?? 0) - (other?.vz ?? 0),
  );
}

export function captureImpactVelocities(objects, { velocityFor } = {}) {
  for (const object of objects) {
    const velocity = velocityFor?.(object) ?? object;
    object.impactVx = velocity.x ?? velocity.vx ?? 0;
    object.impactVy = velocity.y ?? velocity.vy ?? 0;
    object.impactVz = velocity.z ?? velocity.vz ?? 0;
  }
}

export function impactSpeedFor(object, other = null) {
  return Math.hypot(
    (object.impactVx ?? object.vx ?? 0) - (other?.impactVx ?? other?.vx ?? 0),
    (object.impactVy ?? object.vy ?? 0) - (other?.impactVy ?? other?.vy ?? 0),
    (object.impactVz ?? object.vz ?? 0) - (other?.impactVz ?? other?.vz ?? 0),
  );
}


export function impactSoundKey(effect, ...ids) {
  return [effect, ...ids.filter(Boolean).sort()].join(":");
}

export function shouldEmitImpactSound(cache, key, tick, cooldownTicks) {
  if (cooldownTicks <= 0) return true;
  if (tick - (cache.get(key) ?? -Infinity) < cooldownTicks) return false;

  cache.set(key, tick);
  return true;
}

export function createSoundEventDispatcher({
  broadcast,
  config,
  getActiveRoom,
  getImpactSoundTicks,
  getTick,
  tickMs,
}) {
  function broadcastSoundEffect(effect, position = {}, overrides = {}) {
    const activeRoom = getActiveRoom?.();
    if (!activeRoom) return;

    broadcast({
      type: "event",
      roomId: activeRoom.id,
      tick: getTick?.() ?? 0,
      events: [soundEffectEvent(effect, position, overrides)],
    });
  }

  function broadcastSoundEffectStart(effect, instanceId, position = {}, overrides = {}) {
    const activeRoom = getActiveRoom?.();
    if (!activeRoom) return;

    broadcast({
      type: "event",
      roomId: activeRoom.id,
      tick: getTick?.() ?? 0,
      events: [soundEffectStartEvent(effect, instanceId, position, overrides)],
    });
  }

  function broadcastSoundEffectStop(effect, instanceId) {
    const activeRoom = getActiveRoom?.();
    if (!activeRoom) return;

    broadcast({
      type: "event",
      roomId: activeRoom.id,
      tick: getTick?.() ?? 0,
      events: [soundEffectStopEvent(effect, instanceId)],
    });
  }

  function broadcastImpactSoundEffect(effect, position, impactSpeed, overrides = {}) {
    broadcastSoundEffect(effect, position, { impactSpeed, ...overrides });
  }

  function maybeBroadcastObjectImpactSound(effect, object, other, impactSpeed, hitPosition = null) {
    const impactSoundTicks = getImpactSoundTicks?.();
    if (!impactSoundTicks) return;

    const minSpeed = config.impactSoundVelocityMin ?? 1.5;
    if (impactSpeed < minSpeed) return;

    const effectCooldownMs = config.soundEffects?.[effect]?.cooldownMs;
    const cooldownTicks = Math.ceil((effectCooldownMs ?? config.impactSoundCooldownMs ?? 0) / tickMs);
    const key = impactSoundKey(effect, object.id, other?.id);
    if (!shouldEmitImpactSound(impactSoundTicks, key, getTick?.() ?? 0, cooldownTicks)) return;

    broadcastImpactSoundEffect(effect, hitPosition ?? impactPositionFor(object, other), impactSpeed);
  }

  function maybeBroadcastGroundImpactSound(effect, object, ground, hitPosition = null) {
    const impactSpeed = Math.abs(object.impactVy ?? object.vy ?? 0);
    maybeBroadcastObjectImpactSound(effect, object, ground, impactSpeed, hitPosition ?? object);
  }

  function stopTrebuchetStretchSound(trebuchet) {
    if (!trebuchet?.stretchSoundActive) return;

    trebuchet.stretchSoundActive = false;
    broadcastSoundEffectStop("trebuchet_stretch", trebuchet.id);
  }

  return {
    broadcastImpactSoundEffect,
    broadcastSoundEffect,
    broadcastSoundEffectStart,
    broadcastSoundEffectStop,
    maybeBroadcastGroundImpactSound,
    maybeBroadcastObjectImpactSound,
    stopTrebuchetStretchSound,
  };
}
