# Prediction Arc Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a server-computed trajectory prediction arc that renders as dotted spheres while a player aims a trebuchet.

**Architecture:** Server computes 32 arc points via damped projectile physics and sends them to the aiming client only via per-client state serialization. Client renders points as thin-instanced spheres with power-based color and fade-out on fire.

**Tech Stack:** Node.js server, Babylon.js client (thin instances, StandardMaterial), WebSocket per-client filtering.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `server/game/trajectoryArc.js` | **Create** | Pure arc math: damped position, flight duration, arc points |
| `server/config.js` | Modify | Add `missileLinearDamping`, `shotArc*` config keys |
| `server/game/physics.js` | Modify | Replace hardcoded `0.15` with `getConfig("missileLinearDamping")` |
| `server/game/trebuchet.js` | Modify | Compute arc in `updateTrebuchetAim()`, clear on release, add `releaseAimForClient()` |
| `server/game/entities.js` | Modify | `toWireObject(object, clientId)` — include arc for aiming player only |
| `server/net/broadcast.js` | Modify | Per-client serialization in `sendState()` |
| `server/net/connections.js` | Modify | Call `releaseAimForClient()` on disconnect |
| `public/client/state.js` | None | `applyState()` already stores full wire object — no changes needed |
| `public/client/network.js` | None | `removeStaleVisuals → ensureVisualsForState → applyState` ordering is correct — no changes needed |
| `public/client/clientConfig.js` | Modify | Add `shotArc*` visual config keys |
| `public/client/shotArcRenderer.js` | **Create** | Thin-instanced dot renderer with fade-out |
| `public/client/aim.js` | Modify | Wire renderer to aim state, fade on fire |
| `public/client/level.js` | Modify | Create/dispose renderer on level lifecycle |

---

### Task 1: Server Config — Add `missileLinearDamping` and `shotArc*` Keys

**Files:**
- Modify: `server/config.js:69-76`

- [ ] **Step 1: Add config keys**

In `server/config.js`, add `missileLinearDamping` after `missileDamageMinSpeed` (line 70), and add a new `// Shot arc` section after `// Bombs` (after line 76):

```js
  // Missiles
  missileDamageMinSpeed: 10,
  missileLinearDamping: 0.15,

  // Bombs
  bombBlastRadius: 5,
  bombMaxDamage: 3,
  bombMaxForce: 200,
  bombDetonationMinSpeed: 10,

  // Shot arc
  shotArcDotCount: 32,
  shotArcFraction: 0.67,
  shotArcMaxDuration: 4,
  shotArcGroundY: 0,
```

- [ ] **Step 2: Verify config loads**

Run: `node -e "import('./server/config.js').then(c => { console.log(c.SERVER_CONFIG.missileLinearDamping, c.SERVER_CONFIG.shotArcDotCount) })"`

Expected: `0.15 32`

- [ ] **Step 3: Commit**

```bash
git add server/config.js
git commit -m "feat: add missileLinearDamping and shotArc config keys"
```

---

### Task 2: Replace Hardcoded Damping in `physics.js`

**Files:**
- Modify: `server/game/physics.js:192,258`

- [ ] **Step 1: Add `getConfig` import**

At the top of `server/game/physics.js`, add `getConfig` to the existing imports from `../config.js`. If there's no existing import from `../config.js`, add:

```js
import { getConfig } from "../config.js";
```

- [ ] **Step 2: Replace hardcoded values**

Replace line 192:
```js
// Before:
aggregate.body.setLinearDamping(isTrebuchetName(object.id) ? 2.2 : 0.15);
// After:
aggregate.body.setLinearDamping(isTrebuchetName(object.id) ? 2.2 : getConfig("missileLinearDamping"));
```

Replace line 258:
```js
// Before:
aggregate.body.setLinearDamping(isTrebuchetName(object.id) ? 2.2 : 0.15);
// After:
aggregate.body.setLinearDamping(isTrebuchetName(object.id) ? 2.2 : getConfig("missileLinearDamping"));
```

