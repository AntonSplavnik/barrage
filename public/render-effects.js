export function applyRenderResolutionLimit(engine, config = {}) {
  const maxHeightPx = Math.max(1, config.renderMaxHeightPx ?? Number.POSITIVE_INFINITY);
  const dpr = Math.max(0.1, window.devicePixelRatio || 1);
  const targetHeightPx = window.innerHeight * dpr;
  engine.setHardwareScalingLevel(Math.max(1, targetHeightPx / maxHeightPx));
}
