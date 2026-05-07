# Worker Threads — Room Simulation Refactor

## Goal

Move each room's physics simulation into its own Node.js Worker thread so rooms run in parallel, utilising both CPU cores on the e2-small instead of one.

## Current Architecture

```
Main thread
  ├── WebSockets (all clients)
  ├── RoomManager (assignment, spectators)
  └── simulationInterval — loops through all rooms sequentially
        bindRoom(room) → simulatePhysics() → sendState()
```

## Target Architecture

```
Main thread
  ├── WebSockets (all clients)
  ├── RoomManager (assignment, spectators)
  └── workerMap: Map<roomId, Worker>
        postMessage(input) ──→ Room Worker 1  (own NullEngine + Havok + setInterval)
        postMessage(input) ──→ Room Worker 2
        postMessage(input) ──→ Room Worker 3
        ←── parentPort.postMessage(state/events)
```

Each worker runs independently. No more `bindRoom` global-swapping — each worker has its own globals naturally.

---

## What Changes

### `server.js` (main thread)

**Remove:**
- `simulationInterval` and the room loop
- `applyInput`, all physics helpers, Babylon/Havok imports
- `bindRoom`, `saveActiveRoomTick`, `createRoomRuntime`
- `simulatePhysics`, `sendState`, `loadLevelIfPresent`, `enableHavokPhysics`

**Add:**
- `workerMap = new Map()` — roomId → Worker instance
- In `roomManager.createRoom`: spawn a worker instead of running physics inline
- WebSocket `message` handler: forward input to `workerMap.get(client.room.id).postMessage(...)`
- Worker `message` handler: receive broadcasts from worker, forward to correct WebSocket clients

```js
// Creating a room
const worker = new Worker("./server/roomWorker.js", {
  workerData: { roomId, playerIds, levelFile, port: PORT }
});
worker.on("message", (msg) => routeWorkerMessage(msg));
worker.on("error", (err) => console.error(`Worker ${roomId} error:`, err));
workerMap.set(roomId, worker);
// Wait for { type: "ready" } before marking room open
```

```js
// Routing WebSocket input to correct worker
socket.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  workerMap.get(client.room.id)?.postMessage({ type: "input", playerId: client.playerId, msg });
});
```

```js
// Receiving from worker and forwarding to clients
function routeWorkerMessage(msg) {
  if (msg.type === "broadcast") {
    for (const client of rooms.get(msg.roomId).clients.values()) {
      client.socket.send(JSON.stringify(msg.payload));
    }
  }
  if (msg.type === "playerVacancy") {
    handlePlayerVacancy(msg);   // spectator promotion etc. stays in main
  }
}
```

### `server/roomWorker.js` (new file)

Mostly the physics half of current `server.js` with two changes:

**1. Replace `broadcast(message)` with:**
```js
import { parentPort, workerData } from "node:worker_threads";

function broadcast(message) {
  parentPort.postMessage({ type: "broadcast", roomId: workerData.roomId, payload: message });
}
```

**2. Replace the WebSocket `message` handler with:**
```js
parentPort.on("message", ({ type, playerId, msg }) => {
  if (type === "input") {
    const client = { playerId, id: playerId };   // lightweight client stand-in
    applyInput(client, msg);
  }
  if (type === "playerLeft") {
    // pause sim, signal main thread to handle vacancy
    paused = true;
    parentPort.postMessage({ type: "playerVacancy", roomId: workerData.roomId, playerId });
  }
  if (type === "playerJoined") {
    paused = false;
  }
});
```

**3. Remove** the `setInterval` from `startServer` and instead start the tick loop directly on worker init:

```js
await enableHavokPhysics();
await loadLevelIfPresent();
parentPort.postMessage({ type: "ready" });

setInterval(() => {
  tick += 1;
  simulatePhysics(TICK_MS / 1000);
  const knockedKing = checkKingKnockout(gameObjects);
  if (knockedKing) recordRoundWin(playerIdForKing(knockedKing));
  sendState();
}, TICK_MS);
```

---

## Message Protocol

### Main → Worker
| type | payload | purpose |
|------|---------|---------|
| `input` | `{ playerId, msg }` | forward player WebSocket message |
| `playerLeft` | `{ playerId }` | client disconnected |
| `playerJoined` | `{ playerId }` | spectator promoted into slot |
| `reset` | — | force room reset |

### Worker → Main
| type | payload | purpose |
|------|---------|---------|
| `ready` | — | worker initialised, room can open |
| `broadcast` | `{ roomId, payload }` | forward payload to all room clients |
| `playerVacancy` | `{ roomId, playerId }` | player slot opened, handle in main |

---

## Known Gotcha

`SceneLoader.AppendAsync` inside the worker fetches the GLB via `http://localhost:${PORT}/assets/`. The main thread's HTTP server must be listening before workers try to load levels. This is already true today (server listens before rooms are created), so no change needed.

---

## What You Gain

- Each room's 60hz physics loop runs on its own core slice
- e2-small has 2 vCPUs — up to 3 rooms no longer contend on one thread
- `bindRoom` global-swapping pattern disappears entirely (each worker has its own globals)
- Main thread becomes a thin router — easier to reason about

## Effort Estimate

Half a day of focused work. The refactor is mostly mechanical — copy physics code to worker file, replace `broadcast` with `parentPort.postMessage`, replace WebSocket handler with `parentPort.on("message")`, wire up worker spawning in main.