- [ ] **Step 3: Verify no other hardcoded 0.15 damping exists**

Run: `grep -n "0\.15" server/game/physics.js`

Expected: No remaining `setLinearDamping` lines with hardcoded `0.15`.

- [ ] **Step 4: Commit**

```bash
git add server/game/physics.js
git commit -m "refactor: use config for missile linear damping instead of hardcoded 0.15"
```

---

### Task 3: Trajectory Arc Math — `server/game/trajectoryArc.js`

**Files:**
- Create: `server/game/trajectoryArc.js`

- [ ] **Step 1: Create `trajectoryArc.js` with all three functions**

Create `server/game/trajectoryArc.js`:

```js
const DAMPING_EPSILON = 1e-6;
const SIM_STEP = 1 / 60;

function dampedPosition(startPoint, velocity, gravity, damping, t) {
  if (!startPoint || !velocity || Number.isNaN(t)) {
    return { x: 0, y: 0, z: 0 };
  }

  if (Math.abs(damping) < DAMPING_EPSILON) {
    return {
      x: startPoint.x + velocity.x * t,
      y: startPoint.y + velocity.y * t + 0.5 * gravity * t * t,
      z: startPoint.z + velocity.z * t,
    };
  }

  const decay = Math.exp(-damping * t);
  const velScale = (1 - decay) / damping;
  const gravScale = (t - velScale) / damping;

  return {
    x: startPoint.x + velocity.x * velScale,
    y: startPoint.y + velocity.y * velScale + gravity * gravScale,
    z: startPoint.z + velocity.z * velScale,
  };
}

function dampedFlightDurationToGround(startPoint, velocity, gravity, damping, groundY, maxDuration) {
  if (!startPoint || !velocity) return 0;
  if (Number.isNaN(groundY) || Number.isNaN(maxDuration)) return 0;

  if (Math.abs(damping) < DAMPING_EPSILON) {
    const a = 0.5 * gravity;
    const b = velocity.y;
    const c = startPoint.y - groundY;

    if (Math.abs(a) < DAMPING_EPSILON) {
      return b < 0 ? Math.min(-c / b, maxDuration) : maxDuration;
    }

    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return maxDuration;

    const sqrtD = Math.sqrt(discriminant);
    const t1 = (-b + sqrtD) / (2 * a);
    const t2 = (-b - sqrtD) / (2 * a);

    let tHit = maxDuration;
    if (t1 > 0 && t1 < tHit) tHit = t1;
    if (t2 > 0 && t2 < tHit) tHit = t2;
    return Math.min(tHit, maxDuration);
  }

  let prevY = startPoint.y;
  for (let t = SIM_STEP; t <= maxDuration; t += SIM_STEP) {
    const pos = dampedPosition(startPoint, velocity, gravity, damping, t);
    if (pos.y <= groundY) {
      const prevT = t - SIM_STEP;
      const fraction = (prevY - groundY) / Math.max(0.0001, prevY - pos.y);
      return prevT + SIM_STEP * fraction;
    }
    prevY = pos.y;
  }

  return maxDuration;
}

export function computeArcPoints({ startPoint, velocity, gravity, damping, dotCount, arcFraction, maxDuration, groundY }) {
  if (!startPoint || !velocity) return [];
  if (Number.isNaN(gravity) || Number.isNaN(damping)) return [];

  const flightDuration = dampedFlightDurationToGround(startPoint, velocity, gravity, damping, groundY, maxDuration);
  const arcDuration = Math.min(flightDuration * arcFraction, maxDuration);
  if (arcDuration <= 0 || dotCount <= 0) return [];

  if (dotCount === 1) return [{ ...dampedPosition(startPoint, velocity, gravity, damping, 0) }];

  const points = [];
  for (let i = 0; i < dotCount; i++) {
    const t = (i / (dotCount - 1)) * arcDuration;
    points.push(dampedPosition(startPoint, velocity, gravity, damping, t));
  }

  return points;
}
```

