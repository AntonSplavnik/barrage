import { connectionEl, playerEl, scoreLeftEl, scoreRightEl, matchEndEl, matchEndTextEl, rematchEl, sfxToggleEl, engine, scene } from "./engine.js";
import { createSoundSystem } from "./sound.js";
import { applyState, latestObjectStates } from "./state.js";
import { loadLevel, reloadLevel, ensureVisualsForState, removeStaleVisuals, hideBlockVisual, shrinkAndDisposeFragment, clearDestructionVisuals, updateCrackStage } from "./level.js";

let seq = 0;
let displayedScores = { P1: 0, P2: 0 };
let ready = false;

const soundSystem = createSoundSystem();

let vfxManager = null;

sfxToggleEl.addEventListener("click", () => {
  soundSystem.toggle();
  sfxToggleEl.classList.toggle("active", soundSystem.isEnabled());
});

let serverConfig = {};

export function getServerConfig(key) {
  return serverConfig[key];
}

const socketProtocol = window.location.protocol === "https:" ? "wss" : "ws";
export const socket = new WebSocket(`${socketProtocol}://${window.location.host}`);

function spawnFlyingStar(side) {
  const container = side === "left" ? scoreLeftEl : scoreRightEl;
  const color = side === "left" ? "#ff6b6b" : "#6ba3ff";

  const star = document.createElement("span");
  star.className = "score-star-flying";
  star.textContent = "★";
  star.style.color = color;
  document.body.appendChild(star);

  const targetRect = container.getBoundingClientRect();
  const starCount = container.children.length;
  const targetX = side === "left"
    ? targetRect.left + starCount * 32 + 14
    : targetRect.right - starCount * 32 - 14;
  const targetY = targetRect.top + targetRect.height / 2;

  const animation = star.animate([
    {
      top: "50%", left: "50%",
      fontSize: "120px",
      transform: "translate(-50%, -50%)",
      opacity: 1,
    },
    {
      top: "50%", left: "50%",
      fontSize: "120px",
      transform: "translate(-50%, -50%)",
      opacity: 1,
      offset: 0.4,
    },
    {
      top: `${targetY}px`, left: `${targetX}px`,
      fontSize: "28px",
      transform: "translate(-50%, -50%)",
      opacity: 1,
    },
  ], {
    duration: 1400,
    easing: "ease-in-out",
    fill: "forwards",
  });

  animation.onfinish = () => {
    star.remove();
    const settled = document.createElement("span");
    settled.className = "score-star";
    settled.textContent = "★";
    container.appendChild(settled);
  };
}

function updateScores(scores, animate) {
  if (!scores) return;
  const p1 = scores.P1 ?? 0;
  const p2 = scores.P2 ?? 0;
  if (p1 === displayedScores.P1 && p2 === displayedScores.P2) return;

  if (animate) {
    if (p1 > displayedScores.P1) spawnFlyingStar("left");
    if (p2 > displayedScores.P2) spawnFlyingStar("right");
  } else {
    while (scoreLeftEl.children.length < p1) {
      const s = document.createElement("span");
      s.className = "score-star";
      s.textContent = "★";
      scoreLeftEl.appendChild(s);
    }
    while (scoreRightEl.children.length < p2) {
      const s = document.createElement("span");
      s.className = "score-star";
      s.textContent = "★";
      scoreRightEl.appendChild(s);
    }
  }

  displayedScores = { P1: p1, P2: p2 };
}

socket.addEventListener("open", () => {
  connectionEl.textContent = "Connected";
});

socket.addEventListener("message", async (event) => {
  const message = JSON.parse(event.data);

  if (message.type === "welcome") {
    if (message.config) serverConfig = message.config;
    playerEl.textContent = message.playerId;
    const { initTemplateRegistry } = await import("./templateRegistry.js");
    await initTemplateRegistry(message.templates ?? []);
    await loadLevel(message.level);
    const { createVfxManager } = await import("./vfx/vfxManager.js");
    vfxManager = createVfxManager(scene);
    engine.runRenderLoop(() => { scene.render(); });
    ready = true;
    return;
  }

  if (!ready) return;

  if (message.type === "roundEnded") {
    updateScores(message.scores, true);
  }

  if (message.type === "roundStarted") {
    if (message.config) serverConfig = message.config;
    clearDestructionVisuals();
    vfxManager?.clearEffects();
    if (message.level) reloadLevel(message.level);
  }

  if (message.type === "matchEnded") {
    updateScores(message.scores, false);
    const color = message.winner === "P1" ? "#ff6b6b" : "#6ba3ff";
    matchEndTextEl.textContent = "👑";
    matchEndTextEl.style.color = color;
    matchEndEl.classList.remove("hidden");
  }

  if (message.type === "matchReset") {
    if (message.config) serverConfig = message.config;
    matchEndEl.classList.add("hidden");
    vfxManager?.clearEffects();
    scoreLeftEl.innerHTML = "";
    scoreRightEl.innerHTML = "";
    displayedScores = { P1: 0, P2: 0 };
    if (message.level) reloadLevel(message.level);
  }

  if (message.type === "event") {
    for (const evt of message.events ?? []) {
      if (evt.kind === "blockBroken") {
        hideBlockVisual(evt.blockId);
      }
      if (evt.kind === "fragmentRemoving") {
        shrinkAndDisposeFragment(evt.fragId);
      }
      if (evt.kind === "reset") {
        clearDestructionVisuals();
        vfxManager?.clearEffects();
      }
      if (evt.kind === "sfx" || evt.kind === "sfxStart" || evt.kind === "sfxStop") {
        soundSystem.handleSfxEvent(evt);
      }
      if (evt.kind === "explosion" || evt.kind === "missileHit") {
        vfxManager?.handleEvent(evt);
      }
    }
  }

  if (message.type === "state") {
    updateScores(message.scores, false);
    const prevStates = new Map(latestObjectStates);
    removeStaleVisuals(message.objects ?? []);
    ensureVisualsForState(message.objects ?? []);
    applyState(message);

    for (const object of message.objects ?? []) {
      if (object.hitStage !== undefined && object.hitStage > 0) {
        const prev = prevStates.get(object.id);
        if (!prev || prev.hitStage !== object.hitStage) {
          updateCrackStage(object.id, object.hitStage, object.fragmentTemplate);
        }
      }
    }
  }
});

socket.addEventListener("close", () => {
  connectionEl.textContent = "Disconnected";
});

rematchEl.addEventListener("click", () => {
  sendInput("reset");
});

export function sendInput(action, payload) {
  if (socket.readyState !== WebSocket.OPEN) return;

  socket.send(JSON.stringify({
    type: "input",
    seq: ++seq,
    action,
    ...payload,
  }));
}
