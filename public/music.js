import { BARRAGE_CONFIG } from "./config.js";

const CONFIG = BARRAGE_CONFIG;
const STRUDEL_RUNTIME_TIMEOUT_MS = 4000;

function stripInjectedControls(source) {
  return source
    .replace(/^\s*(const|let|var)\s+kickVoiceGain\s*=.*$/gm, "")
    .replace(/^\s*(const|let|var)\s+musicVolume\s*=.*$/gm, "")
    .replace(/\._pianoroll\(\)/g, "");
}

function buildEvaluatedSource(source, { kickVoiceGain = 0, musicVolume = 1 } = {}) {
  return [
    `const kickVoiceGain = ${kickVoiceGain};`,
    `const musicVolume = ${musicVolume};`,
    stripInjectedControls(source).trim(),
  ].filter(Boolean).join("\n\n");
}

async function waitForRuntime(timeoutMs = STRUDEL_RUNTIME_TIMEOUT_MS) {
  const deadline = performance.now() + timeoutMs;

  while (performance.now() < deadline) {
    const evaluate = globalThis.evaluate ?? globalThis.strudel?.evaluate;
    const hush = globalThis.hush ?? globalThis.strudel?.hush;
    if (typeof evaluate === "function" && typeof hush === "function") {
      return { evaluate, hush };
    }
    await new Promise((resolve) => window.setTimeout(resolve, 16));
  }

  throw new Error("Strudel runtime not ready");
}

function installSampleAliases() {
  const soundAlias = globalThis.soundAlias ?? globalThis.strudel?.soundAlias;
  if (typeof soundAlias !== "function") return;

  const aliasPairs = [
    ["RolandTR909_bd", "tr909_bd"],
    ["RolandTR909_hh", "tr909_hh"],
    ["RolandTR909_cp", "tr909_cp"],
    ["RolandTR909_oh", "tr909_oh"],
    ["RolandTR909_rim", "tr909_rim"],
    ["RolandTR909_bd", "bd"],
    ["RolandTR909_hh", "hh"],
    ["RolandTR909_cp", "cp"],
    ["RolandTR909_oh", "oh"],
    ["RolandTR909_rim", "rim"],
  ];

  for (const [source, alias] of aliasPairs) {
    try {
      soundAlias(source, alias);
    } catch {
      // Ignore duplicate or missing alias registration errors.
    }
  }
}

export function createMusicController(button, { onStatus } = {}) {
  const status = typeof onStatus === "function" ? onStatus : () => {};

  let enabled = false;
  let enabling = false;
  let initialized = false;
  let runtime = null;
  let kickVoiceGain = 0;
  let tuneSource = "";
  let renderToken = 0;

  function setEnabledUi(isEnabled) {
    button.classList.toggle("is-enabled", isEnabled);
    button.setAttribute("aria-label", isEnabled ? "Disable music" : "Enable music");
    button.title = isEnabled ? "Disable music" : "Enable music";
  }

  function strudelAvailable() {
    return typeof globalThis.initStrudel === "function";
  }

  function getHush() {
    if (typeof runtime?.hush === "function") return runtime.hush;
    if (typeof globalThis.hush === "function") return globalThis.hush;
    if (typeof globalThis.strudel?.hush === "function") return globalThis.strudel.hush;
    return null;
  }

  async function loadTuneSource() {
    const tuneUrl = CONFIG.musicTuneUrl?.trim();
    if (!tuneUrl) {
      tuneSource = `stack(s("[bd]*2").gain(kickVoiceGain * musicVolume))`;
      return;
    }

    const url = `${new URL(tuneUrl, window.location.href).href}?t=${Date.now()}`;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to load Strudel tune: ${response.status}`);
    }
    tuneSource = await response.text();
  }

  async function renderPattern({ restart = false } = {}) {
    if (!enabled || !runtime || !tuneSource.trim()) return;

    const token = ++renderToken;
    const source = buildEvaluatedSource(tuneSource, {
      kickVoiceGain,
      musicVolume: CONFIG.musicVolume ?? 1,
    });
    if (restart) {
      getHush()?.();
    }
    await runtime.evaluate(source, true, restart);
    if (token !== renderToken) {
      getHush()?.();
    }
  }

  function disable() {
    if (!enabled && !enabling) return;
    renderToken += 1;
    enabling = false;
    enabled = false;
    getHush()?.();
    button.disabled = false;
    setEnabledUi(false);
    status("Music disabled");
  }

  async function enable() {
    if (enabled || enabling) return;
    if (!strudelAvailable()) {
      throw new Error("Strudel runtime not available");
    }

    enabling = true;
    button.disabled = true;
    status("Starting music...");

    try {
      await loadTuneSource();
      if (!initialized) {
        const sampleSource = CONFIG.musicSamplesUrl?.trim();
        const samplesLoader = globalThis.samples ?? globalThis.strudel?.samples;
        if (sampleSource && typeof samplesLoader === "function") {
          await Promise.resolve(globalThis.initStrudel({
            prebake: () => samplesLoader(sampleSource),
          }));
        } else {
          await Promise.resolve(globalThis.initStrudel());
        }
        runtime = await waitForRuntime();
        installSampleAliases();
        initialized = true;
      } else if (!runtime) {
        runtime = await waitForRuntime();
        installSampleAliases();
      }

      enabled = true;
      setEnabledUi(true);
      await renderPattern({ restart: true });
      status("Music enabled");
    } finally {
      enabling = false;
      button.disabled = false;
    }
  }

  function setKickVoiceGain(nextKickVoiceGain) {
    const normalized = nextKickVoiceGain > 0 ? 1 : 0;
    if (normalized === kickVoiceGain) return;
    kickVoiceGain = normalized;
    Promise.resolve().then(() => renderPattern({ restart: false })).catch((error) => {
      console.error("Failed to update music state.", error);
    });
  }

  setEnabledUi(false);

  return {
    disable,
    enable,
    isEnabled: () => enabled,
    setKickVoiceGain,
    toggle: async () => {
      if (enabled) {
        disable();
        return;
      }
      await enable();
    },
  };
}
