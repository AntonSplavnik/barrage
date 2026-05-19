const { ParticleSystem, Color4, Vector3 } = BABYLON;

export function createMissileHitEffect(scene, sharedTextures, config, _deps) {
  const activeSystems = new Set();
  const pendingTimeouts = new Set();

  function spawn(position, evt) {
    const impactFactor = computeImpactFactor(evt.speed, config);
    const scale = Math.max(config.missileHit.minScale, impactFactor);
    const count = Math.max(1, Math.round(config.missileHit.count * scale));
    const burstSpeed = config.missileHit.speed * scale;
    const size = config.missileHit.size * scale;
    const duration = config.missileHit.durationMs / 1000;

    const ps = new ParticleSystem("vfx_missileHit", count, scene);
    ps.particleTexture = sharedTextures.fragment;
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    ps.renderingGroupId = 2;

    ps.isAnimationSheetEnabled = true;
    ps.spriteCellWidth = 64;
    ps.spriteCellHeight = 64;
    ps.startSpriteCellID = 0;
    ps.endSpriteCellID = 3;
    ps.spriteRandomStartCell = true;

    ps.emitter = position.clone();
    ps.createSphereEmitter(0.15);

    ps.minLifeTime = duration * 0.5;
    ps.maxLifeTime = duration;
    ps.minSize = size * 0.4;
    ps.maxSize = size;
    ps.minEmitPower = burstSpeed * 0.5;
    ps.maxEmitPower = burstSpeed;
    ps.manualEmitCount = count;

    ps.color1 = new Color4(1, 1, 1, 1);
    ps.color2 = new Color4(0.85, 0.82, 0.75, 1);
    ps.colorDead = new Color4(0.5, 0.48, 0.44, 0);

    ps.addSizeGradient(0, size);
    ps.addSizeGradient(0.3, size * 0.6);
    ps.addSizeGradient(1, 0);

    ps.minAngularSpeed = -5;
    ps.maxAngularSpeed = 5;

    ps.gravity = new Vector3(0, config.missileHit.gravity, 0);
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

function computeImpactFactor(speed, config) {
  if (speed == null) return 1;
  const clamped = Math.max(config.impactSpeedMin, Math.min(speed, config.impactSpeedMax));
  return (clamped - config.impactSpeedMin) / (config.impactSpeedMax - config.impactSpeedMin);
}
