const { DynamicTexture, StandardMaterial, Color3 } = BABYLON;

export function createSharedTextures(scene) {
  const explosion = createExplosionTexture(scene);
  const smoke = createSmokeTexture(scene);
  const spark = createSparkTexture(scene);
  const fragmentMaterial = createFragmentMaterial(scene);
  const fragment = createFragmentTexture(scene);
  const windStreak = createWindStreakTexture(scene);
  const blur = createBlurTexture(scene);

  function dispose() {
    explosion.dispose();
    smoke.dispose();
    spark.dispose();
    fragment.dispose();
    fragmentMaterial.dispose();
    windStreak.dispose();
    blur.dispose();
  }

  return { explosion, smoke, spark, fragment, fragmentMaterial, windStreak, blur, dispose };
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

function createFragmentTexture(scene) {
  const cell = 64;
  const tex = new DynamicTexture("vfx_fragment", { width: cell * 2, height: cell * 2 }, scene, false);
  const ctx = tex.getContext();

  const seeds = [
    { points: 5, seed: 3.7, radiusVar: 0.35 },
    { points: 7, seed: 17.3, radiusVar: 0.4 },
    { points: 6, seed: 11.1, radiusVar: 0.45 },
    { points: 8, seed: 7.9, radiusVar: 0.3 },
  ];

  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 2; col++) {
      const idx = row * 2 + col;
      const ox = col * cell;
      const oy = row * cell;
      const cx = ox + cell / 2;
      const cy = oy + cell / 2;
      const { points, seed, radiusVar } = seeds[idx];
      const baseRadius = cell * 0.38;

      ctx.beginPath();
      for (let i = 0; i < points; i++) {
        const angle = (i / points) * Math.PI * 2 + seed;
        const r = baseRadius * (1 - radiusVar + Math.sin(i * seed) * radiusVar);
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();

      const grad = ctx.createRadialGradient(cx - 3, cy - 3, 0, cx, cy, baseRadius);
      grad.addColorStop(0, "rgba(255,255,255,1)");
      grad.addColorStop(0.5, "rgba(220,220,220,1)");
      grad.addColorStop(0.85, "rgba(180,180,180,0.9)");
      grad.addColorStop(1, "rgba(140,140,140,0)");
      ctx.fillStyle = grad;
      ctx.fill();
    }
  }

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

function createWindStreakTexture(scene) {
  const tex = new DynamicTexture("vfx_windStreak", { width: 8, height: 64 }, scene, false);
  const ctx = tex.getContext();
  const grad = ctx.createLinearGradient(4, 0, 4, 64);
  grad.addColorStop(0, "rgba(255,255,255,0)");
  grad.addColorStop(0.3, "rgba(255,255,255,0.8)");
  grad.addColorStop(0.7, "rgba(255,255,255,0.8)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 8, 64);
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

function createBlurTexture(scene) {
  const tex = new DynamicTexture("vfx_blur", 32, scene, false);
  const ctx = tex.getContext();
  const cx = 16, cy = 16;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 16);
  grad.addColorStop(0, "rgba(140,140,140,0.4)");
  grad.addColorStop(0.6, "rgba(140,140,140,0.2)");
  grad.addColorStop(1, "rgba(140,140,140,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 32, 32);
  tex.update();
  tex.hasAlpha = true;
  return tex;
}
