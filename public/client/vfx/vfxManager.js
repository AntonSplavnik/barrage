import { createSharedTextures } from "./textures.js";
import { createExplosionEffect } from "./effects/explosion.js";
import { createMissileHitEffect } from "./effects/missileHit.js";
import { createMissileTrailEffect } from "./effects/missileTrail.js";
import { VFX_CONFIG } from "./vfxConfig.js";

const { Vector3 } = BABYLON;

export function createVfxManager(scene) {
  const sharedTextures = createSharedTextures(scene);

  const missileHitEffect = createMissileHitEffect(scene, sharedTextures, VFX_CONFIG, null);
  const explosionEffect = createExplosionEffect(scene, sharedTextures, VFX_CONFIG, {
    missileHit: missileHitEffect,
  });
  const trailEffect = createMissileTrailEffect(scene, sharedTextures, VFX_CONFIG);

  const effectMap = {
    "explosion": explosionEffect,
    "missileHit": missileHitEffect,
  };

  function positionFromEvent(evt) {
    const x = VFX_CONFIG.invertX ? -evt.x : evt.x;
    return new Vector3(x, evt.y, evt.z);
  }

  function handleEvent(evt) {
    const effect = effectMap[evt.kind];
    if (effect) {
      effect.spawn(positionFromEvent(evt), evt);
    }
  }

  function syncTrails(missileIds, visualObjects) {
    trailEffect.syncTrails(missileIds, visualObjects);
  }

  function clearEffects() {
    for (const effect of Object.values(effectMap)) {
      effect.clear();
    }
    trailEffect.clear();
  }

  function dispose() {
    clearEffects();
    for (const effect of Object.values(effectMap)) {
      effect.dispose();
    }
    trailEffect.dispose();
    sharedTextures.dispose();
  }

  return { handleEvent, syncTrails, clearEffects, dispose };
}
