const { DynamicTexture, StandardMaterial, Color3 } = BABYLON;

export function createSharedTextures(scene) {
  const explosion = createExplosionTexture(scene);
  const smoke = createSmokeTexture(scene);
  const spark = createSparkTexture(scene);
  const fragmentMaterial = createFragmentMaterial(scene);

  function dispose() {
    explosion.dispose();
    smoke.dispose();
    spark.dispose();
    fragmentMaterial.dispose();
  }

  return { explosion, smoke, spark, fragmentMaterial, dispose };
}

function createExplosionTexture(scene) {
  const tex = new DynamicTexture("vfx_explosion", 64, scene, false);
  const ctx = tex.getContext();
  const cx = 32, cy = 32;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.3, "rgba(255,160,40,1)");
  grad.addColorStop(0.7, "rgba(200,50,10,1)");
  grad.addColorStop(1, "rgba(100,20,0,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

function createSmokeTexture(scene) {
  const tex = new DynamicTexture("vfx_smoke", 64, scene, false);
  const ctx = tex.getContext();
  const cx = 32, cy = 32;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 32);
  grad.addColorStop(0, "rgba(60,60,60,0.7)");
  grad.addColorStop(0.6, "rgba(80,80,80,0.3)");
  grad.addColorStop(1, "rgba(100,100,100,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

function createSparkTexture(scene) {
  const tex = new DynamicTexture("vfx_spark", { width: 8, height: 64 }, scene, false);
  const ctx = tex.getContext();
  const grad = ctx.createLinearGradient(4, 0, 4, 64);
  grad.addColorStop(0, "rgba(255,220,80,0)");
  grad.addColorStop(0.3, "rgba(255,240,120,1)");
  grad.addColorStop(0.7, "rgba(255,240,120,1)");
  grad.addColorStop(1, "rgba(255,220,80,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 8, 64);
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

function createFragmentMaterial(scene) {
  const mat = new StandardMaterial("vfx_fragmentMat", scene);
  mat.diffuseColor = new Color3(0.35, 0.35, 0.35);
  mat.emissiveColor = new Color3(0.18, 0.18, 0.18);
  mat.specularColor = new Color3(0, 0, 0);
  return mat;
}
