const SOUND_CONFIG = {
  masterVolume: 1.0,
  pitchRandomization: 0.2,
  panWorldMinX: -45,
  panWorldMaxX: 45,
  impactSpeedMin: 1.5,
  impactSpeedMax: 24,
  impactVolumeMin: 0.2,
  impactVolumeMax: 1.0,
  cooldownMs: 120,

  effects: {
    trebuchet_release:       { file: "/sounds/trebuchet_release.mp3", volume: 0.75, pitch: 1.0 },
    trebuchet_stretch:       { file: "/sounds/trebuche-stretch.mp3", volume: 0.7, pitch: 1.0 },
    block_hit_ground:        { file: "/sounds/block_hit_ground.mp3", volume: 0.55, pitch: 0.9 },
    block_hit_block:         { file: "/sounds/block-hit-block.mp3", volume: 0.65, pitch: 0.95, cooldownMs: 220 },
    missile_hit_ground:      { file: "/sounds/missile-hit-ground.mp3", volume: 0.55, pitch: 1.0, cooldownMs: 180 },
    missile_hit_block:       { file: "/sounds/missile_hit_block.mp3", volume: 0.65, pitch: 0.98, cooldownMs: 220 },
    missile_hit_missile:     { file: "/sounds/missile-hit-missile.mp3", volume: 0.65, pitch: 1.0 },
    missile_hit_trebuchet:   { file: "/sounds/missile_hit_trebuchet.mp3", volume: 0.8, pitch: 0.92, cooldownMs: 220 },
    missile_fragments_block: { file: "/sounds/missile_fragments_block.mp3", volume: 0.95, pitch: 0.96 },
    missile_crack_block:     { file: "/sounds/missile_crack_block.mp3", volume: 0.75, pitch: 1.0 },
    missile_hits_fragment:   { file: "/sounds/missile_hits_fragment.mp3", volume: 0.7, pitch: 1.04 },
    king_hit:                { file: "/sounds/king_hit.mp3", volume: 1.0, pitch: 1.0 },
    missile_bomb_hit:        { file: "/sounds/missile_bomb-hit.mp3", volume: 1.0, pitch: 0.9 },
  },
};

export function createSoundSystem() {
  let enabled = false;
  let ctx = null;
  let masterGain = null;
  const buffers = new Map();
  const lastPlayedAt = new Map();
  const activeInstances = new Map();

  async function loadAll() {
    if (buffers.size > 0) return;
    const entries = Object.entries(SOUND_CONFIG.effects);
    const results = await Promise.allSettled(
      entries.map(async ([name, cfg]) => {
        const response = await fetch(cfg.file);
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        buffers.set(name, audioBuffer);
      }),
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        console.warn(`Failed to load sound "${entries[i][0]}":`, results[i].reason);
      }
    }
  }

  function ensureContext() {
    if (ctx) return;
    ctx = new AudioContext();
    masterGain = ctx.createGain();
    masterGain.gain.value = SOUND_CONFIG.masterVolume;
    masterGain.connect(ctx.destination);
  }

  function volumeFromSpeed(speed) {
    if (speed == null) return SOUND_CONFIG.impactVolumeMax;
    const t = Math.min(Math.max((speed - SOUND_CONFIG.impactSpeedMin) / (SOUND_CONFIG.impactSpeedMax - SOUND_CONFIG.impactSpeedMin), 0), 1);
    return SOUND_CONFIG.impactVolumeMin + t * (SOUND_CONFIG.impactVolumeMax - SOUND_CONFIG.impactVolumeMin);
  }

  function panFromX(x) {
    const range = SOUND_CONFIG.panWorldMaxX - SOUND_CONFIG.panWorldMinX;
    if (range <= 0) return 0;
    const t = (x - SOUND_CONFIG.panWorldMinX) / range;
    return -Math.min(Math.max(t * 2 - 1, -1), 1);
  }

  function isOnCooldown(effectName) {
    const cfg = SOUND_CONFIG.effects[effectName];
    const cd = cfg?.cooldownMs ?? SOUND_CONFIG.cooldownMs;
    const last = lastPlayedAt.get(effectName) ?? 0;
    return (performance.now() - last) < cd;
  }

  function playOneShot(effectName, speed, x) {
    const cfg = SOUND_CONFIG.effects[effectName];
    if (!cfg) return;
    const buffer = buffers.get(effectName);
    if (!buffer) return;
    if (isOnCooldown(effectName)) return;

    lastPlayedAt.set(effectName, performance.now());

    const vol = volumeFromSpeed(speed) * cfg.volume;
    const randomPitch = 1 + (Math.random() - 0.5) * 2 * SOUND_CONFIG.pitchRandomization;
    const rate = cfg.pitch * randomPitch;
    const pan = panFromX(x ?? 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;

    const gainNode = ctx.createGain();
    gainNode.gain.value = vol;

    const panNode = ctx.createStereoPanner();
    panNode.pan.value = pan;

    source.connect(gainNode);
    gainNode.connect(panNode);
    panNode.connect(masterGain);

    source.start();
  }

  function startInstance(effectName, instanceId, x) {
    stopInstance(instanceId);

    const cfg = SOUND_CONFIG.effects[effectName];
    if (!cfg) return;
    const buffer = buffers.get(effectName);
    if (!buffer) return;

    const pan = panFromX(x ?? 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.playbackRate.value = cfg.pitch;

    const gainNode = ctx.createGain();
    gainNode.gain.value = cfg.volume;

    const panNode = ctx.createStereoPanner();
    panNode.pan.value = pan;

    source.connect(gainNode);
    gainNode.connect(panNode);
    panNode.connect(masterGain);

    source.start();
    activeInstances.set(instanceId, { source, gainNode });
  }

  function stopInstance(instanceId) {
    const instance = activeInstances.get(instanceId);
    if (!instance) return;
    instance.source.stop();
    activeInstances.delete(instanceId);
  }

  function handleSfxEvent(evt) {
    if (!enabled) return;
    if (evt.kind === "sfx") {
      playOneShot(evt.effect, evt.speed, evt.x);
    } else if (evt.kind === "sfxStart") {
      startInstance(evt.effect, evt.instanceId, evt.x);
    } else if (evt.kind === "sfxStop") {
      stopInstance(evt.instanceId);
    }
  }

  async function enable() {
    enabled = true;
    ensureContext();
    if (ctx.state === "suspended") ctx.resume();
    await loadAll();
  }

  function disable() {
    enabled = false;
    for (const instanceId of activeInstances.keys()) {
      stopInstance(instanceId);
    }
  }

  function toggle() {
    if (enabled) {
      disable();
    } else {
      enable();
    }
    return enabled;
  }

  function isEnabled() {
    return enabled;
  }

  return { handleSfxEvent, enable, disable, toggle, isEnabled };
}
