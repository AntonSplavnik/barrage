import { BARRAGE_CONFIG } from "./config.js";
import { getCanonicalSoundEffectId, getSoundEffectDefinition, getSoundEffectDefinitions } from "./sound_effects.js";

const CONFIG = BARRAGE_CONFIG;
const { Engine } = BABYLON;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function randomizedPitch(pitch) {
  const amount = Math.max(0, CONFIG.soundEffectPitchRandomization ?? 0);
  if (amount === 0) return pitch;

  return pitch * (1 + (Math.random() * 2 - 1) * amount);
}

export function createSoundEffectsController(button, scene, { onStatus } = {}) {
  const status = typeof onStatus === "function" ? onStatus : () => {};

  let enabled = false;
  let enabling = false;
  let initialized = false;
  let decodeAudioContext = null;
  let outputGain = null;
  const baseAudioBuffers = new Map();
  const activeEffects = new Map();

  function setEnabledUi(isEnabled) {
    button.classList.toggle("is-enabled", isEnabled);
    button.setAttribute("aria-label", isEnabled ? "Disable sound effects" : "Enable sound effects");
    button.title = isEnabled ? "Disable sound effects" : "Enable sound effects";
  }

  async function unlockAudio() {
    const audioEngine = Engine.audioEngine;
    if (!audioEngine) return;
    audioEngine.unlock();
    await audioEngine.audioContext?.resume?.();
    await decodeAudioContext?.resume?.();
  }

  function getAudioContext() {
    return Engine.audioEngine?.audioContext ?? decodeAudioContext ?? null;
  }

  function ensureDecodeAudioContext() {
    if (decodeAudioContext) return decodeAudioContext;

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return null;

    decodeAudioContext = new AudioContextCtor();
    return decodeAudioContext;
  }

  function ensureOutputGain() {
    if (outputGain) return outputGain;

    const audioContext = getAudioContext() ?? ensureDecodeAudioContext();
    if (!audioContext) return null;

    outputGain = audioContext.createGain();
    outputGain.gain.value = CONFIG.soundEffectTrackVolume ?? 1.0;
    outputGain.connect(audioContext.destination);
    return outputGain;
  }

  async function loadBaseSound(effectId, definition) {
    const response = await fetch(definition.file, { cache: "force-cache" });
    if (!response.ok) {
      throw new Error(`Failed to load ${definition.file}: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const audioContext = getAudioContext() ?? ensureDecodeAudioContext();
    if (!audioContext) {
      throw new Error("No browser audio context is available");
    }
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    baseAudioBuffers.set(effectId, audioBuffer);
  }

  async function tryLoadBaseSound(effectId, definition) {
    if (baseAudioBuffers.has(effectId)) return;

    try {
      await loadBaseSound(effectId, definition);
    } catch (error) {
      console.warn(`Skipping sound effect "${effectId}".`, error);
    }
  }

  async function loadSounds() {
    ensureOutputGain();
    const definitions = getSoundEffectDefinitions();
    await Promise.all(Object.entries(definitions).map(([effectId, definition]) => tryLoadBaseSound(effectId, definition)));
  }

  async function enable() {
    if (enabled || enabling) return;

    enabling = true;
    button.disabled = true;
    status("Starting sound effects...");
    setEnabledUi(true);

    try {
      await unlockAudio();
      await loadSounds();
      initialized = true;
      enabled = true;
      setEnabledUi(true);
      status("Sound effects enabled");
    } catch (error) {
      setEnabledUi(false);
      console.error("Failed to enable sound effects.", error);
      status("Sound effects failed");
      throw error;
    } finally {
      enabling = false;
      button.disabled = false;
    }
  }

  function disable() {
    enabled = false;
    stopAllEffects();
    setEnabledUi(false);
    status("Sound effects disabled");
  }

  function effectInstanceKey(effectId, instanceId) {
    return `${effectId}:${instanceId}`;
  }

  function stopPlayback(playback) {
    if (!playback) return;

    try {
      playback.source.stop();
    } catch {
      // Source may already have ended.
    }
    playback.cleanup();
  }

  function stopAllEffects() {
    for (const key of [...activeEffects.keys()]) {
      stopEffectByKey(key);
    }
  }

  function stopEffectByKey(key) {
    const playback = activeEffects.get(key);
    activeEffects.delete(key);
    stopPlayback(playback);
  }

  function createPlayback(effectId, overrides = {}) {
    if (!enabled) return;

    const canonicalEffectId = getCanonicalSoundEffectId(effectId);
    const definition = getSoundEffectDefinition(effectId);
    const audioBuffer = baseAudioBuffers.get(canonicalEffectId);
    if (!definition || !audioBuffer) return;

    const volume = overrides.volume ?? definition.volume ?? 1;
    const pitch = randomizedPitch(overrides.pitch ?? definition.pitch ?? 1);
    const pan = clamp(overrides.pan ?? definition.pan ?? 0, -1, 1);
    const audioContext = getAudioContext();
    const destination = outputGain ?? ensureOutputGain();
    if (!audioContext || !destination) return;

    const source = audioContext.createBufferSource();
    const leftGain = audioContext.createGain();
    const rightGain = audioContext.createGain();
    const merger = audioContext.createChannelMerger(2);

    source.buffer = audioBuffer;
    source.playbackRate.value = pitch;
    leftGain.gain.value = volume * (pan <= 0 ? 1 : 1 - pan);
    rightGain.gain.value = volume * (pan >= 0 ? 1 : 1 + pan);
    source.loop = overrides.loop ?? definition.loop ?? false;

    source.connect(leftGain);
    source.connect(rightGain);
    leftGain.connect(merger, 0, 0);
    rightGain.connect(merger, 0, 1);
    merger.connect(destination);

    const playback = {
      source,
      cleanup: () => {
        source.onended = null;
        try { source.disconnect(); } catch {}
        try { leftGain.disconnect(); } catch {}
        try { rightGain.disconnect(); } catch {}
        try { merger.disconnect(); } catch {}
      },
    };

    return playback;
  }

  function playEffect(effectId, overrides = {}) {
    const playback = createPlayback(effectId, overrides);
    if (!playback) return;

    playback.source.onended = playback.cleanup;
    playback.source.start();
  }

  function startEffect(effectId, instanceId, overrides = {}) {
    if (!instanceId) return;

    const key = effectInstanceKey(effectId, instanceId);
    stopEffectByKey(key);

    const playback = createPlayback(effectId, overrides);
    if (!playback) return;

    activeEffects.set(key, playback);
    playback.source.onended = () => {
      activeEffects.delete(key);
      playback.cleanup();
    };
    playback.source.start();
  }

  function stopEffect(effectId, instanceId) {
    if (!instanceId) return;
    stopEffectByKey(effectInstanceKey(effectId, instanceId));
  }

  setEnabledUi(false);
  if (CONFIG.soundEffectsEnabledByDefault ?? true) {
    enable().catch((error) => {
      console.warn("Sound effects could not be enabled by default.", error);
    });
  }

  return {
    disable,
    enable,
    isEnabled: () => enabled,
    playEffect,
    startEffect,
    stopEffect,
    toggle: async () => {
      if (enabled) {
        disable();
        return;
      }
      await enable();
    },
  };
}
