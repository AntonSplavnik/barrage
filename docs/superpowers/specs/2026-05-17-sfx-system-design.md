# SFX System Design

## Overview

Server-authoritative sound event dispatch with an independent client-side audio system. The server detects collisions and game events, labels them with an effect name and raw physics data (speed, position). The client audio system independently computes volume, pitch, panning, and cooldowns from that data.

## Architecture

```
Server (collision detection)          Wire Protocol           Client Audio System
┌──────────────────────────┐    ┌──────────────────────┐    ┌──────────────────────────┐
│ Detects collision pairs  │    │ { kind: "sfx",       │    │ Receives sfx events      │
│ Computes relative speed  │───▶│   effect: "...",     │───▶│ Looks up effect config   │
│ Determines effect name   │    │   speed: 14.2,       │    │ Computes volume from     │
│ Sends position + speed   │    │   x: 12.3 }         │    │   speed curve            │
│                          │    │                      │    │ Applies pitch + random   │
│ NO audio math            │    │ Raw physics data     │    │ Computes stereo pan      │
│ NO volume/pitch          │    │ only                 │    │ Enforces cooldowns       │
└──────────────────────────┘    └──────────────────────┘    └──────────────────────────┘
```

## Wire Protocol

Three event kinds, sent inside the existing `{ type: "event", events: [...] }` messages:

### One-shot sound
```js
{ kind: "sfx", effect: "missile_hit_block", speed: 14.2, x: 12.3 }
```

### Start persistent/looping sound
```js
{ kind: "sfxStart", effect: "trebuchet_stretch", instanceId: "trebucheL", x: -20 }
```

### Stop persistent sound
```js
{ kind: "sfxStop", instanceId: "trebucheL" }
```

Fields:
- `effect` — string identifier matching the audio config table
- `speed` — relative impact speed in m/s (only for impacts)
- `x` — world x position (for stereo panning)
- `instanceId` — unique key for persistent sounds (typically the object ID)

## Server Side

### New module: `server/game/sound.js`

Responsible for:
- Constructing sfx event objects (`sfxEvent`, `sfxStartEvent`, `sfxStopEvent`)
- Providing helpers called from collision handlers and input handlers
- No audio config, no volume/pitch computation

Exports:
```js
export function sfxEvent(effect, { speed, x })
export function sfxStartEvent(effect, instanceId, { x })
export function sfxStopEvent(instanceId)
export function broadcastSfx(effect, { speed, x })
export function broadcastSfxStart(effect, instanceId, { x })
export function broadcastSfxStop(instanceId)
```

### Expand `server/game/collisions.js`

Currently handles: missile→block, missile→fragment.

Expand to detect all collision pairs relevant to sound:

| Collision Pair | Effect Name | Speed Source |
|---|---|---|
| Missile → block (no crack) | `missile_hit_block` | `hypot(missile.vx, vy, vz)` |
| Missile → block (cracks it) | `missile_crack_block` | same |
| Missile → block (breaks it) | `missile_fragments_block` | same |
| Missile → fragment | `missile_hits_fragment` | missile speed |
| Missile → ground | `missile_hit_ground` | missile speed |
| Missile → trebuchet | `missile_hit_trebuchet` | missile speed |
| Missile → missile | `missile_hit_missile` | relative speed between both |
| Missile → king | `king_hit` | missile speed |
| Block → ground | `block_hit_ground` | block speed |
| Block → block | `block_hit_block` | relative speed |
| Missile bomb detonation | `missile_bomb_hit` | missile speed |

The collision handler computes relative speed as:
```js
Math.hypot(
  (objA.vx ?? 0) - (objB.vx ?? 0),
  (objA.vy ?? 0) - (objB.vy ?? 0),
  (objA.vz ?? 0) - (objB.vz ?? 0)
)
```

Position `x` is the midpoint: `(objA.x + objB.x) / 2`.

### Trebuchet sounds in `server/game/input.js`

