const { ParticleSystem, Color4, Vector3 } = BABYLON;

export function createExplosionEffect(scene, sharedTextures, config, deps) {
  const activeSystems = new Set();
  const pendingTimeouts = new Set();

  function spawn(position, evt) {
    const radius = evt.radius ?? 2;
    const cfg = config.explosion;

    spawnFire(position, radius, cfg.fire);
    spawnSmoke(position, cfg.smoke);
    spawnSparks(position, cfg.sparks);

    if (cfg.fragments && deps?.missileHit) {
      deps.missileHit.spawn(position, { speed: config.impactSpeedMax });
    }
  }

  function spawnFire(position, radius, cfg) {
    const ps = new ParticleSystem("vfx_fire", cfg.count, scene);
    ps.particleTexture = sharedTextures.explosion;
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.renderingGroupId = 2;

    ps.emitter = position.clone();
    ps.createSphereEmitter(radius * 0.4);

    ps.minLifeTime = cfg.durationMs / 1000 * 0.6;
    ps.maxLifeTime = cfg.durationMs / 1000;
    ps.minSize = cfg.size * 0.5;
    ps.maxSize = cfg.size;
    ps.minEmitPower = cfg.speed * 0.6;
    ps.maxEmitPower = cfg.speed;
    ps.emitRate = cfg.count / 0.05;

    ps.color1 = new Color4(1, 1, 1, 1);
    ps.color2 = new Color4(1, 0.6, 0.15, 1);
    ps.colorDead = new Color4(0.4, 0.05, 0, 0);

    ps.gravity = new Vector3(0, cfg.gravity, 0);
    ps.targetStopDuration = 0.05;
    ps.disposeOnStop = false;

    ps.start();
    activeSystems.add(ps);

    ps.onStoppedObservable.addOnce(() => {
      const timeoutId = setTimeout(() => {
        pendingTimeouts.delete(timeoutId);
        disposeSystem(ps);
      }, (ps.maxLifeTime * 1000) + 100);
      pendingTimeouts.add(timeoutId);
    });
  }

  function spawnSmoke(position, cfg) {
    const ps = new ParticleSystem("vfx_smoke", cfg.count, scene);
    ps.particleTexture = sharedTextures.smoke;
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    ps.renderingGroupId = 2;

    ps.emitter = position.clone();
    ps.createSphereEmitter(0.3);

    ps.minLifeTime = cfg.durationMs / 1000 * 0.6;
    ps.maxLifeTime = cfg.durationMs / 1000;
    ps.minSize = cfg.size * 0.3;
    ps.maxSize = cfg.size;
    ps.minEmitPower = cfg.speed * 0.5;
    ps.maxEmitPower = cfg.speed;
    ps.emitRate = cfg.count / 0.08;

    ps.color1 = new Color4(0.4, 0.4, 0.4, 0.6);
    ps.color2 = new Color4(0.3, 0.3, 0.3, 0.4);
    ps.colorDead = new Color4(0.2, 0.2, 0.2, 0);

    ps.gravity = new Vector3(0, cfg.gravity, 0);
    ps.targetStopDuration = 0.08;
    ps.disposeOnStop = false;

    ps.start();
    activeSystems.add(ps);

    ps.onStoppedObservable.addOnce(() => {
      const timeoutId = setTimeout(() => {
        pendingTimeouts.delete(timeoutId);
        disposeSystem(ps);
      }, (ps.maxLifeTime * 1000) + 100);
      pendingTimeouts.add(timeoutId);
    });
  }

  function spawnSparks(position, cfg) {
    const ps = new ParticleSystem("vfx_sparks", cfg.count, scene);
    ps.particleTexture = sharedTextures.spark;
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.billboardMode = ParticleSystem.BILLBOARDMODE_STRETCHED;
    ps.renderingGroupId = 2;

    ps.emitter = position.clone();
    ps.createSphereEmitter(0.2);

    ps.minLifeTime = cfg.durationMs / 1000 * 0.4;
    ps.maxLifeTime = cfg.durationMs / 1000;
    ps.minSize = cfg.size;
    ps.maxSize = cfg.size;
    ps.minScaleX = cfg.width / cfg.size;
    ps.maxScaleX = cfg.width / cfg.size;
    ps.minEmitPower = cfg.speed * 0.7;
    ps.maxEmitPower = cfg.speed;
    ps.emitRate = cfg.count / 0.03;

    ps.color1 = new Color4(1, 0.95, 0.4, 1);
    ps.color2 = new Color4(1, 0.6, 0.15, 1);
    ps.colorDead = new Color4(0.6, 0.2, 0, 0);

    ps.gravity = new Vector3(0, cfg.gravity, 0);
    ps.targetStopDuration = 0.03;
    ps.disposeOnStop = false;

    ps.start();
    activeSystems.add(ps);

    ps.onStoppedObservable.addOnce(() => {
      const timeoutId = setTimeout(() => {
        pendingTimeouts.delete(timeoutId);
        disposeSystem(ps);
      }, (ps.maxLifeTime * 1000) + 100);
      pendingTimeouts.add(timeoutId);
    });
  }

  function disposeSystem(ps) {
    if (!activeSystems.has(ps)) return;
    ps.dispose(false);
    activeSystems.delete(ps);
  }

  function clear() {
    for (const timeoutId of pendingTimeouts) {
      clearTimeout(timeoutId);
    }
    pendingTimeouts.clear();

    for (const ps of activeSystems) {
      ps.dispose(false);
    }
    activeSystems.clear();
  }

  function dispose() {
    clear();
  }

  return { spawn, clear, dispose };
}
