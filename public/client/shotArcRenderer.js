const { Color3, Matrix, MeshBuilder, StandardMaterial } = BABYLON;

export function createShotArcRenderer(scene, config) {
  const dotCount = config.shotArcDotCount ?? 32;
  const dotSize = config.shotArcDotSize ?? 0.14;
  const zOffset = config.shotArcZOffset ?? 0.08;
  const dimColor = Color3.FromHexString(config.shotArcDimColor ?? "#262626");
  const brightColor = Color3.FromHexString(config.shotArcBrightColor ?? "#ffffff");

  const material = new StandardMaterial("ShotArcMat", scene);
  material.disableLighting = true;
  material.disableDepthWrite = true;
  material.emissiveColor = dimColor.clone();
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();

  const baseMesh = MeshBuilder.CreateSphere("ShotArcDot", {
    diameter: dotSize,
    segments: 8,
  }, scene);
  baseMesh.material = material;
  baseMesh.isPickable = false;
  baseMesh.renderingGroupId = 2;
  baseMesh.alwaysSelectAsActiveMesh = true;
  baseMesh.setEnabled(false);

  baseMesh.thinInstanceCount = 0;

  let fadeObserver = null;
  let showing = false;

  function cancelFade() {
    if (fadeObserver) {
      scene.onBeforeRenderObservable.remove(fadeObserver);
      fadeObserver = null;
    }
    material.alpha = 1;
  }

  function update(points, powerRatio) {
    if (!points || points.length === 0) {
      hide();
      return;
    }

    cancelFade();

    const count = Math.min(points.length, dotCount);
    const buffer = new Float32Array(count * 16);

    for (let i = 0; i < count; i++) {
      const p = points[i];
      const m = Matrix.Translation(p.x, p.y, p.z + zOffset);
      m.copyToArray(buffer, i * 16);
    }

    baseMesh.thinInstanceSetBuffer("matrix", buffer, 16, false);
    baseMesh.thinInstanceCount = count;

    const t = Math.min(1, Math.max(0, powerRatio));
    material.emissiveColor.r = dimColor.r + (brightColor.r - dimColor.r) * t;
    material.emissiveColor.g = dimColor.g + (brightColor.g - dimColor.g) * t;
    material.emissiveColor.b = dimColor.b + (brightColor.b - dimColor.b) * t;

    baseMesh.setEnabled(true);
    showing = true;
  }

  function fadeOut(durationMs) {
    const fadeDuration = durationMs ?? config.shotArcFadeMs ?? 1500;
    cancelFade();
    if (!showing) return;

    const startTime = performance.now();

    fadeObserver = scene.onBeforeRenderObservable.add(() => {
      const elapsed = performance.now() - startTime;
      const t = Math.min(elapsed / fadeDuration, 1);
      material.alpha = 1 - t;

      if (t >= 1) {
        hide();
      }
    });
  }

  function hide() {
    cancelFade();
    baseMesh.setEnabled(false);
    showing = false;
  }

  function dispose() {
    cancelFade();
    baseMesh.dispose();
    material.dispose();
  }

  function isShowing() {
    return showing;
  }

  return { update, fadeOut, hide, dispose, isShowing };
}