- [ ] **Step 2: Verify module loads**

Run: `node -e "import('./server/game/trajectoryArc.js').then(m => console.log(typeof m.computeArcPoints))"`

Expected: `function`

- [ ] **Step 3: Quick sanity check — straight-up shot**

Run:
```bash
node -e "
import('./server/game/trajectoryArc.js').then(m => {
  const pts = m.computeArcPoints({
    startPoint: { x: 0, y: 2, z: 0 },
    velocity: { x: 10, y: 15, z: 0 },
    gravity: -9.81,
    damping: 0.15,
    dotCount: 5,
    arcFraction: 0.67,
    maxDuration: 4,
    groundY: 0,
  });
  console.log('count:', pts.length);
  console.log('first:', pts[0]);
  console.log('last:', pts[pts.length - 1]);
  console.log('y rises then falls:', pts[1].y > pts[0].y, pts[pts.length-1].y < pts[1].y);
})
"
```

Expected: 5 points, first at `{x:0, y:2, z:0}`, y rises then falls → `true true`.

- [ ] **Step 4: Edge case — null inputs return empty**

Run:
```bash
node -e "
import('./server/game/trajectoryArc.js').then(m => {
  console.log('null start:', m.computeArcPoints({ startPoint: null, velocity: {x:1,y:1,z:0}, gravity: -9.81, damping: 0.15, dotCount: 32, arcFraction: 0.67, maxDuration: 4, groundY: 0 }));
  console.log('null vel:', m.computeArcPoints({ startPoint: {x:0,y:2,z:0}, velocity: null, gravity: -9.81, damping: 0.15, dotCount: 32, arcFraction: 0.67, maxDuration: 4, groundY: 0 }));
  console.log('NaN gravity:', m.computeArcPoints({ startPoint: {x:0,y:2,z:0}, velocity: {x:1,y:1,z:0}, gravity: NaN, damping: 0.15, dotCount: 32, arcFraction: 0.67, maxDuration: 4, groundY: 0 }));
})
"
```

Expected: All three return `[]`.

- [ ] **Step 5: Zero-damping path (standard kinematics)**

Run:
```bash
node -e "
import('./server/game/trajectoryArc.js').then(m => {
  const pts = m.computeArcPoints({
    startPoint: { x: 0, y: 0, z: 0 },
    velocity: { x: 10, y: 10, z: 0 },
    gravity: -10,
    damping: 0,
    dotCount: 3,
    arcFraction: 1.0,
    maxDuration: 10,
    groundY: 0,
  });
  console.log('count:', pts.length);
  console.log('first:', pts[0]);
  console.log('last y near 0:', Math.abs(pts[pts.length - 1].y) < 0.1);
})
"
```

Expected: 3 points, first at origin, last y near 0 (projectile lands).

- [ ] **Step 6: Commit**

```bash
git add server/game/trajectoryArc.js
git commit -m "feat: add trajectory arc math module"
```

---

### Task 4: Arc Computation in `updateTrebuchetAim()`

**Files:**
- Modify: `server/game/trebuchet.js:1-12,141-172,174-194,206-236`

- [ ] **Step 1: Add imports**

In `server/game/trebuchet.js`, add a new import for the arc module (after line 12):

```js
import { computeArcPoints } from "./trajectoryArc.js";
```

- [ ] **Step 2: Add `clearArcFields` helper**

Add after the imports, before `updateTrebuchetFireState` (before line 17):

```js
function clearArcFields(trebuchet) {
  trebuchet.shotVelocity = null;
  trebuchet.shotStartPoint = null;
  trebuchet.shotArcPoints = null;
  trebuchet.powerRatio = null;
}
```

- [ ] **Step 3: Add arc computation to `updateTrebuchetAim()`**

After line 171 (`trebuchet.armAngle = restAngle + pullRatio * maxExtra;`), add arc computation before the closing `}`:

