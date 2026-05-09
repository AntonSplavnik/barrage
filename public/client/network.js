import { connectionEl, playerEl, scoreLeftEl, scoreRightEl } from "./engine.js";
import { applyState } from "./state.js";

let seq = 0;
let displayedScores = { P1: 0, P2: 0 };

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

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);

  if (message.type === "welcome") {
    playerEl.textContent = message.playerId;
  }

  if (message.type === "roundEnded") {
    updateScores(message.scores, true);
  }

  if (message.type === "state") {
    updateScores(message.scores, false);
    applyState(message);
  }
});

socket.addEventListener("close", () => {
  connectionEl.textContent = "Disconnected";
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
