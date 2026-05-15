# Config Separation & Level Config Design

## Goal

Clean up the config system: separate client-only config from server gameplay config, eliminate the mixed `BARRAGE_CONFIG`, and add per-level config overrides so different levels can have different physics, features, and gameplay feel.

## Current State

- `public/config.js` (`BARRAGE_CONFIG`) — flat object mixing rendering, input, physics, gameplay, and fragment settings. Used by both client and server. Exposed on `window.BARRAGE_CONFIG`.
- `server/config.js` (`SERVER_CONFIG`) — small server-only config (gravity, world bounds, dynamic body defaults). Duplicates `gravity` from `BARRAGE_CONFIG`.
- No per-level config — all levels share the same global values.
- `collisions.js` has hardcoded hit-stage/crack logic. Levels only receive an `onBlockDestroyed` hook after destruction.

## Design

### 1. Config Separation

Delete `public/config.js`. Split into two files:

**`public/client/clientConfig.js`** — client-only concerns:

```js
export const CLIENT_CONFIG = {
  // Rendering
  importedLightIntensityScale: 0.01,
  fallbackLightIntensity: 0.1,
  shadowsEnabled: true,
  shadowMapSize: 2048,
  shadowBias: 0.0005,
  shadowNormalBias: 0.02,
  exposure: 1.0,
  contrast: 1.0,

  // Input
  inputInvertX: false,
  trebuchetInputInvertX: false,
  inputInvertY: false,
  inputInvertZ: false,
  cameraControlsEnabled: false,

  // Drag/release (client-side feel)
  dragHeightOffset: 0.2,
  releaseVelocityScale: 1.0,
  releaseVelocitySampleHz: 60,
  releaseVelocityFrameWindow: 5,
  releaseVelocityMinSampleDistance: 0.05,
  missilePickColliderScale: 2,

  // Aim arrow visuals
  aimArrowStartColor: "#ffffff",
  aimArrowEndColor: "#39ff14",
  aimArrowMaxLength: 4.5,
  aimArrowRadius: 0.06,
  aimArrowZOffset: 0.05,
  aimArrowMinLength: 0.12,
  aimArrowHeadLengthMin: 0.2,
  aimArrowHeadLengthMax: 0.75,
  aimArrowHeadLengthScale: 0.18,
  aimArrowHeadWidth: 0.12,
  aimArrowHeadWidthScale: 0.45,
};
```

**`server/config.js`** — expanded `SERVER_CONFIG` absorbs all gameplay values:

```js
export const SERVER_CONFIG = {
  // Engine
  gravity: -9.81,
  groundY: 0,
  physicsTimeScale: 1.5,

  // World bounds
  worldMinX: -70,
  worldMaxX: 70,
  worldMinZ: -20,
  worldMaxZ: 20,

  // Physics defaults
  dynamicMass: 6,
  dynamicFriction: 0.9,
  dynamicRestitution: 0.15,
  blockMass: 20,
  blockFriction: 0.9,
  blockRestitution: 0.15,
  staticFriction: 1.0,

  // Trebuchet mechanics
  trebuchetArmRestRotationZDegrees: 15,
  trebuchetLeftMinX: -30,
  trebuchetLeftMaxX: -5,
  trebuchetRightMinX: 5,
  trebuchetRightMaxX: 30,
  missileLoadRange: 2,
  aimMaxPullDistance: 4.5,
  aimPowerScale: 8,
  trebuchetArmPullbackMaxDegrees: 75,
  trebuchetFireVelocityMax: 33,
  fireReleaseAnimationMs: 180,
  fireReturnAnimationMs: 220,
  normalReleaseVelocityMax: 8,
  releaseVelocityMax: 80,
  dragUprightLerp: 0.25,

  // Fragments
  fragmentLifetimeMs: 5000,
  fragmentSpreadX: 4,
  fragmentSpreadY: 2,
  fragmentShrinkMs: 500,
  fragmentImmunityMs: 500,
  fragmentHitSpeedPenalty: 3,

  // Features (level-overridable)
  crackSystem: true,
  fragmentation: true,
};
```

### 2. Level Config & Resolution

Each level definition can include a `config` object that overrides any `SERVER_CONFIG` value:

```js
// server/game/levels/level1.js
export default {
  arena: "levels/level1.glb",
  config: {
    crackSystem: true,
    fragmentation: true,
  },
  setup(spawn) { /* ... */ },
  hooks: { /* optional */ },
};
```

A `getConfig(key)` helper in `server/config.js` resolves values with level-first priority:

```js
export function getConfig(key) {
  const levelConfig = getActiveLevel()?.def.config;
  return levelConfig?.[key] ?? SERVER_CONFIG[key];
}
```