```js
  if (isWrongDirection) {
    clearArcFields(trebuchet);
    return;
  }

  const powerScale = getConfig("aimPowerScale");
  const shotDirectionX = trebuchet.player === 1 ? 1 : -1;
  const shotVelocity = releaseVelocityForObject({ id: "missile" }, {
    x: Math.abs(start.x - current.x) * powerScale * shotDirectionX,
    y: (start.y - current.y) * powerScale,
    z: (start.z - current.z) * powerScale,
  }, trebuchetFireVelocityMax());

  const prevAngle = trebuchet.armAngle;
  trebuchet.armAngle = restArmAngleForTrebuchet();
  const shotStartPoint = loadTargetForTrebuchet(trebuchet);
  trebuchet.armAngle = prevAngle;
  loadTargetForTrebuchet(trebuchet);

  if (!shotStartPoint) {
    clearArcFields(trebuchet);
    return;
  }

  trebuchet.shotVelocity = shotVelocity;
  trebuchet.shotStartPoint = shotStartPoint;
  trebuchet.shotArcPoints = computeArcPoints({
    startPoint: shotStartPoint,
    velocity: shotVelocity,
    gravity: getConfig("gravity"),
    damping: getConfig("missileLinearDamping"),
    dotCount: getConfig("shotArcDotCount"),
    arcFraction: getConfig("shotArcFraction"),
    maxDuration: getConfig("shotArcMaxDuration"),
    groundY: getConfig("shotArcGroundY"),
  });

  const speed = Math.hypot(shotVelocity.x, shotVelocity.y, shotVelocity.z);
  trebuchet.powerRatio = Math.min(1, speed / trebuchetFireVelocityMax());
```

- [ ] **Step 4: Clear arc fields in `beginTrebuchetRelease()`**

At the end of `beginTrebuchetRelease()` (line 194, after `trebuchet.releaseElapsedMs = 0;`), add:

```js
  clearArcFields(trebuchet);
```

- [ ] **Step 5: Clear arc fields in `releaseLoadedMissileFromTrebuchet()`**

After the existing aim field clears (line 229-231: `trebuchet.aimedBy = null`, `trebuchet.aimStart = null`, `trebuchet.aimCurrent = null`), add:

```js
  clearArcFields(trebuchet);
```

- [ ] **Step 6: Add `releaseAimForClient()` export**

Add a new exported function after `releaseLoadedMissileFromTrebuchet`:

```js
export function releaseAimForClient(clientId) {
  for (const trebuchet of gameObjects.values()) {
    if (!isTrebuchetName(trebuchet.id)) continue;
    if (trebuchet.aimedBy !== clientId) continue;

    trebuchet.fireState = ARM_STATE_IDLE;
    trebuchet.armAngle = restArmAngleForTrebuchet();
    trebuchet.aimedBy = null;
    trebuchet.aimStart = null;
    trebuchet.aimCurrent = null;
    clearArcFields(trebuchet);
  }
}
```

- [ ] **Step 7: Verify server starts**

Run: `cd /Users/antonsplavnik/Documents/Programming/Babylon/barrage && timeout 5 node server/main.js 2>&1 || true`

Expected: Server starts without import/syntax errors. It will timeout after 5s — that's fine, just checking for startup errors.

- [ ] **Step 8: Commit**

```bash
git add server/game/trebuchet.js
git commit -m "feat: compute prediction arc during trebuchet aim"
```

---

### Task 5: Per-Client Wire Protocol — `toWireObject` and `sendState`

**Files:**
- Modify: `server/game/entities.js:9-29`
- Modify: `server/net/broadcast.js:1-22`

- [ ] **Step 1: Update `toWireObject` signature**

In `server/game/entities.js`, change `toWireObject` (line 9) to accept `clientId`:

```js
export function toWireObject(object, clientId) {
```

- [ ] **Step 2: Add arc fields to `toWireObject`**

After line 23 (`...(object.armAngle !== undefined ? { armAngle: object.armAngle, fireState: object.fireState } : {}),`), add:

