export const PORT = Number(process.env.PORT || 3000);
export const TICK_RATE = 60;
export const TICK_MS = 1000 / TICK_RATE;

export const SERVER_CONFIG = {
  // Engine
  gravity: -9.81,
  groundY: 0,
  physicsTimeScale: 1.5,

  // World bounds
  worldMinX: -70,
  worldMaxX: 70,
  worldMinZ: -20,
  worldMaxZ: 20,

  // Physics defaults
  dynamicMass: 6,
  dynamicFriction: 0.9,
  dynamicRestitution: 0.15,
  blockMass: 10,
  blockFriction: 0.9,
  blockRestitution: 0.15,
  missileMass: 6,
  staticFriction: 1.0,

  // Trebuchet mechanics
  trebuchetArmRestRotationZDegrees: 15,
  trebuchetLeftMinX: -30,
  trebuchetLeftMaxX: -5,
  trebuchetRightMinX: 5,
  trebuchetRightMaxX: 30,
  missileLoadRange: 2,
  aimMaxPullDistance: 4.5,
  aimPowerScale: 8,
  trebuchetArmPullbackMaxDegrees: 75,
  trebuchetFireVelocityMax: 33,
  fireReleaseAnimationMs: 180,
  fireReturnAnimationMs: 220,
  normalReleaseVelocityMax: 8,
  releaseVelocityMax: 80,
  dragUprightLerp: 0.25,

  // Magnetic drag
  dragForceMax: 1000,
  dragRadiusLimit: 30,
  dragDampingMax: 400,

  // Drag speed validation
  maxDragSpeed: 5000,

  // Missile release depenetration
  depenetrationStep: 0.25,
  depenetrationMaxDistance: 60,
  missileReleaseFloorPadding: 0.05,

  // Fragments
  fragmentLifetimeMs: 5000,
  fragmentSpreadX: 4,
  fragmentSpreadY: 2,
  fragmentShrinkMs: 500,
  fragmentImmunityMs: 500,
  fragmentHitSpeedPenalty: 3,

  // Features (level-overridable)
  crackSystem: true,
  fragmentation: true,

  // Missiles
  missileDamageMinSpeed: 10,
  missileHitForce: 20,

  // Bombs
  bombBlastRadius: 5,
  bombMaxDamage: 3,
  bombMaxForce: 200,
  bombDetonationMinSpeed: 10,
};

let activeLevelConfig = null;

export function setActiveLevelConfig(config) {
  activeLevelConfig = config ?? null;
}

export function getConfig(key) {
  return activeLevelConfig?.[key] ?? SERVER_CONFIG[key];
}

const CLIENT_RELEVANT_KEYS = [
  "trebuchetArmRestRotationZDegrees",
  "aimMaxPullDistance",
  "fragmentShrinkMs",
];

export function getClientRelevantConfig() {
  const result = {};
  for (const key of CLIENT_RELEVANT_KEYS) {
    result[key] = getConfig(key);
  }
  return result;
}
