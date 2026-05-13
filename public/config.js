export const BARRAGE_CONFIG = {
  // Assets.
  levelUrl: "/assets/level1.glb",

  // Music.
  musicTuneUrl: "/strudel.js",
  musicSamplesUrl: "https://raw.githubusercontent.com/felixroos/dough-samples/main/tidal-drum-machines.json",
  musicVolume: 1.0,
  musicKickVoiceFlightVelocityMin: 10,    // m/s

  // Sound.
  soundEffectsEnabledByDefault: true,
  soundEffectTrackVolume: 1.0,
  soundEffectPitchRandomization: 0.2,     // +/- fraction applied to every SFX pitch
  soundPanWorldMinX: -45,                 // world x mapped to full left
  soundPanWorldMaxX: 45,                  // world x mapped to full right
  impactSoundVelocityMin: 1.5,            // m/s (quietest dynamic impact sound)
  impactSoundVelocityMax: 24,             // m/s (loudest dynamic impact sound)
  impactSoundVolumeMinScale: 0.2,         // multiplier of effect volume at min speed
  impactSoundVolumeMaxScale: 1.0,         // multiplier of effect volume at max speed
  impactSoundCooldownMs: 120,             // ms between repeat impact sounds per pair/object
  soundEffects: {
    trebuchet_release: { file: "/sounds/trebuchet_release.mp3", volume: 0.75, pan: 0, pitch: 1.0 },
    trebuchet_stretch: { file: "/sounds/trebuche-stretch.mp3", volume: 0.7, pan: 0, pitch: 1.0 },
    block_hit_ground: { file: "/sounds/block_hit_ground.mp3", volume: 0.55, pan: 0, pitch: 0.9 },
    block_hit_block: { file: "/sounds/block-hit-block.mp3", volume: 0.65, pan: 0, pitch: 0.95, cooldownMs: 220 },
    missile_hit_ground: { file: "/sounds/missile-hit-ground.mp3", volume: 0.55, pan: 0, pitch: 1.0, cooldownMs: 180 },
    missile_hit_block: { file: "/sounds/missile_hit_block.mp3", volume: 0.65, pan: 0, pitch: 0.98, cooldownMs: 220 },
    missile_hit_missile: { file: "/sounds/missile-hit-missile.mp3", volume: 0.65, pan: 0, pitch: 1.0 },
    missile_hit_trebuchet: { file: "/sounds/missile_hit_trebuchet.mp3", volume: 0.8, pan: 0, pitch: 0.92, cooldownMs: 220 },
    missile_fragments_block: { file: "/sounds/missile_fragments_block.mp3", volume: 0.95, pan: 0, pitch: 0.96 },
    missile_hits_fragment: { file: "/sounds/missile_hits_fragment.mp3", volume: 0.7, pan: 0, pitch: 1.04 },
    king_hit: { file: "/sounds/king_hit.mp3", volume: 1.0, pan: 0, pitch: 1.0 },
  },

  // VFX.
  vfxInvertX: true,
  vfxMissileHitBlockCount: 3,
  vfxMissileHitBlockDurationMs: 1200,
  vfxMissileHitBlockParticleSpeed: 15.0,
  vfxMissileHitBlockGravity: -7.5,
  vfxMissileHitBlockSize: 0.5,
  vfxMissileHitBlockMinScale: 0.1,

  // Rendering.
  importedLightIntensityScale: 0.01,      // multiplier
  fallbackLightIntensity: 0.1,            // multiplier
  shadowsEnabled: true,
  shadowMapSize: 2048,                    // px
  shadowBlurEnabled: true,
  shadowBlurKernel: 16,
  renderMaxHeightPx: 900,                // px, cap internal render height while keeping fullscreen CSS size
  shadowBias: 0.0005,
  shadowNormalBias: 0.02,
  exposure: 1.0,                          // multiplier
  contrast: 1.0,                          // multiplier

  // Physics.
  physicsEnabled: true,
  gravity: -9.81,                         // m/s²
  physicsTimeScale: 1.5,                  // multiplier (>1 = faster sim)
  blockMass: 30,                          // kg
  missileMass: 10,                         // kg
  missileLinearDamping: 0.15,             // Havok linear damping for missiles
  blockFriction: 0.9,                     // 0–1
  blockRestitution: 0.15,                 // 0–1 (bounciness)
  staticFriction: 1.0,                    // 0–1

  // Input.
  inputInvertX: true,
  trebuchetInputInvertX: true,
  inputInvertY: false,
  inputInvertZ: false,
  cameraControlsEnabled: false,

  // Trebuchet Movement.
  trebuchetLeftMinX: -30,                 // m
  trebuchetLeftMaxX: -5,                  // m
  trebuchetRightMinX: 5,                  // m
  trebuchetRightMaxX: 30,                 // m

  // Drag And Release.
  dragHeightOffset: 0.2,                  // m
  dragRadiusLimit: 20,                     // m, magnetic grip reaches zero force at this distance
  dragForceMax: 1500,                      // N, magnetic grip force at zero distance
  dragDampingMax: 400,                     // N per m/s, strongest near the magnetic grip point
  blockAngularDamping: 0.8,              // rotational damping for block physics bodies
  dragPivotMarkerSize: 1.1,               // m, visual hand marker at magnetic drag pivot
  releaseVelocityScale: 1.0,              // multiplier
  normalReleaseVelocityMax: 8,            // m/s
  releaseVelocitySampleHz: 60,            // Hz
  releaseVelocityFrameWindow: 5,          // frames
  releaseVelocityMinSampleDistance: 0.05, // m

  // Gameplay Rules.
  noMansLandX: 5,                         // m (half-width of centre dead zone)
  kingKnockoutAngle: 45,                  // deg
  blockMaxHits: 5,                        // hits before fragmentation
  kingHitVelocityMin: 3,                  // m/s (min speed to register a king hit)
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

  // Missile Loading.
  missileLoadRange: 3,                    // m
  missilePickColliderScale: 4,            // multiplier on visual collider radius

  // Trebuchet Firing.
  trebuchetArmRestRotationZDegrees: 15,   // deg
  aimMaxPullDistance: 8,               // m
  aimPowerScale: 8,                       // multiplier
  trebuchetArmPullbackMaxDegrees: 75,     // deg
  trebuchetFireVelocityMax: 40,           // m/s
  fireReleaseAnimationMs: 150,            // ms
  fireReturnAnimationMs: 220,             // ms

  // Aim Arrow.
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

  // Shot Arc Prediction.
  shotArcFraction: 0.67,                  // fraction of predicted flight path to draw
  shotArcDotCount: 34,                    // number of dotted trajectory points
  shotArcDotSize: 0.25,                   // m
  shotArcMaxDuration: 4,                  // s
  shotArcFadeMs: 1500,                    // ms fade after firing
  shotArcVelocityMin: 0.5,                // m/s
  shotArcGroundY: 0,                      // m
  shotArcZOffset: 0.08,                   // m, renders dots in front of action plane

  // Camera.
  cameraVFov: 0.4,                      // rad — vertical field of view (22.9°)

  // Camera Viewport.
  // World-space, action plane at Z=0.
  // Camera Z is computed so this width exactly fills the canvas horizontally.
  // Camera Y is computed so viewportBottomY sits at the bottom screen edge.
  viewportBfXMin: -45,                  // m
  viewportBfXMax: 45,                   // m
  viewportP1XMin: -45,                  // m
  viewportP1XMax: 5,                    // m
  viewportP2XMin: -5,                   // m
  viewportP2XMax: 45,                   // m
  viewportBottomY: -5,                  // m

  // Camera Animation.
  cameraInitialPanMs: 4000,             // ms — battlefield → player on level load
  cameraAimZoomOutMs: 700,              // ms — player → battlefield when aiming
  cameraDragViewBlend: 0.4,             // 0–1, battlefield → player interpolation for drag view
  cameraDragViewMs: 1000,                // ms — player → drag view when dragging
  cameraDragReturnDelayMs: 5000,        // ms — wait at drag view before returning to player
  cameraDragReturnMs: 1200,             // ms — drag view → player after dragging
  cameraReturnDelayMs: 4000,            // ms — wait after shot fires before panning back
  cameraReturnMs: 2000,                 // ms — battlefield → player after shot
};

if (typeof window !== "undefined") {
  window.BARRAGE_CONFIG = BARRAGE_CONFIG;
}