```js
    ...(object.fireState === ARM_STATE_AIMING && object.aimedBy === clientId
      ? { shotArcPoints: object.shotArcPoints, powerRatio: object.powerRatio }
      : {}),
```

This line uses `ARM_STATE_AIMING` which is already defined on line 5 in the same file — no import needed.

- [ ] **Step 3: Update `sendState()` for per-client serialization**

Replace the entire `sendState()` function in `server/net/broadcast.js` (lines 13-22):

```js
export function sendState() {
  const base = {
    type: "state",
    tick: gameState.tick,
    serverTime: Date.now(),
    roundNumber: gameState.roundNumber,
    scores: gameState.scores,
  };

  for (const client of clients.values()) {
    if (client.socket.readyState !== client.socket.OPEN) continue;
    const objects = [...gameObjects.values()].map(o => toWireObject(o, client.id));
    client.socket.send(JSON.stringify({ ...base, objects }));
  }
}
```

- [ ] **Step 4: Verify server starts**

Run: `cd /Users/antonsplavnik/Documents/Programming/Babylon/barrage && timeout 5 node server/main.js 2>&1 || true`

Expected: No errors on startup.

- [ ] **Step 5: Commit**

```bash
git add server/game/entities.js server/net/broadcast.js
git commit -m "feat: per-client state serialization with arc data for aiming player"
```

---

### Task 6: Disconnect Cleanup — `releaseAimForClient`

**Files:**
- Modify: `server/net/connections.js:1-6,35-38`

- [ ] **Step 1: Add import**

In `server/net/connections.js`, add the import for `releaseAimForClient` (after line 6):

```js
import { releaseAimForClient } from "../game/trebuchet.js";
```

- [ ] **Step 2: Call `releaseAimForClient` on disconnect**

In the `socket.on("close")` handler (line 35-38), add the call before `clients.delete`:

```js
    socket.on("close", () => {
      releaseDragForClient(clientId);
      releaseAimForClient(clientId);
      clients.delete(clientId);
    });
```

- [ ] **Step 3: Verify server starts**

Run: `cd /Users/antonsplavnik/Documents/Programming/Babylon/barrage && timeout 5 node server/main.js 2>&1 || true`

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add server/net/connections.js
git commit -m "fix: clean up aim state when client disconnects"
```

---

### Task 7: Client Config — Add `shotArc*` Visual Keys

**Files:**
- Modify: `public/client/clientConfig.js:1-35`

- [ ] **Step 1: Add shot arc config keys**

In `public/client/clientConfig.js`, add a new section after the aim arrow visuals section (after line 34, before the closing `};`):

```js
  // Shot arc visuals
  shotArcDotCount: 32,
  shotArcDotSize: 0.14,
  shotArcFadeMs: 1500,
  shotArcZOffset: 0.08,
  shotArcDimColor: "#262626",
  shotArcBrightColor: "#ffffff",
```

- [ ] **Step 2: Commit**

```bash
git add public/client/clientConfig.js
git commit -m "feat: add shot arc visual config"
```

---

### Task 8: Shot Arc Renderer — `public/client/shotArcRenderer.js`

**Files:**
- Create: `public/client/shotArcRenderer.js`

- [ ] **Step 1: Create the renderer module**

Create `public/client/shotArcRenderer.js`:

```js
const { Color3, Matrix, MeshBuilder, StandardMaterial } = BABYLON;

