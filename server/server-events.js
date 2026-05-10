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

export function captureImpactVelocities(objects, { velocityFor, boundsFor } = {}) {
  for (const object of objects) {
    const velocity = velocityFor?.(object) ?? object;
    const bounds = boundsFor?.(object);
    object.impactVx = velocity.x ?? velocity.vx ?? 0;
    object.impactVy = velocity.y ?? velocity.vy ?? 0;
    object.impactVz = velocity.z ?? velocity.vz ?? 0;
    object.impactMinY = bounds?.minY;
  }
}

export function impactSpeedFor(object, other = null) {
  return Math.hypot(
    (object.impactVx ?? object.vx ?? 0) - (other?.impactVx ?? other?.vx ?? 0),
    (object.impactVy ?? object.vy ?? 0) - (other?.impactVy ?? other?.vy ?? 0),
    (object.impactVz ?? object.vz ?? 0) - (other?.impactVz ?? other?.vz ?? 0),
  );
}

export function impactVolumeFor(config, effect, impactSpeed) {
  const minSpeed = config.impactSoundVelocityMin ?? 1.5;
  const maxSpeed = Math.max(minSpeed, config.impactSoundVelocityMax ?? 24);
  const minScale = config.impactSoundVolumeMinScale ?? 0.2;
  const maxScale = config.impactSoundVolumeMaxScale ?? 1.0;
  const baseVolume = config.soundEffects?.[effect]?.volume ?? 1;
  const t = maxSpeed === minSpeed ? 1 : clamp((impactSpeed - minSpeed) / (maxSpeed - minSpeed), 0, 1);

  return baseVolume * lerp(minScale, maxScale, t);
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
