# Barrage Handoff

This file is for a future assistant or a fresh chat with no context. Read this before changing code.

## Project Goal

`barrage` is a game-jam prototype for a 2D/2.5D multiplayer trebuchet battle. Players defend a king and attack with trebuchets. The game uses a Blender-authored GLB level and a server-authoritative simulation.

Current design direction:
- Author level layout in Blender/GLB wherever possible.
- Do not spawn walls/extra ammo in code unless it is intentional game-system behavior.
- Server is the master authority for physics and state.
- Client only sends input: pointer/touch positions and actions.
- Client renders server state and interpolates as little as possible for now.

## Run Commands

Install dependencies:

```sh
npm install
```

Start the server:

```sh
npm start
```

Open:

```text
http://localhost:3000
```

The server serves static files with `Cache-Control: no-store`, but hard refresh the browser after code/config changes.

## Main Files

- `server.js`: Express + WebSocket authoritative master, Babylon `NullEngine`, Havok physics, GLB import, game state, input protocol.
- `public/client.js`: Browser Babylon renderer, GLB import, pointer input, WebSocket client, visual state application.
- `public/config.js`: Shared editable gameplay/render/input config imported by server and client.
- `config/server.js`: Server-only physics/world constants.
- `public/assets/level1.glb`: Current Blender level.
- `readme.md`: Original concept/design notes.

## Current Dependencies

Important dependencies from `package.json`:
- `@babylonjs/core`
- `@babylonjs/loaders`
- `@babylonjs/havok`
- `express`
- `ws`
- `xhr2`

Havok runs on the server. In Node it must be initialized with the local WASM binary:

```js
const wasmBinary = await fs.readFile(path.join(__dirname, "node_modules/@babylonjs/havok/lib/esm/HavokPhysics.wasm"));
const havokInterface = await HavokPhysics({ wasmBinary });
```

Do not change this back to plain `await HavokPhysics()` unless you also solve Node WASM loading.

## Blender Naming Scheme

Gameplay objects are detected from top-level GLB transform nodes whose children contain recognized collider/visual names.

Recognized child roles:
- `ColVis`: both collider and visible mesh.
- `Collider` or `Col`: collider only.
- `Visual` or `Vis`: visual only.

Dynamic root names are detected if the root name includes:
- `block`
- `trebuche`
- `missile`
- `king`

King roots get `hits: 0` and `maxHits: 3`.

Current examples in `level1.glb` include:
- `blockL`, `blockL.001` etc.
- `blockR`, `blockR.001` etc.
- `missile`, `missile.002`, `missile.004`, `missile.006`
- `trebuche-left`
- `trebuche-right`
- `KingL`
- `KingR`
- `ground`

Trebuchet arm roots are detected as transform nodes that:
- include `trebuche` and `arm` in the name;
- are direct children of a trebuchet root;
- do not include `visual`, `collider`, or `col`;
- have a descendant whose name includes `missile-load-target`.

Missile load targets in the GLB should include `missile-load-target`, for example:
- `left-missile-load-target`
- `right-missile-load-target`

## Networking Protocol

WebSocket messages from client to server:

```js
{
  type: "input",
  seq,
  action,
  ...
}
```

Important actions:
- `reset`
- `dragStart`
- `dragMove`
- `dragEnd`
- `aimStart`
- `aimMove`
- `aimRelease`

Server broadcasts:

```js
{
  type: "state",
  tick,
  serverTime,
  objects: [...]
}
```

Each object includes:
- `id`
- `x`, `y`, `z`
- `rot`
- `vx`, `vy`, `vz`
- optional `loaded`, `loadedInto`
- optional `armAngle`, `fireState`
- optional `hits`, `maxHits`

The `rot` value is degrees. It is currently the server's 2D Havok rotation around Z, converted into protocol degrees. The client clears `rotationQuaternion` and applies it to `visual.rotation.z`.

## Physics

Current physics is Havok on the server, not the old custom AABB simulation.

Important implementation details:
- `server.js` creates a hidden `TransformNode` per gameplay object and a `PhysicsAggregate`.
- Missiles use `PhysicsShapeType.SPHERE`.
- Other objects use `PhysicsShapeType.BOX`.
- Dynamic objects have mass from `SERVER_CONFIG.dynamicMass`.
- Static objects have mass `0`.
- Bodies are synchronized to server state and sent to the client each tick.

2D plane lock:
- The game plane is X/Y.
- Z position is forced back to each object's authored `originZ`.
- Z linear velocity is forced to `0`.
- For non-trebuchets, X/Y angular velocity is forced to `0` and Z angular velocity is left free.
- This is intended to allow real 2D tumbling/spin from Havok contacts, not fake spin.
- Trebuchets are special: Y and Z are locked to origin; only X movement is allowed.

Important: fake spin was intentionally removed. Do not reintroduce rolling-spin coupling or manual impact spin unless explicitly asked. Rotation should come from Havok contact torque.

Current caveat:
- The 2D lock is still a post-step correction, not a true Havok constraint. If rotation still feels wrong, the next correct improvement is to use real Havok constraints/locked axes, not fake spin.

## Dragging And Release

The client samples pointer movement at a configured rate and sends averaged release velocity on `dragEnd`.

Important config in `public/config.js`:

```js
normalReleaseVelocityMax: 8
dragUprightLerp: 0.25
releaseVelocitySampleHz: 60
releaseVelocityFrameWindow: 5
releaseVelocityMinSampleDistance: 0.05
```

