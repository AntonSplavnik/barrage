const { ParticleSystem, Color4, Vector3 } = BABYLON;

export function createMissileTrailEffect(scene, sharedTextures, config) {
  const activeTrails = new Map();
  const pendingDisposals = new Set();

  const styleFactories = {
    wind: createWindTrail,
    dust: createDustTrail,
    blur: createBlurTrail,
  };

  function attachTrail(mesh) {
    if (activeTrails.has(mesh.uniqueId)) return;
    const cfg = config.trail;
    if (!cfg.enabled) return;

    const factory = styleFactories[cfg.style];
    if (!factory) return;

    const ps = factory(scene, mesh, sharedTextures, cfg[cfg.style]);
    ps.start();
    activeTrails.set(mesh.uniqueId, ps);
  }

  function scheduleDisposal(ps) {
    ps.stop();
    const timeoutId = setTimeout(() => {
      pendingDisposals.delete(timeoutId);
      ps.dispose(false);
    }, ps.maxLifeTime * 1000 + 100);
    pendingDisposals.add(timeoutId);
  }

  function detachTrail(mesh) {
    const ps = activeTrails.get(mesh.uniqueId);
    if (!ps) return;
    activeTrails.delete(mesh.uniqueId);
    scheduleDisposal(ps);
  }

  function syncTrails(missileIds, visualObjects) {
    if (!config.trail.enabled) {
      if (activeTrails.size > 0) clear();
      return;
    }

    const currentMissileSet = new Set(missileIds);

    for (const [meshId, ps] of activeTrails) {
      let found = false;
      for (const id of currentMissileSet) {
        const mesh = visualObjects.get(id);
        if (mesh && mesh.uniqueId === meshId) {
          found = true;
          break;
        }
      }
      if (!found) {
        activeTrails.delete(meshId);
        scheduleDisposal(ps);
      }
    }

    for (const id of missileIds) {
      const mesh = visualObjects.get(id);
      if (mesh && !activeTrails.has(mesh.uniqueId)) {
        attachTrail(mesh);
      }
    }
  }

  function clear() {
    for (const timeoutId of pendingDisposals) {
      clearTimeout(timeoutId);
    }
    pendingDisposals.clear();

    for (const ps of activeTrails.values()) {
      ps.stop();
      ps.dispose(false);
    }
    activeTrails.clear();
  }

  function dispose() {
    clear();
  }

  return { attachTrail, detachTrail, syncTrails, clear, dispose };
}

function createWindTrail(scene, mesh, textures, cfg) {
  const emitRate = cfg.count / (cfg.durationMs / 1000);
  const ps = new ParticleSystem("vfx_trail_wind", cfg.count * 2, scene);
  ps.particleTexture = textures.windStreak;
  ps.blendMode = ParticleSystem.BLENDMODE_ADD;
  ps.billboardMode = ParticleSystem.BILLBOARDMODE_STRETCHED;
  ps.renderingGroupId = 2;
  ps.disposeOnStop = false;

  ps.emitter = mesh;

  ps.minLifeTime = cfg.durationMs / 1000 * 0.6;
  ps.maxLifeTime = cfg.durationMs / 1000;
  ps.minSize = cfg.size;
  ps.maxSize = cfg.size;
  ps.minScaleX = cfg.scaleX;
  ps.maxScaleX = cfg.scaleX;
  ps.minEmitPower = cfg.speed * 0.5;
  ps.maxEmitPower = cfg.speed;
  ps.emitRate = emitRate;

  ps.color1 = new Color4(1, 1, 1, 0.8);
  ps.color2 = new Color4(0.9, 0.9, 0.9, 0.6);
  ps.colorDead = new Color4(1, 1, 1, 0);

  ps.gravity = new Vector3(0, cfg.gravity, 0);

  return ps;
}

function createDustTrail(scene, mesh, textures, cfg) {
  const emitRate = cfg.count / (cfg.durationMs / 1000);
  const ps = new ParticleSystem("vfx_trail_dust", cfg.count * 2, scene);
  ps.particleTexture = textures.smoke;
  ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
  ps.billboardMode = ParticleSystem.BILLBOARDMODE_ALL;
  ps.renderingGroupId = 2;
  ps.disposeOnStop = false;

  ps.emitter = mesh;
  ps.createSphereEmitter(0.1);

  ps.minLifeTime = cfg.durationMs / 1000 * 0.6;
  ps.maxLifeTime = cfg.durationMs / 1000;
  ps.minSize = cfg.size * 0.75;
  ps.maxSize = cfg.size * 1.5;
  ps.minEmitPower = cfg.speed * 0.7;
  ps.maxEmitPower = cfg.speed;
  ps.emitRate = emitRate;

  ps.color1 = new Color4(194 / 255, 164 / 255, 120 / 255, 0.6);
  ps.color2 = new Color4(194 / 255, 164 / 255, 120 / 255, 0.4);
  ps.colorDead = new Color4(194 / 255, 164 / 255, 120 / 255, 0);

  ps.gravity = new Vector3(0, cfg.gravity, 0);

  return ps;
}

function createBlurTrail(scene, mesh, textures, cfg) {
  const emitRate = cfg.count / (cfg.durationMs / 1000);
  const ps = new ParticleSystem("vfx_trail_blur", cfg.count * 2, scene);
  ps.particleTexture = textures.blur;
  ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
  ps.billboardMode = ParticleSystem.BILLBOARDMODE_ALL;
  ps.renderingGroupId = 2;
  ps.disposeOnStop = false;

  ps.emitter = mesh;

  ps.minLifeTime = cfg.durationMs / 1000 * 0.6;
  ps.maxLifeTime = cfg.durationMs / 1000;
  ps.minSize = cfg.size;
  ps.maxSize = cfg.size;
  ps.minEmitPower = cfg.speed;
  ps.maxEmitPower = cfg.speed;
  ps.emitRate = emitRate;

  ps.color1 = new Color4(140 / 255, 140 / 255, 140 / 255, 0.4);
  ps.color2 = new Color4(140 / 255, 140 / 255, 140 / 255, 0.3);
  ps.colorDead = new Color4(140 / 255, 140 / 255, 140 / 255, 0);

  ps.gravity = new Vector3(0, cfg.gravity, 0);

  return ps;
}
