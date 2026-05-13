# Worker Threads — Room Simulation Refactor

## Goal

Move each room's simulation into its own Node.js Worker thread so multiple rooms can run in parallel instead of sharing one sequential 60 Hz loop on the main thread.

The main thread should own networking and room assignment. A room runtime should own gameplay state, physics, level loading, input application, round progression, and state/event generation.

## Current Architecture

```text
Main thread
  ├── Express + WebSockets
  ├── RoomManager
  ├── room objects own engine/scene/gameObjects/physics maps
  └── simulationInterval loops rooms sequentially
        bindRoom(room)
        runRoomSimulationTick(room)
        sendState()
```

The current code is partially layered:

- `server/room-state.js` already stores per-room engine, scene, game objects, drag state, physics maps, contact events, and sound cooldown state.
- `server/simulation.js` and `server/physics-sim.js` are close to worker-friendly orchestration.
- But `server.js` still wires most systems through module-level mutable globals: `activeRoom`, `scene`, `gameObjects`, `physicsAggregates`, `loadTargets`, `tick`, etc.
- `bindRoom(room)` swaps those globals before input or simulation work.

That means jumping straight to workers would mostly move the global-swapping pattern into `roomWorker.js`. It would work eventually, but it would be harder to debug and easier to regress room ownership.

## Target Architecture

```text
Main thread
  ├── Express + WebSockets
  ├── RoomManager
  └── workerMap: Map<roomId, Worker>
        input/reset/player events ──→ Room Worker
        state/events/round updates ←── Room Worker

Room Worker
  └── RoomSimulationRuntime
        ├── NullEngine + Scene + Havok
        ├── gameObjects / dragState / physics maps
        ├── input handler
        ├── physics tick
        ├── level + round progression
        └── outbound messages via callback/parentPort
```

The important design point is that `RoomSimulationRuntime` should be usable in-process first, then hosted inside a worker later.

## Recommended Sequence

### Phase 1 — Extract Room Runtime, Still Single Threaded

Create a room-owned runtime module, for example:

```js
createRoomSimulationRuntime({
  room,
  assetsDir,
  port,
  config,
  serverConfig,
  emit,
})
```

The runtime should expose methods like:

```js
await runtime.init();
runtime.applyInput({ playerId, clientId, message });
runtime.tick(TICK_MS / 1000);
await runtime.reset();
await runtime.handlePlayerJoined(playerId);
await runtime.handlePlayerLeft(playerId);
runtime.dispose();
```

Move these responsibilities out of `server.js` and into the runtime:

- `enableHavokPhysics`
- `loadLevelIfPresent`
- `loadFragmentTemplates`
- `registerMeshRoots`
- `simulatePhysics`
- `sendState` payload construction
- input handler wiring
- collision/contact handling
- fragmentation and fragment cleanup
- round win detection and level advance
- room-owned timers for post-win pause and round advance

`server.js` should keep:

- HTTP/static serving
- WebSocket connections
- RoomManager assignment/spectators
- routing inbound messages to the room runtime
- routing runtime outbound messages to room clients/spectators
- process restart endpoint

At the end of Phase 1, `server.js` should no longer need `bindRoom(room)` for normal input or simulation.

The current main loop becomes:

```js
simulationInterval = setInterval(() => {
  for (const room of roomManager.activeRooms()) {
    room.runtime.tick(TICK_MS / 1000);
  }
}, TICK_MS);
```

This phase is the main ownership cleanup. It should be behavior-preserving.

### Phase 2 — Host Room Runtime In Workers

Add `server/roomWorker.js`:

```js
import { parentPort, workerData } from "node:worker_threads";
import { createRoomSimulationRuntime } from "./room-runtime.js";

const runtime = createRoomSimulationRuntime({
  room: workerData.room,
  assetsDir: workerData.assetsDir,
  port: workerData.port,
  emit: (message) => parentPort.postMessage(message),
});

await runtime.init();
parentPort.postMessage({ type: "ready", roomId: workerData.room.id });

const interval = setInterval(() => {
  runtime.tick(workerData.tickMs / 1000);
}, workerData.tickMs);

parentPort.on("message", async (message) => {
  if (message.type === "input") runtime.applyInput(message);
  if (message.type === "reset") await runtime.reset();
  if (message.type === "playerJoined") await runtime.handlePlayerJoined(message.playerId);
  if (message.type === "playerLeft") await runtime.handlePlayerLeft(message.playerId);
  if (message.type === "dispose") {
    clearInterval(interval);
    runtime.dispose();
    process.exit(0);
  }
});
```