Server clamps normal object release velocity with `normalReleaseVelocityMax`. This is intentionally low so players cannot throw blocks as the main attack. Trebuchet shots have a separate cap.

Dragging syncs object position into the Havok body. On release, the server teleports the Havok body to the released position and then applies the release velocity.

Blocks, kings, and future non-trebuchet/non-missile dynamic objects lerp their `rot` back toward `0` while picked up or dragged. The amount per server tick/drag update is `dragUprightLerp`. This is server-owned behavior; do not trust client drag rotation for these objects.

## Missile Loading

Missiles load when released near an unloaded trebuchet. The range is:

```js
missileLoadRange: 0.5
```

Server logic:
- `maybeLoadMissile(missile)` checks range against both the trebuchet root and actual load target.
- If loaded:
  - `missile.loadedInto = trebuchet.id`
  - `trebuchet.loaded = true`
  - `trebuchet.loadedMissileId = missile.id`
  - missile is pinned to `loadTargetForTrebuchet(trebuchet)`

Loaded and dragged missiles are trigger-only in Havok so they do not physically push the trebuchet while loading. They become solid again on release/firing.

## Trebuchet Movement

Trebuchets are dynamic but constrained by code:
- They move only along X.
- Y and Z are locked to origin.
- Left range:

```js
trebuchetLeftMinX: -30
trebuchetLeftMaxX: -5
```

- Right range:

```js
trebuchetRightMinX: 5
trebuchetRightMaxX: 30
```

Side detection:
- left if root name includes `p1`, `left`, or `1`;
- otherwise treated as right.

## Trebuchet Arm And Firing

Trebuchet firing is server-authoritative.

Config:

```js
trebuchetArmRestRotationZDegrees: 15
aimMaxPullDistance: 8
aimPowerScale: 4
trebuchetArmPullbackMaxDegrees: 80
trebuchetFireVelocityMax: 28
fireReleaseAnimationMs: 180
fireReturnAnimationMs: 220
```

Flow:
1. Missile is loaded into a trebuchet.
2. Client clicks/presses the loaded missile and sends `aimStart`.
3. Client sends `aimMove` while dragging.
4. Server updates `trebuchet.armAngle`.
5. Client sends `aimRelease`.
6. Server animates arm from pullback angle toward `0`.
7. Missile now detaches when the arm crosses the configured rest angle, not at `0`.
8. The arm still completes the release animation to `0`, then lerps back to the rest angle.

Client-only aim assist:
- While aiming a loaded missile, the client renders a procedural arrow in code.
- The arrow head is placed at the predicted missile release point for the trebuchet's rest angle.
- The arrow tail follows the player's current drag point.
- This arrow is not authored in the GLB and is not server-authoritative.

Current `fireState` values:
- `idle`
- `aiming`
- `releasing`
- `returning`

The missile must stay pinned to the live `missile-load-target` until the final release frame.

Right trebuchet:
- The GLB right arm visually wants the same positive rest angle as the left (`+15`), not mirrored negative.
- Shot direction is mirrored separately in velocity calculation.
- Left fires toward `+X`; right fires toward `-X`.

## Client Rendering

Client loads the same GLB and registers top-level visual roots.

Important rendering details:
- Collider-only meshes (`Col`) are disabled on the client.
- Visuals receive server `x/y/z` and `rot`.
- The client clears `visual.rotationQuaternion = null` before assigning rotation. This is necessary because GLB imports often use quaternions, which would ignore `.rotation.z`.
- Trebuchet arms are separately found and rotated by `armAngle`.
- Camera controls are disabled by default so missed clicks do not rotate the scene:

```js
cameraControlsEnabled: false
```

## Config Philosophy

Use `public/config.js` for editable gameplay variables shared by server and client:
- input inversion
- camera lock
- light/shadow/render tuning
- drag release velocity
- missile load range
- trebuchet movement limits
- trebuchet firing tuning

Use `config/server.js` for server-only simulation/world constants.

## Level Authoring Recommendation

For this prototype, prefer authoring layout in Blender:
- walls
- pre-stacked blocks
- airborne blocks/missiles for initial drop
- king positions
- trebuchet positions

Avoid runtime duplication/spawning for level layout. It caused confusing behavior and was rolled back. New levels should usually be new GLBs following the naming scheme.

Runtime spawning should only be used for true game mechanics such as ammo replenishment, waves, or powerups.

## Known Recent Issues And Fixes

Fixed:
- Runtime block/missile spawning was removed.
- Server now loads new GLB objects after restart.
- Browser cache disabled with `Cache-Control: no-store`.
- Havok horizontal velocity was initially suppressed because pre-step transform sync fought velocities; fixed by only teleporting bodies explicitly for reset/drag/load.
- Dragged/loaded missiles are trigger-only to avoid pushing trebuchets during loading.
- Fake spin was removed. Rotation should come from Havok contact torque.

Watch out:
- If the server is not restarted after changing `level1.glb`, it will keep simulating the old imported level.
- If the browser appears stale, hard refresh.
- If rotations still look locked, inspect both server `rot` values and Blender hierarchy. A child visual may counter-rotate or make root rotation hard to see.
- If Havok rotation remains weak, solve it with real constraints/axis locks, not fake spin.

## Quick Verification Commands

Check syntax:

```sh
node --check server.js
node --check public/client.js
node --check public/config.js
```

Confirm server sees the GLB objects:

```sh
npm start
```

Expected current startup says `Loaded level1.glb with 19 gameplay objects`.

Probe state manually with a small WebSocket script if needed. The server broadcasts object positions and rotations in `state.objects`.
