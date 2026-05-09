export const BARRAGE_CONFIG = {
  // Level asset.
  levelUrl: "/assets/level1.glb",
  musicTuneUrl: "/strudel.js",
  musicSamplesUrl: "https://raw.githubusercontent.com/felixroos/dough-samples/main/tidal-drum-machines.json",

  // Rendering.
  importedLightIntensityScale: 0.01,      // multiplier
  fallbackLightIntensity: 0.1,            // multiplier
  shadowsEnabled: true,
  shadowMapSize: 2048,                    // px
  shadowBias: 0.0005,
  shadowNormalBias: 0.02,
  exposure: 1.0,                          // multiplier
  contrast: 1.0,                          // multiplier

  // Basic physics tuning.
  physicsEnabled: true,
  gravity: -9.81,                         // m/s²
  physicsTimeScale: 1.5,                  // multiplier (>1 = faster sim)
  blockMass: 30,                          // kg
  missileMass: 10,                         // kg
  blockFriction: 0.9,                     // 0–1
  blockRestitution: 0.15,                 // 0–1 (bounciness)
  staticFriction: 1.0,                    // 0–1

  // Pointer/camera controls.
  inputInvertX: true,
  trebuchetInputInvertX: true,
  inputInvertY: false,
  inputInvertZ: false,
  cameraControlsEnabled: false,

  // Trebuchet body movement limits.
  trebuchetLeftMinX: -30,                 // m
  trebuchetLeftMaxX: -5,                  // m
  trebuchetRightMinX: 5,                  // m
  trebuchetRightMaxX: 30,                 // m

  // Drag/release behavior for hand-moved objects.
  dragHeightOffset: 0.2,                  // m
  dragUprightLerp: 0.25,                  // 0–1 per frame
  releaseVelocityScale: 1.0,              // multiplier
  normalReleaseVelocityMax: 8,            // m/s
  releaseVelocitySampleHz: 60,            // Hz
  releaseVelocityFrameWindow: 5,          // frames
  releaseVelocityMinSampleDistance: 0.05, // m

  // Zone rules.
  noMansLandX: 5,                         // m (half-width of centre dead zone)
  kingKnockoutAngle: 45,                  // deg
  blockMaxHits: 5,                        // hits before fragmentation
  blockHitVelocityMin: 10,                 // m/s (min speed to register a hit)
  blockHitCooldownMs: 83,                // ms — missile can only crack one block per this window
  blockFragmentVelocityMin: 5,           // m/s (min speed to trigger fragmentation)
  fragmentHitVelocityMin: 5,             // m/s (min speed to destroy a fragment)
  fragmentHitSpeedPenalty: 3,            // m/s lost per fragment hit (on top of physics)
  fragmentFriction: 0.02,                 // 0–1 (lower = slides more)
  fragmentSpreadX: 4,                    // m/s max random horizontal scatter
  fragmentSpreadY: 2,                    // m/s max random upward scatter
  fragmentShrinkMs: 500,                  // ms
  fragmentImmunityMs: 500,                // ms — newly spawned fragments are immune to hits
  postWinSimulationMs: 5000,              // ms
  roundEndDelayMs: 5000,                  // ms

  // Missile loading.
  missileLoadRange: 3,                    // m
  missilePickColliderScale: 4,            // multiplier on visual collider radius

  // Trebuchet firing.
  trebuchetArmRestRotationZDegrees: 15,   // deg
  aimMaxPullDistance: 8,               // m
  aimPowerScale: 8,                       // multiplier
  trebuchetArmPullbackMaxDegrees: 75,     // deg
  trebuchetFireVelocityMax: 40,           // m/s
  fireReleaseAnimationMs: 150,            // ms
  fireReturnAnimationMs: 220,             // ms
  musicKickVoiceFlightVelocityMin: 10,    // m/s
  aimArrowStartColor: "#ffffff",
  aimArrowEndColor: "#1ecb00",
  aimArrowMaxLength: 8,                 // m
  aimArrowRadius: 0.1,                   // m
  aimArrowZOffset: 0.05,                  // m
  aimArrowMinLength: 0.12,                // m
  aimArrowHeadLengthMin: 0.2,             // m
  aimArrowHeadLengthMax: 0.75,            // m
  aimArrowHeadLengthScale: 0.18,          // multiplier of arrow length
  aimArrowHeadWidth: 0.4,               // m
  aimArrowHeadWidthScale: 1,           // multiplier of arrow length

  // Camera.
  cameraVFov: 0.4,                      // rad — vertical field of view (22.9°)

  // Camera viewport boundaries (world-space, action plane at Z=0).
  // Camera Z is computed so this width exactly fills the canvas horizontally.
  // Camera Y is computed so viewportBottomY sits at the bottom screen edge.
  viewportBfXMin: -45,                  // m
  viewportBfXMax: 45,                   // m
  viewportP1XMin: -45,                  // m
  viewportP1XMax: 5,                    // m
  viewportP2XMin: -5,                   // m
  viewportP2XMax: 45,                   // m
  viewportBottomY: -5,                  // m

  // Camera animation timing.
  cameraInitialPanMs: 4000,             // ms — battlefield → player on level load
  cameraAimZoomOutMs: 700,              // ms — player → battlefield when aiming
  cameraReturnDelayMs: 4000,            // ms — wait after shot fires before panning back
  cameraReturnMs: 2000,                 // ms — battlefield → player after shot
};

if (typeof window !== "undefined") {
  window.BARRAGE_CONFIG = BARRAGE_CONFIG;
}
