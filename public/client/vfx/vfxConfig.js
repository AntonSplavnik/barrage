export const VFX_CONFIG = {
  invertX: false,
  impactSpeedMin: 1.5,
  impactSpeedMax: 24,

  missileHit: {
    count: 5,
    durationMs: 900,
    speed: 25,
    gravity: -7.5,
    size: 1.5,
    minScale: 0.4,
  },

  explosion: {
    fire:   { count: 40, durationMs: 500, speed: 14, size: 1.8, gravity: -4 },
    smoke:  { count: 28, durationMs: 2200, speed: 2.5, size: 5, gravity: 1.8 },
    sparks: { count: 60, durationMs: 900, speed: 18, size: 0.22, gravity: -14, width: 0.12 },
    fragments: true,
  },
};