All server code replaces direct `BARRAGE_CONFIG.x` and `SERVER_CONFIG.x` reads with `getConfig("x")`. This makes level overrides take effect everywhere automatically.

### 3. Collision Hook Refactor

`collisions.js` reads level config to decide behavior instead of hardcoding hit-stage logic.

New collision flow:

```
missile hits block
  → guard checks (loaded, removing, dedup)
  → check for onBlockDestroyed hook on level
  → if hook defined: run hook INSTEAD of default behavior
  → if no hook:
      → read getConfig("crackSystem")
      → if crackSystem ON and hitStage < maxHits:
          increment hitStage, broadcast "blockHit"
      → else (final hit or crackSystem OFF):
          if getConfig("fragmentation"): shatterBlock(block, missile)
          else: deleteBlock(block)
```

Priority: **hook defined → run hook, skip default. No hook → config drives behavior.**

`level1.js` no longer needs `onBlockDestroyed` — config handles it. Hooks remain available for custom per-level logic (e.g., spawn extra missiles on block death).

### 4. Sending Config to Client

Some server config values are needed client-side (aim arrow, shrink animation, drag feel). The server sends the resolved config in existing broadcast messages.

**Server side** — include filtered config in `roundStarted`, `matchReset`, and initial connection:

```js
const CLIENT_RELEVANT_KEYS = [
  "trebuchetArmRestRotationZDegrees",
  "normalReleaseVelocityMax",
  "releaseVelocityMax",
  "aimMaxPullDistance",
  "fragmentShrinkMs",
  "dragUprightLerp",
];

export function getClientRelevantConfig() {
  const result = {};
  for (const key of CLIENT_RELEVANT_KEYS) {
    result[key] = getConfig(key);
  }
  return result;
}
```

Included in:
- `welcome` message (`connections.js`) — client has config immediately on connect
- `roundStarted` broadcast — updated config each new round
- `matchReset` broadcast — config after match reset

**Client side** — store and expose:

```js
// network.js
let serverConfig = {};

export function getServerConfig(key) {
  return serverConfig[key];
}

// On roundStarted / matchReset / init:
if (message.config) serverConfig = message.config;
```

Client code replaces `CONFIG.trebuchetArmRestRotationZDegrees` → `getServerConfig("trebuchetArmRestRotationZDegrees") ?? 15` (with fallback for pre-first-message).

## Files Changed

| File | Change |
|------|--------|
| `public/config.js` | Delete |
| `public/client/clientConfig.js` | New — client-only config |
| `public/client/engine.js` | Import `CLIENT_CONFIG` instead of `BARRAGE_CONFIG` |
| `public/client/aim.js` | Use `CLIENT_CONFIG` for arrow visuals, `getServerConfig()` for shared values |
| `public/client/input.js` | Use `CLIENT_CONFIG` for input settings, `getServerConfig()` for shared values |
| `public/client/level.js` | Use `CLIENT_CONFIG` for rendering, `getServerConfig()` for `fragmentShrinkMs` |
| `public/client/network.js` | Add `serverConfig` state and `getServerConfig()` export |
| `server/config.js` | Expand `SERVER_CONFIG`, add `getConfig()`, `getClientRelevantConfig()` |
| `server/game/collisions.js` | Use `getConfig()`, implement config-driven crack/fragmentation logic |
| `server/game/fragmentation.js` | Use `getConfig()` instead of `BARRAGE_CONFIG` |
| `server/game/simulation.js` | Use `getConfig()` instead of `BARRAGE_CONFIG` |
| `server/game/entities.js` | Use `getConfig()` instead of `BARRAGE_CONFIG` |
| `server/game/trebuchet.js` | Use `getConfig()` instead of `BARRAGE_CONFIG` |
| `server/game/physics.js` | Use `getConfig()` instead of `BARRAGE_CONFIG` |
| `server/game/templateRegistry.js` | Use `getConfig()` instead of `BARRAGE_CONFIG` |
| `server/game/modeRunner.js` | Include config in broadcasts, expose for `getConfig()` |
| `server/game/levels/level1.js` | Add `config` block, remove `onBlockDestroyed` hook |
| `server/net/connections.js` | Include config in `welcome` message |

## Circular Import Note

`getConfig()` needs access to `getActiveLevel()` from `modeRunner.js`, but `modeRunner.js` imports from `server/config.js`. To avoid a circular dependency, `getConfig()` accepts the level config via a setter (e.g., `setActiveLevelConfig(config)` called by `modeRunner.js` when a level loads) rather than importing `getActiveLevel()`.