- `aimStart` action → `broadcastSfxStart("trebuchet_stretch", trebuchet.id, { x: trebuchet.x })`
- `aimRelease` action → `broadcastSfxStop(trebuchet.id)` + `broadcastSfx("trebuchet_release", { speed: null, x: trebuchet.x })`

### Block hit sounds in `server/game/collisions.js` / `fragmentation.js`

- `handleMissileBlockHit` (crack stage) → `broadcastSfx("missile_crack_block", { speed, x })`
- `shatterBlock` (full break) → `broadcastSfx("missile_fragments_block", { speed, x })`

## Client Side

### New module: `public/client/sound.js`

Self-contained audio system using raw Web Audio API. Owns all audio tuning config internally.

**Audio Config (inside the module):**
```js
const SOUND_CONFIG = {
  enabled: true,
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
    trebuchet_release:      { file: "/sounds/trebuchet_release.mp3", volume: 0.75, pitch: 1.0 },
    trebuchet_stretch:      { file: "/sounds/trebuche-stretch.mp3", volume: 0.7, pitch: 1.0 },
    block_hit_ground:       { file: "/sounds/block_hit_ground.mp3", volume: 0.55, pitch: 0.9 },
    block_hit_block:        { file: "/sounds/block-hit-block.mp3", volume: 0.65, pitch: 0.95, cooldownMs: 220 },
    missile_hit_ground:     { file: "/sounds/missile-hit-ground.mp3", volume: 0.55, pitch: 1.0, cooldownMs: 180 },
    missile_hit_block:      { file: "/sounds/missile_hit_block.mp3", volume: 0.65, pitch: 0.98, cooldownMs: 220 },
    missile_hit_missile:    { file: "/sounds/missile-hit-missile.mp3", volume: 0.65, pitch: 1.0 },
    missile_hit_trebuchet:  { file: "/sounds/missile_hit_trebuchet.mp3", volume: 0.8, pitch: 0.92, cooldownMs: 220 },
    missile_fragments_block:{ file: "/sounds/missile_fragments_block.mp3", volume: 0.95, pitch: 0.96 },
    missile_crack_block:    { file: "/sounds/missile_crack_block.mp3", volume: 0.75, pitch: 1.0 },
    missile_hits_fragment:  { file: "/sounds/missile_hits_fragment.mp3", volume: 0.7, pitch: 1.04 },
    king_hit:               { file: "/sounds/king_hit.mp3", volume: 1.0, pitch: 1.0 },
    missile_bomb_hit:       { file: "/sounds/missile_bomb-hit.mp3", volume: 1.0, pitch: 0.9 },
  },
};
```

**Exports:**
```js
export function createSoundSystem()
// Returns:
// {
//   handleSfxEvent(evt)  — routes sfx/sfxStart/sfxStop events
//   enable()
//   disable()
//   toggle()
//   isEnabled()
// }
```

**Internal responsibilities:**
1. **Loading** — fetch + decode all mp3 files on enable
2. **Volume computation** — `speed` field mapped through min/max curve, multiplied by effect base volume
3. **Pitch** — base pitch from config ± random variation
4. **Pan** — world `x` mapped linearly to [-1, 1] stereo
5. **Cooldown** — per-effect (or per effect+position bucket) timestamp, skip if too recent
6. **Playback** — Web Audio `BufferSource` → gain split (L/R for pan) → master gain → destination
7. **Instance management** — `sfxStart` creates looping source keyed by instanceId, `sfxStop` kills it

### Integration: `public/client/network.js`

In the event handler loop:
```js
if (evt.kind === "sfx" || evt.kind === "sfxStart" || evt.kind === "sfxStop") {
  soundSystem.handleSfxEvent(evt);
}
```

### UI: `public/index.html`

Add SFX toggle button to HUD:
```html
<button id="sfx-toggle" type="button" title="Toggle sound effects">🔊</button>
```