export function createShotArcRenderer(scene, config) {
  const dotCount = config.shotArcDotCount ?? 32;
  const dotSize = config.shotArcDotSize ?? 0.14;
  const zOffset = config.shotArcZOffset ?? 0.08;
  const dimColor = Color3.FromHexString(config.shotArcDimColor ?? "#262626");
  const brightColor = Color3.FromHexString(config.shotArcBrightColor ?? "#ffffff");

  const material = new StandardMaterial("ShotArcMat", scene);
  material.disableLighting = true;
  material.disableDepthWrite = true;
  material.emissiveColor = dimColor.clone();
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();

  const baseMesh = MeshBuilder.CreateSphere("ShotArcDot", {
    diameter: dotSize,
    segments: 8,
  }, scene);
  baseMesh.material = material;
  baseMesh.isPickable = false;
  baseMesh.renderingGroupId = 2;
  baseMesh.alwaysSelectAsActiveMesh = true;
  baseMesh.setEnabled(false);

  baseMesh.thinInstanceCount = 0;

  let fadeObserver = null;
  let showing = false;

  function cancelFade() {
    if (fadeObserver) {
      scene.onBeforeRenderObservable.remove(fadeObserver);
      fadeObserver = null;
    }
    material.alpha = 1;
  }

  function update(points, powerRatio) {
    if (!points || points.length === 0) {
      hide();
      return;
    }

    cancelFade();

    const count = Math.min(points.length, dotCount);
    const buffer = new Float32Array(count * 16);

    for (let i = 0; i < count; i++) {
      const p = points[i];
      const m = Matrix.Translation(p.x, p.y, p.z + zOffset);
      m.copyToArray(buffer, i * 16);
    }

    baseMesh.thinInstanceSetBuffer("matrix", buffer, 16, false);
    baseMesh.thinInstanceCount = count;

    const t = Math.min(1, Math.max(0, powerRatio));
    material.emissiveColor.r = dimColor.r + (brightColor.r - dimColor.r) * t;
    material.emissiveColor.g = dimColor.g + (brightColor.g - dimColor.g) * t;
    material.emissiveColor.b = dimColor.b + (brightColor.b - dimColor.b) * t;

    baseMesh.setEnabled(true);
    showing = true;
  }

  function fadeOut(durationMs) {
    const fadeDuration = durationMs ?? config.shotArcFadeMs ?? 1500;
    cancelFade();
    if (!showing) return;

    const startTime = performance.now();

    fadeObserver = scene.onBeforeRenderObservable.add(() => {
      const elapsed = performance.now() - startTime;
      const t = Math.min(elapsed / fadeDuration, 1);
      material.alpha = 1 - t;

      if (t >= 1) {
        hide();
      }
    });
  }

  function hide() {
    cancelFade();
    baseMesh.setEnabled(false);
    showing = false;
  }

  function dispose() {
    cancelFade();
    baseMesh.dispose();
    material.dispose();
  }

  function isShowing() {
    return showing;
  }

  return { update, fadeOut, hide, dispose, isShowing };
}
```

- [ ] **Step 2: Commit**

```bash
git add public/client/shotArcRenderer.js
git commit -m "feat: add shot arc dot renderer using thin instances"
```

---

### Task 9: Client Integration — `level.js` Lifecycle

**Files:**
- Modify: `public/client/level.js:1-6,430-461,463-476`

- [ ] **Step 1: Add imports**

In `public/client/level.js`, add the import for the renderer (after line 6):

```js
import { createShotArcRenderer } from "./shotArcRenderer.js";
```

- [ ] **Step 2: Add module-level variable and accessor**

After line 9 (`const fragmentVisuals = new Map();`), add:

```js
let shotArcRenderer = null;

export function getShotArcRenderer() {
  return shotArcRenderer;
}
```

- [ ] **Step 3: Create renderer in `loadLevel()`**

In `loadLevel()`, after line 474 (`createAimArrowMeshes();`), add:

```js
  shotArcRenderer = createShotArcRenderer(scene, CONFIG);
```

- [ ] **Step 4: Dispose renderer in `clearLevel()`**

In `clearLevel()`, after `latestObjectStates.clear();` (line 450), add:

```js
  if (shotArcRenderer) {
    shotArcRenderer.dispose();
    shotArcRenderer = null;
  }
