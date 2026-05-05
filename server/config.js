export const PORT = Number(process.env.PORT || 3000);
export const TICK_RATE = 60;
export const TICK_MS = 1000 / TICK_RATE;
export const LEVEL_FILE = "level1.glb";

export const SERVER_CONFIG = {
  gravity: -9.81,
  groundY: 0,
  worldMinX: -70,
  worldMaxX: 70,
  worldMinZ: -20,
  worldMaxZ: 20,
  dynamicMass: 6,
  dynamicFriction: 0.9,
  dynamicRestitution: 0.15,
  collisionIterations: 3,
  releaseVelocityMax: 80,
  pushedTrebuchetVelocityScale: 0.25,
  trebuchetReleaseFriction: 1.8,
};
