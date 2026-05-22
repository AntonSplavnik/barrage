export const CLIENT_CONFIG = {
  // Rendering
  importedLightIntensityScale: 1.0,
  shadowsEnabled: true,
  shadowMapSize: 2048,
  shadowBias: 0.0005,
  shadowNormalBias: 0.02,
  shadowLightIntensityScale: 3,
  pointShadowMapSize: 1024,
  exposure: 1.0,
  contrast: 1.1,

  // Input
  inputInvertX: false,
  trebuchetInputInvertX: false,
  inputInvertY: false,
  inputInvertZ: false,
  cameraControlsEnabled: false,

  // Drag/release (client-side feel)
  dragHeightOffset: 0.2,
  missilePickColliderScale: 2,

  // Shot arc visuals
  shotArcDotCount: 32,
  shotArcDotSize: 0.18,
  shotArcFadeMs: 1500,
  shotArcZOffset: 0.08,
  shotArcDimColor: "#262626",
  shotArcBrightColor: "#ffffff",
};
