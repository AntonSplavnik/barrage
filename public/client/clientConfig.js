export const CLIENT_CONFIG = {
  // Rendering
  importedLightIntensityScale: 1.0,
  shadowsEnabled: true,
  shadowMapSize: 2048,
  shadowBias: 0.0005,
  shadowNormalBias: 0.02,
  exposure: 1.0,
  contrast: 1.0,

  // Input
  inputInvertX: false,
  trebuchetInputInvertX: false,
  inputInvertY: false,
  inputInvertZ: false,
  cameraControlsEnabled: false,

  // Drag/release (client-side feel)
  dragHeightOffset: 0.2,
  missilePickColliderScale: 2,

  // Aim arrow visuals
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

  // Shot arc visuals
  shotArcDotCount: 32,
  shotArcDotSize: 0.18,
  shotArcFadeMs: 1500,
  shotArcZOffset: 0.08,
  shotArcDimColor: "#262626",
  shotArcBrightColor: "#ffffff",
};
