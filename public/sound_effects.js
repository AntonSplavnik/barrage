import { BARRAGE_CONFIG } from "./config.js";

const CONFIG = BARRAGE_CONFIG;
const EFFECT_ALIASES = {
  missile_break_block: "missile_fragments_block",
  missile_hit_fragment: "missile_hits_fragment",
};

export function getSoundEffectDefinitions() {
  return CONFIG.soundEffects ?? {};
}

export function getCanonicalSoundEffectId(effectId) {
  return EFFECT_ALIASES[effectId] ?? effectId;
}

export function getSoundEffectDefinition(effectId) {
  const definitions = getSoundEffectDefinitions();
  return definitions[getCanonicalSoundEffectId(effectId)] ?? null;
}
