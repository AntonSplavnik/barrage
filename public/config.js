export const BARRAGE_CONFIG = {
  // Level asset.
  levelUrl: "/assets/level1.glb",

  // Rendering.
  importedLightIntensityScale: 0.01,
  fallbackLightIntensity: 0.1,
  shadowsEnabled: true,
  shadowMapSize: 2048,
  shadowBias: 0.0005,
  shadowNormalBias: 0.02,
  exposure: 1.0,
  contrast: 1.0,

  // Basic physics tuning.
  physicsEnabled: true,
  gravity: -9.81,
  blockMass: 6,
  blockFriction: 0.9,
  blockRestitution: 0.15,
  staticFriction: 1.0,
  impactVelocityTransfer: 0.75,
  impactSpinScale: 10,
  angularDamping: 1.4,
  maxAngularVelocity: 540,

  // Pointer/camera controls.
  inputInvertX: true,
  trebuchetInputInvertX: true,
  inputInvertY: false,
  inputInvertZ: false,
  cameraControlsEnabled: false,

  // Trebuchet body movement limits.
  trebuchetLeftMinX: -30,
  trebuchetLeftMaxX: -5,
  trebuchetRightMinX: 5,
  trebuchetRightMaxX: 30,

  // Drag/release behavior for hand-moved objects.
  dragHeightOffset: 0.2,
  releaseVelocityScale: 1.0,
  normalReleaseVelocityMax: 8,
  releaseVelocitySampleHz: 60,
  releaseVelocityFrameWindow: 5,
  releaseVelocityMinSampleDistance: 0.05,

  // Missile loading.
  missileLoadRange: 0.5,

  // Trebuchet firing.
  trebuchetArmRestRotationZDegrees: 15,
  aimMaxPullDistance: 8,
  aimPowerScale: 4,
  trebuchetArmPullbackMaxDegrees: 80,
  trebuchetFireVelocityMax: 28,
  fireReleaseAnimationMs: 180,
  fireReturnAnimationMs: 220,
};

if (typeof window !== "undefined") {
  window.BARRAGE_CONFIG = BARRAGE_CONFIG;
}