```

- [ ] **Step 5: Commit**

```bash
git add public/client/level.js
git commit -m "feat: create/dispose shot arc renderer on level lifecycle"
```

---

### Task 10: Client Integration — `aim.js` Arc Wiring

**Files:**
- Modify: `public/client/aim.js:1-6,74-78,122-194,196-200`

- [ ] **Step 1: Add import for renderer accessor**

In `public/client/aim.js`, add to imports (after line 3):

```js
import { getShotArcRenderer } from "./level.js";
```

- [ ] **Step 2: Add arc tracking state**

After the `let aimWorldPointRef` line (line 15), add:

```js
let wasShowingArc = false;
```

- [ ] **Step 3: Add `hideArc()` helper**

After `hideAimArrow()` (after line 78), add:

```js
function hideArc() {
  const renderer = getShotArcRenderer();
  if (renderer) {
    renderer.hide();
    wasShowingArc = false;
  }
}
```

- [ ] **Step 4: Hide arc on all early-return paths in `updateAimArrow()`**

In `updateAimArrow()`, add `hideArc()` alongside each `hideAimArrow()` call. There are five early-return paths:

Line 128 (after `hideAimArrow();`):
```js
    hideAimArrow();
    hideArc();
    return;
```

Line 135 (after `hideAimArrow();`):
```js
    hideAimArrow();
    hideArc();
    return;
```

Line 141 (after `hideAimArrow();`):
```js
    hideAimArrow();
    hideArc();
    return;
```

Line 147 (after `hideAimArrow();`):
```js
    hideAimArrow();
    hideArc();
    return;
```

Line 159 (after `hideAimArrow();`):
```js
    hideAimArrow();
    hideArc();
    return;
```

- [ ] **Step 5: Add arc update logic at the end of `updateAimArrow()`**

After the arrow meshes are enabled (after line 193 `aimArrowHeadRight.setEnabled(true);`), add:

```js
  const renderer = getShotArcRenderer();
  if (renderer) {
    if (trebuchetState?.shotArcPoints) {
      renderer.update(trebuchetState.shotArcPoints, trebuchetState.powerRatio ?? 0);
      wasShowingArc = true;
    } else if (wasShowingArc && trebuchetState?.fireState === "releasing") {
      renderer.fadeOut();
      wasShowingArc = false;
    } else {
      renderer.hide();
      wasShowingArc = false;
    }
  }
```

Note: `trebuchetState` is already declared on line 145 (`const trebuchetState = latestObjectStates.get(trebuchetId);`) — reuse it, do not re-declare.

- [ ] **Step 6: Verify no import cycles**

The import chain is: `aim.js` → `level.js` → `aim.js` (for `createAimArrowMeshes`). This already exists and works because `aim.js` only imports from `level.js` at the top level and calls `getShotArcRenderer()` at runtime (not during module evaluation). Confirm the server still loads by checking the client in a browser (next task).

- [ ] **Step 7: Commit**

```bash
git add public/client/aim.js
git commit -m "feat: wire shot arc renderer to aim state with fade on fire"
```

---

### Task 11: End-to-End Verification

**Files:**
- No changes — verification only

- [ ] **Step 1: Start the server**

Run: `node server/main.js`

Expected: Server starts on port 3000 without errors.

- [ ] **Step 2: Open browser and test aiming**

1. Open two browser tabs to `http://localhost:3000`
2. Load a missile into a trebuchet (drag missile to trebuchet load target)
3. Start aiming (click and drag the loaded missile)
4. Verify: dotted arc appears showing trajectory prediction
5. Verify: arc is dim when pull is small, bright white at full pull
6. Verify: only the aiming player sees the arc (other tab should not show it)
7. Release the shot
8. Verify: arc fades out over ~1.5 seconds

- [ ] **Step 3: Test edge cases**

1. Start aiming then disconnect the aiming tab — verify server doesn't crash and the other player doesn't see a stuck arc
2. Start aiming in wrong direction — verify arc is not shown (pull gets clamped to 0)
3. Quickly aim and release multiple times — verify no visual artifacts or orphaned dots

- [ ] **Step 4: Commit any fixes if needed**

If any issues were found in steps 2-3, fix them and commit with an appropriate message.
