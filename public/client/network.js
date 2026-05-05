import { connectionEl, playerEl } from "./engine.js";
import { applyState } from "./state.js";

let seq = 0;

const socketProtocol = window.location.protocol === "https:" ? "wss" : "ws";
export const socket = new WebSocket(`${socketProtocol}://${window.location.host}`);

socket.addEventListener("open", () => {
  connectionEl.textContent = "Connected";
});

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);

  if (message.type === "welcome") {
    playerEl.textContent = message.playerId;
  }

  if (message.type === "state") {
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
