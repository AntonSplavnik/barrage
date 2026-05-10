import { BARRAGE_CONFIG } from "./config.js";
import { getSoundEffectDefinition, getSoundEffectDefinitions } from "./sound_effects.js";

const CONFIG = BARRAGE_CONFIG;
const { Engine, Sound, SoundTrack, Vector3 } = BABYLON;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function createSoundEffectsController(button, scene, { onStatus } = {}) {
  const status = typeof onStatus === "function" ? onStatus : () => {};

  let enabled = false;
  let enabling = false;
  let initialized = false;
  let soundTrack = null;
  let decodeAudioContext = null;
  const baseAudioBuffers = new Map();

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

  function ensureSoundTrack() {
    if (!soundTrack) {
      soundTrack = new SoundTrack(scene, {
        volume: CONFIG.soundEffectTrackVolume ?? 1.0,
      });
    }
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

  async function loadSounds() {
    ensureSoundTrack();
    const definitions = getSoundEffectDefinitions();
    await Promise.all(Object.entries(definitions).map(([effectId, definition]) => loadBaseSound(effectId, definition)));
  }

  async function enable() {
    if (enabled || enabling) return;

    enabling = true;
    button.disabled = true;
    status("Starting sound effects...");

    try {
      await unlockAudio();
      if (!initialized) {
        await loadSounds();
        initialized = true;
      }
      enabled = true;
      setEnabledUi(true);
      status("Sound effects enabled");
    } catch (error) {
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
    setEnabledUi(false);
    status("Sound effects disabled");
  }

  function playEffect(effectId, overrides = {}) {
    if (!enabled) return;

    const definition = getSoundEffectDefinition(effectId);
    const audioBuffer = baseAudioBuffers.get(effectId);
    if (!definition || !audioBuffer) return;

    const volume = overrides.volume ?? definition.volume ?? 1;
    const pitch = overrides.pitch ?? definition.pitch ?? 1;
    const pan = clamp(overrides.pan ?? definition.pan ?? 0, -1, 1);
    const panDistance = CONFIG.soundEffectPanDistance ?? 12;
    const soundName = `${effectId}_${performance.now()}`;

    const instance = new Sound(soundName, audioBuffer, scene, () => {
      instance.useCustomAttenuation = true;
      instance.setAttenuationFunction((currentVolume) => currentVolume);
      instance.spatialSound = true;
      instance.maxDistance = Number.MAX_SAFE_INTEGER;
      instance.rolloffFactor = 0;
      instance.refDistance = 1;
      instance.setVolume(volume);
      instance.setPlaybackRate(pitch);
      instance.setPosition(new Vector3(pan * panDistance, 0, 1));
      soundTrack?.addSound(instance);
      instance.onEndedObservable.addOnce(() => {
        soundTrack?.removeSound(instance);
        instance.dispose();
      });
      instance.play();
    }, {
      autoplay: false,
      loop: false,
      volume: 1,
      spatialSound: true,
      maxDistance: Number.MAX_SAFE_INTEGER,
      rolloffFactor: 0,
      refDistance: 1,
      panningModel: "equalpower",
    });

    instance.metadata = { effectId };
  }

  setEnabledUi(false);

  return {
    disable,
    enable,
    isEnabled: () => enabled,
    playEffect,
    toggle: async () => {
      if (enabled) {
        disable();
        return;
      }
      await enable();
    },
  };
}