Update `server.js` to create one worker per active room and forward messages:

```js
const worker = new Worker(new URL("./server/roomWorker.js", import.meta.url), {
  workerData: {
    room: roomSnapshot,
    assetsDir,
    port: PORT,
    tickMs: TICK_MS,
  },
});
```

`server.js` becomes the router:

- WebSocket input → `worker.postMessage({ type: "input", playerId, clientId, message })`
- worker state/event messages → send to room clients
- worker round/lobby messages → forward to room clients/spectators
- disconnects/promotions → main updates RoomManager and tells worker `playerLeft` / `playerJoined`
- room disposal → tell worker `dispose`

### Phase 3 — Worker Lifecycle And Backpressure

Add production behavior after the basic worker split works:

- Restart or close a worker cleanly on fatal error.
- Mark a room unavailable until its worker sends `ready`.
- Drop or coalesce stale input if a worker falls behind.
- Optionally report per-room tick duration / lag.
- Avoid spawning more active simulation workers than the VM can reasonably run.

## Message Protocol

### Main → Worker

| type | payload | purpose |
| --- | --- | --- |
| `input` | `{ playerId, clientId, message }` | Forward player WebSocket input |
| `playerLeft` | `{ playerId }` | Notify runtime that a player slot opened |
| `playerJoined` | `{ playerId }` | Notify runtime that a promoted/new player owns a slot |
| `reset` | `{}` | Reset current room |
| `dispose` | `{}` | Stop ticking and release runtime resources |

### Worker → Main

| type | payload | purpose |
| --- | --- | --- |
| `ready` | `{ roomId }` | Worker initialised; room can open |
| `broadcast` | `{ roomId, payload }` | Send payload to room clients |
| `spectatorBroadcast` | `{ payload }` | Send room-one state to spectators if still desired |
| `error` | `{ roomId, message }` | Runtime-level recoverable error |
| `closed` | `{ roomId }` | Worker/runtime shut down cleanly |

## Known Gotchas

- `SceneLoader.AppendAsync` in a worker currently fetches GLBs through `http://localhost:${PORT}/assets/...`. The HTTP server must be listening before workers load levels.
- Timers that currently close over a `room` object, like round-advance delays, should belong to the room runtime before moving to workers.
- Havok/WASM initialisation may happen once per worker. That is cleaner for ownership, but it can increase memory use.
- Messages crossing worker boundaries are cloned. Send compact state/event payloads, not Babylon/Havok objects.
- The main thread still owns WebSocket objects. Never pass sockets into workers.

## Will This Stop Stuttering?

It should reduce or remove stutter caused by multiple rooms sharing one main-thread simulation loop.

Right now, if room A's physics tick takes too long, room B waits because the server loops rooms sequentially. Moving rooms into workers means one heavy room is less likely to delay another room's physics and state updates.

It will not fix every possible stutter source:

- A single room can still stutter if its own physics step is too expensive.
- The e2-small only has 2 vCPUs, so many active rooms can still contend for CPU.
- Client-side rendering stutter on a 4K laptop is separate from server simulation threading.
- Network jitter, GC pauses, and excessive state payloads can still cause visible hitches.

Expected outcome: simultaneous games should interfere with each other much less. It is not a guarantee of perfectly smooth simulation under unlimited load.

## Effort Estimate

The old half-day estimate is too optimistic for the current codebase.

Recommended estimate:

- Phase 1 room runtime extraction: 1 focused day, maybe more if round/lobby behavior needs careful untangling.
- Phase 2 worker hosting: half day to 1 day once the runtime boundary is clean.
- Phase 3 lifecycle/backpressure hardening: incremental after basic worker deployment.

The safest path is to merge Phase 1 first and verify behavior is unchanged before introducing Worker threads.