Wire up in `public/client/index.js`:
```js
import { createSoundSystem } from "./sound.js";
const soundSystem = createSoundSystem();
document.getElementById("sfx-toggle").addEventListener("click", () => soundSystem.toggle());
```

## Assets

13 `.mp3` files in `public/sounds/`, copied from rufus-prototype branch:

```
public/sounds/
├── block-hit-block.mp3
├── block_hit_ground.mp3
├── king_hit.mp3
├── missile-hit-ground.mp3
├── missile-hit-missile.mp3
├── missile_bomb-hit.mp3
├── missile_crack_block.mp3
├── missile_fragments_block.mp3
├── missile_hit_block.mp3
├── missile_hit_trebuchet.mp3
├── missile_hits_fragment.mp3
├── trebuche-stretch.mp3
└── trebuchet_release.mp3
```

## Collision System Expansion

The current `initCollisions()` in `server/game/collisions.js` only processes missile collisions:
```js
if (!missileA && !missileB) return;  // <-- currently skips non-missile collisions
```

Changes needed:
1. Remove the early return for non-missile pairs
2. Add entity type detection: `isGroundName`, `isTrebuchetName`, `isKingName` (some already exist in `entities.js`, others need adding)
3. Route each detected pair to the appropriate game logic + sfx broadcast
4. Compute impact speed at collision time from object velocities stored in game state

### Arena collider prefix fix (`server/game/physics.js`)

Arena colliders currently use `arena-col-{name}` without the `physics-` prefix that all other bodies have. This means `objectIdFromBody()` returns `null` for them, making arena collider collisions undetectable in the collision handler.

Fix: add the `physics-` prefix to match the convention:
```js
const colNode = new TransformNode(`physics-arena-col-${node.name}`, scene);
```

After this fix, `objectIdFromBody()` returns `arena-col-Plane-ColVis` for the ground and `arena-col-barrier-Collider.001` etc. for barriers.

### Ground detection

Add `isGroundName()` to `entities.js`:
```js
export function isGroundName(name) {
  return name === "ground" || name === "arena-col-Plane-ColVis";
}
```

The `"ground"` case covers the fallback ground body (created when no GLB colliders exist). The `"arena-col-Plane-ColVis"` case covers the level1.glb arena collider (Blender node `Plane-ColVis`).

### Collision handler structure

```js
plugin.onCollisionObservable.add((event) => {
  if (event.type !== "COLLISION_STARTED") return;
  // ... resolve objects ...

  // Missile collisions (existing + new)
  if (missile && block)     → handleMissileBlockHit + sfx
  if (missile && fragment)  → handleMissileFragmentHit + sfx
  if (missile && ground)    → broadcastSfx("missile_hit_ground", ...)
  if (missile && trebuchet) → broadcastSfx("missile_hit_trebuchet", ...)
  if (missile && king)      → broadcastSfx("king_hit", ...) + game logic
  if (missileA && missileB) → broadcastSfx("missile_hit_missile", ...)

  // Non-missile collisions (new)
  if (block && ground)      → broadcastSfx("block_hit_ground", ...)
  if (blockA && blockB)     → broadcastSfx("block_hit_block", ...)
});
```

## Summary of New/Modified Files

| File | Change |
|------|--------|
| `server/game/physics.js` | **Fix** — add `physics-` prefix to arena collider TransformNodes |
| `server/game/sound.js` | **New** — sfx event constructors + broadcast helpers |
| `server/game/collisions.js` | **Expand** — detect all pair types, emit sfx events |
| `server/game/entities.js` | **Add** — `isGroundName()` if not present |
| `server/game/input.js` | **Add** — trebuchet stretch start/stop sfx |
| `server/game/fragmentation.js` | **Add** — block break sfx |
| `public/client/sound.js` | **New** — full audio system |
| `public/client/network.js` | **Add** — route sfx events to sound system |
| `public/client/index.js` | **Add** — init sound system, wire toggle button |
| `public/index.html` | **Add** — sfx toggle button |
| `public/sounds/*.mp3` | **New** — 13 audio assets |
