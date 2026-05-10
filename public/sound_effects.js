import { BARRAGE_CONFIG } from "./config.js";

const CONFIG = BARRAGE_CONFIG;

export function getSoundEffectDefinitions() {
  return CONFIG.soundEffects ?? {};
}

export function getSoundEffectDefinition(effectId) {
  return getSoundEffectDefinitions()[effectId] ?? null;
}
