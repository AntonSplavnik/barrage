export const BARRAGE_CONFIG = {
  // Level asset.
  levelUrl: "/assets/level1.glb",
  musicTuneUrl: "/strudel.js",
  musicSamplesUrl: "https://raw.githubusercontent.com/felixroos/dough-samples/main/tidal-drum-machines.json",

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
  physicsTimeScale: 1.5,
  blockMass: 20,
  blockFriction: 0.9,
  blockRestitution: 0.15,
  staticFriction: 1.0,

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
  dragUprightLerp: 0.25,
  releaseVelocityScale: 1.0,
  normalReleaseVelocityMax: 8,
  releaseVelocitySampleHz: 60,
  releaseVelocityFrameWindow: 5,
  releaseVelocityMinSampleDistance: 0.05,

  // Missile loading.
  missileLoadRange: 2,
  missilePickColliderScale: 2,

  // Trebuchet firing.
  trebuchetArmRestRotationZDegrees: 15,
  aimMaxPullDistance: 4.5,
  aimPowerScale: 8,
  trebuchetArmPullbackMaxDegrees: 75,
  trebuchetFireVelocityMax: 33,
  fireReleaseAnimationMs: 180,
  fireReturnAnimationMs: 220,
  musicKickVoiceFlightVelocityMin: 10,
  aimArrowStartColor: "#ffffff",
  aimArrowEndColor: "#39ff14",
  aimArrowMaxLength: 4.5,
  aimArrowRadius: 0.06,
  aimArrowZOffset: 0.05,
  aimArrowMinLength: 0.12,
  aimArrowHeadLengthMin: 0.2,
  aimArrowHeadLengthMax: 0.75,
  aimArrowHeadLengthScale: 0.18,
  aimArrowHeadWidth: 0.12,
  aimArrowHeadWidthScale: 0.45,
};

if (typeof window !== "undefined") {
  window.BARRAGE_CONFIG = BARRAGE_CONFIG;
}
