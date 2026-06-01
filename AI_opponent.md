# AI Opponent — Implementation Plan

## Architecture

- Player is always **host** (runs the game worker in their browser)
- AI runs as a local second input source in the same browser tab
- No WebRTC, no server changes for gameplay
- AI communicates with the worker via the same `postMessage` interface as the host player

## Files

| File | Change |
|------|--------|
| `public/config.js` | Add `AI_OPPONENTS` export (done) |
| `public/ai-player.js` | New: `AiPlayer` class |
| `public/lobby.html` | Add "Challenge an AI" section |
| `public/client.js` | Handle `mode=ai` URL param — skip WebRTC, boot worker, instantiate AiPlayer |

## `AI_OPPONENTS` config (in config.js)

```js
{ id, name, description, speed, accuracy }
// speed   0–1 — controls ms-per-unit drag interpolation rate
// accuracy 0–1 — controls angular aim jitter (1 = perfect, 0 = wild)
```

## Lobby changes

- New section below "Join a game": **"Challenge an AI"**
- Two cards, one per AI opponent (Genghis, Caesar), always visible
- Clicking navigates to `/?mode=ai&opponent=<id>`
- Distinct visual style from human session rows (amber/gold tint)

## `AiPlayer` class

```
constructor(postToWorker, onWorkerMessage, config, aiRole)
  - subscribes to worker state via onWorkerMessage callback
  - starts state machine once worker sends 'matched'

State machine:
  IDLE
  → FIND_MISSILE    pick nearest own missile by highest Y, closest to own side
  → DRAG_TO_LOAD    interpolate dragMove msgs toward (trebuchet.x, trebuchet.y + 3.5)
                    speed controlled by config.speed
  → WAIT_LOADED     poll state until missile.loadedInto === own trebuchet id
  → AIM_START       send aimStart at trebuchet position
  → AIM_PULL        interpolate aimMove msgs toward calculated pull point
                    pull point = away from center, distance based on trajectory to enemy king
                    add random angular jitter scaled by (1 - accuracy)
  → FIRE            send aimRelease
  → IDLE (repeat with next missile)
```

## Aiming math

- Enemy king position read from state (object with `king` in id, opposite side)
- Calculate angle from trebuchet to king
- Trebuchet fires in direction of sideSign (left trebuchet fires right, vice versa)
- Pull-back direction is opposite to fire direction (away from center)
- Pull distance determines power — solve for required velocity using config power scale
- Add `(1 - accuracy) * MAX_JITTER_DEGREES` random angle offset

## Hardcoded constants

```js
const LOAD_TARGET_OFFSET_Y = 3.5;  // above trebuchet base
const DRAG_UNITS_PER_MS_BASE = 0.015; // at speed=1.0
const AIM_UNITS_PER_MS_BASE = 0.01;
const MAX_AIM_JITTER_DEG = 30;
```

## client.js changes

- On page load, read `?mode=ai&opponent=<id>` from URL
- Look up AI config from `AI_OPPONENTS` by id
- Boot worker as host (same as `mode=host` but no session API call)
- Send `playerConnect` with human player as Player_1
- On worker `matched` message, instantiate `AiPlayer` for Player_2
- AiPlayer's `postToWorker` wraps `worker.postMessage({ type: "input", role: "Player_2", ... })`

## What the worker already supports

- Two players sending input independently — no changes needed
- State broadcast to both roles each tick — AI reads this
- `dragStart / dragMove / dragEnd` for missile loading — AI uses these
- `aimStart / aimMove / aimRelease` for firing — AI uses these

## Out of scope (this pass)

- AI portrait / display name in UI (can add later)
- AI stats / leaderboard tracking
- Multiple simultaneous AI rounds
- AI difficulty progression during match
