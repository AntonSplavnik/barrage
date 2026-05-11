# Refactor Plan

This document describes how to adopt Anton's server/client structure while keeping the current `main` branch behavior as the source of truth.

The goal is not just to split long files into smaller files. The goal is to define layers, data ownership, and narrow APIs so game behavior can keep growing without every feature reaching into every other feature.

## Current Position

`feat/server-refactor` has a good target shape:

- smaller server modules
- smaller client modules
- clearer boot files
- separate input, physics, level, state, network, and trebuchet code

But that branch split early. Current `main` now contains many features that branch does not have or has outdated versions of:

- lobby/rooms/spectators
- Havok-only contact events
- sound effects, spatial pan, pitch randomization, cooldowns
- VFX events and particles
- fragmentation and fragment cleanup
- magnetic drag with pivot grab point
- trebuchet stretch/release sounds
- shot arc prediction
- round/level cleanup
- camera/music helpers

So the plan is:

1. Keep current `main` as behavioral truth.
2. Use Anton's branch as architectural reference.
3. Refactor current code toward that shape in small behavior-preserving steps.
4. Test after every slice.

## Core Principle

Splitting files is not enough. Each layer should own specific data and expose a clear API.

Bad pattern:

```text
input.js directly changes object position, velocity, loaded state, physics body,
sound events, room state, and win state.
```

Better pattern:

```text
input layer receives player intent
game rules layer validates permissions
drag/trebuchet systems update their own state
physics layer owns Havok bodies and forces
event layer emits sound/VFX/game events
network layer sends the resulting state
```

The server owns truth. The client should mostly handle presentation plus input intent.

## Server Ownership Model

### Network Layer

Owns:

- Express server
- WebSocket server
- socket lifecycle
- sending messages
- receiving raw JSON

Does not own:

- game object mutation
- physics
- win rules
- drag behavior

### Input / Command Layer

Owns:

- translating websocket messages into game commands
- validating basic shape of input messages
- routing commands to domain systems

Does not own:

- direct Havok body manipulation
- collision decisions
- sound/VFX event details
- room progression

### Game Rules Layer

Owns:

- player side checks
- `canGrab`
- no-man's-land rules
- king knockout rules
- scoring rules
- win checks

### Domain Systems

Each domain system owns one concept.

Trebuchet system owns:

- missile loading
- loaded missile state
- aim state
- arm angle
- firing and release state
- stretch/release sound triggers

Drag system owns:

- `dragState`
- magnetic drag target
- grab pivot local point
- release behavior

Fragment system owns:

- block hit counts
- fragmentation
- fragment template spawning
- fragment hit/removal lifecycle

Event system owns:

- sound event object creation
- impact speed to volume scaling
- cooldown keys
- start/stop sound events
- gameplay event payload helpers

### Physics Layer

Owns:

- Havok initialization
- physics aggregates
- body creation/disposal
- body sync
- trigger state
- magnetic force application
- plane constraints
- contact collection
- velocity reads/writes

Other layers should not poke `physicsAggregates` directly unless they are part of the physics layer.

### Level Layer

Owns:

- GLB loading
- gameplay root discovery
- collider discovery
- convex/collider data
- load targets
- fragment visual/template loading
- initial object creation
- level reset data

### Simulation Layer

Owns tick order:

1. capture impact velocities
2. apply ongoing drag forces
3. update trebuchet fire animation
4. step Havok
5. process contact events
6. process block hits/fragments/removals
7. check win/round transitions
8. produce events
9. send state

### State Layer

Owns the room/game state container:

- clients
- rooms
- active room
- game objects
- drag state
- load targets
- physics aggregate registry
- tick counters
- level runtime state

The state layer should provide the shared context, but each system should mutate only the fields it owns.

## Proposed Server File Shape

```text
server/index.js
server/config.js
server/state.js
server/network.js
server/level.js
server/physics.js
server/simulation.js
server/input.js
server/trebuchet.js
server/drag.js
server/fragments.js
server/events.js
server/game-rules.js
server/rooms.js
```

### server/index.js

Boot file.

Responsibilities:

- create Express app
- create HTTP/WebSocket server
- register routes
- start/stop simulation interval
- initialize level and physics

### server/config.js

Server-only config and environment:

- port
- tick rate
- static paths
- server constants

Shared gameplay tuning remains in `public/config.js` for now.

### server/state.js

Runtime state containers and factory helpers.

Should not contain much game behavior.

### server/network.js

Responsibilities:

- `broadcast`
- `sendToClient`
- `sendState`
- welcome messages
- lobby messages
- spectator messages
- websocket-safe serialization

### server/level.js

Responsibilities:

- load current level GLB
- register mesh roots
- register load targets
- find collider bounds
- load fragment templates
- reset/rebuild level runtime objects

### server/physics.js

Responsibilities:

- enable Havok
- create/register/dispose aggregates
- sync physics body from object
- set trigger state
- apply magnetic drag force
- constrain bodies to action plane
- read/write body velocity
- collect contacts

### server/simulation.js

Responsibilities:

- run one simulation tick
- call systems in correct order
- process pending removals
- return events/results to networking layer

This can grow from the existing `server/physics-sim.js`.

### server/input.js

Responsibilities:

- `applyInput`
- validate command ownership
- call drag/trebuchet/game-rule APIs

It should not directly contain large physics, fragmentation, or networking logic.

### server/trebuchet.js

Responsibilities:

- `loadTargetForTrebuchet`
- `maybeLoadMissile`
- `updateTrebuchetAim`
- `beginTrebuchetRelease`
- `releaseLoadedMissileFromTrebuchet`
- fire animation state transitions

### server/drag.js

Responsibilities:

- start drag
- update drag target
- end/release drag
- calculate grab local point
- decide direct missile drag vs magnetic block/trebuchet drag

### server/fragments.js

Responsibilities:

- record block hits
- fragment block
- spawn fragments
- record missile/fragment hits
- remove fragment objects

### server/events.js

Responsibilities:

- sound effect events
- sound start/stop events
- impact position/speed helpers
- cooldown helpers

This can grow from the existing `server/server-events.js`.

### server/game-rules.js

Responsibilities:

- player side
- grab permissions
- no-man's-land
- king knockout
- round winner checks

This can grow from the existing `server/gameManager.js`.

### server/rooms.js

Responsibilities:

- room manager integration
- matchmaking
- room progression
- spectator flow
- round reset / next level flow

This can wrap or replace the existing `server/roomManager.js`.

## Client Ownership Model

### Network Layer

Owns:

- websocket
- routing server messages
- sending input commands

Does not own:

- visual mesh mutation details
- sound/VFX implementation
- pointer gesture logic

### State Layer

Owns:

- latest server object snapshots
- current room id
- current level URL
- player id
- score display data
- visual registries

### Level / Rendering Layer

Owns:

- Babylon level loading
- mesh registration
- visual roots
- shadows
- missile pick colliders
- applying server snapshots to visuals
- disposing old level data

### Input Layer

Owns:

- pointer gesture state
- picking
- drag/aim/release sampling
- converting world points to protocol points
- sending input commands

Does not own:

- whether the server accepts a grab
- whether a hit happened
- direct game state truth

### Audio / VFX Layers

Own:

- reacting to server events
- sound playback
- music playback
- particles
- trajectory visuals

Do not own:

- deciding whether collisions happened
- changing server state

### UI Layer

Owns:

- lobby visibility
- status text
- player labels
- round counter
- crowns/scores
- reset/restart buttons

## Proposed Client File Shape

```text
public/client/index.js
public/client/engine.js
public/client/state.js
public/client/network.js
public/client/level.js
public/client/input.js
public/client/rendering.js
public/client/aim.js
public/client/ui.js
```

Keep existing focused helpers:

```text
public/sound_manager.js
public/music.js
public/vfx-manager.js
public/camera_control.js
public/trebuche-shot-arc-prediction.js
public/sound_effects.js
```

## Proposed Client Module Responsibilities

### public/client/index.js

Boot file.

Responsibilities:

- create controllers
- load level
- attach input
- start render loop

### public/client/engine.js

Responsibilities:

- canvas
- Babylon engine
- scene
- shared config

### public/client/state.js

Responsibilities:

- visual object maps
- latest object state map
- fragment visual maps
- current room/level/player state

### public/client/network.js

Responsibilities:

- websocket connection
- message routing
- `sendInput`

### public/client/level.js

Responsibilities:

- load/dispose level scene
- register roots
- register arm nodes/load targets
- create missile pick colliders
- setup shadows
- load fragment templates

### public/client/rendering.js

Responsibilities:

- apply state snapshots to Babylon meshes
- update arm rotations
- update fragment shrink visuals
- update camera/music from state if appropriate

### public/client/input.js

Responsibilities:

- pick draggable roots
- drag gesture state
- aim gesture state
- release velocity sampling
- protocol point conversion
- send drag/aim commands

### public/client/aim.js

Responsibilities:

- aim arrow
- shot arc prediction integration
- release point calculation for visuals

### public/client/ui.js

Responsibilities:

- HUD
- lobby
- score/crowns
- status text
- reset/restart buttons

## Migration Plan

Use small behavior-preserving steps. Each step should be small enough that the game can be started and manually checked before continuing.

Do this on a new branch from current `main`.

Do not merge `feat/server-refactor` directly.

### Small-Step Sequence

1. Create empty target server modules.
   Add files like `server/utils.js`, `server/events.js`, `server/trebuchet.js`, `server/physics.js`, `server/drag.js`, `server/fragments.js`, `server/level.js`, `server/simulation.js`, `server/network.js`, and `server/rooms.js`. Do not move behavior yet.

   Verify: server still starts from current `server.js`.

2. Move pure server math helpers.
   Move helpers like `clamp`, `clampVector`, `lerp`, angle conversion, protocol rotation conversion, and quaternion helpers into `server/utils.js`.

   Verify: server starts, objects still move and rotate.

3. Move server name/role helpers.
   Move helpers like `childRole`, `isDynamicName`, `isTrebuchetName`, `isMissileName`, `isKingName`, `isBlockName`, `isGroundName`, and side-sign helpers into `server/utils.js`.

   Verify: level loads, gameplay objects register, draggable objects still work.

4. Move server collider/bounds helpers.
   Move hierarchy traversal, collider bounds, convex extraction, and half-height helpers into `server/utils.js`.

   Verify: colliders still line up, blocks rest on the ground, no object offset regression.

5. Move event payload helpers.
   Expand `server/server-events.js` or rename it to `server/events.js`. Move sound event constructors, impact speed/position helpers, impact volume scaling, and cooldown key helpers.

   Verify: existing sound events and VFX events still arrive.

6. Move sound broadcast wrappers.
   Move `broadcastSoundEffect`, `broadcastSoundEffectStart`, `broadcastSoundEffectStop`, `broadcastImpactSoundEffect`, and impact cooldown wrappers. Pass dependencies like `broadcast`, `tick`, and cooldown maps explicitly.

   Verify: spatial pan, velocity volume scaling, pitch randomization, and cooldowns still work.

7. Move trebuchet load-target logic.
   Move `loadTargetForTrebuchet` and related arm/root target helpers into `server/trebuchet.js`.

   Verify: dragged missile locks to the correct load point.

8. Move missile loading.
   Move `maybeLoadMissile` into `server/trebuchet.js`.

   Verify: missile trigger state is correct while loaded and missile remains locked.

9. Move trebuchet aim/release logic.
   Move `updateTrebuchetAim`, `beginTrebuchetRelease`, `targetPointForTrebuchetAtArmAngle`, and `releaseLoadedMissileFromTrebuchet`.

   Verify: invalid pulls cancel, valid pulls fire, shot direction matches, stretch sound stops on fire.

10. Move trebuchet fire animation.
    Move `updateTrebuchetFireState`.

    Verify: arm releases, missile releases at the same point, arm returns to rest.

11. Move physics aggregate lifecycle.
    Move Havok init, aggregate registration, unregister/dispose helpers, body id helpers, and body creation.

    Verify: Havok initializes, level creates bodies, reset/reload does not duplicate bodies.

12. Move physics body sync helpers.
    Move body teleport/sync, trigger toggling, mass/damping helpers, and velocity read/write helpers.

    Verify: missile direct drag, load/unload, and fired missile velocity still work.

13. Move magnetic drag force.
    Keep ownership split clear: `drag.js` owns drag state and grab point; `physics.js` applies force to Havok.

    Verify: block magnetic drag, pivot torque, damping, and block angular damping still feel the same.

14. Move plane constraint and physics stepping.
    Move plane constraint and Havok step orchestration into `server/physics.js` / `server/simulation.js`.

    Verify: objects stay in the action plane, trebs stay constrained, no AABB fallback returns.

15. Move drag command behavior.
    Move drag start/move/end handling and release velocity logic into `server/drag.js`. `input.js` should call drag APIs.

    Verify: missile drag, block drag, trebuchet movement, no-man's-land release, and client hand marker still work.

16. Move block and king hit rules.
    Move hit registration and win-rule helpers into `server/game-rules.js` and/or `server/fragments.js`.

    Verify: block hits, king hits, win event, score, and round state still work.

17. Move fragment template loading.
    Move fragment GLB/template loading and parsing into `server/fragments.js`.

    Verify: server starts and fragmentation templates are available.

18. Move fragment spawning/removal.
    Move block fragmentation, missile-fragment hit logic, and pending fragment removal processing.

    Verify: block fragments, fragment sounds/VFX fire, fragments clean up.

19. Move contact processing.
    Move Havok contact event processing and contact position helpers.

    Verify: all impact events still fire: missile/block, missile/ground, block/ground, block/block, missile/trebuchet, missile/missile, king hit.

20. Move server level registration.
    Move GLB loading, mesh root registration, load target registration, arm rest pose, and game reset setup into `server/level.js`.

    Verify: level loads, reset works, next round/level works, no stale objects remain.

21. Move simulation tick orchestration.
    Move the top-level tick order into `server/simulation.js`.

    Verify: a complete round can be played and state messages remain stable.

22. Move network state sending.
    Move `toWireObject`, `sendState`, `sendToClient`, and `broadcast` into `server/network.js`.

    Verify: browser receives object state and event messages.

23. Move welcome/lobby/match messages.
    Move welcome, lobby, matched, spectator, and room status messages.

    Verify: two players match, spectators behave, lobby UI updates.

24. Move room progression.
    Move room runtime creation, binding, vacancy handling, round advancement, level advancement, and simulation result handling into `server/rooms.js`.

    Verify: win round, next round starts, disconnect behavior still works.

25. Move server boot last.
    Reduce `server.js` to boot code or switch package scripts to `server/index.js` only after all server behavior is behind modules.

    Verify: `npm start`, `npm run dev`, admin restart, and deploy entrypoint all work.

26. Create empty target client modules.
    Add `public/client/index.js`, `engine.js`, `state.js`, `network.js`, `level.js`, `rendering.js`, `input.js`, `aim.js`, and `ui.js`. Do not move behavior yet.

    Verify: current `public/client.js` still loads.

27. Move client engine setup.
    Move canvas, Babylon engine, scene, config, and base scene settings into `public/client/engine.js`.

    Verify: scene renders and audio engine still initializes.

28. Move client UI references and simple UI helpers.
    Move HUD/lobby/button references, status text, round counter, and crown updates into `public/client/ui.js`.

    Verify: status, lobby, crowns, reset, and restart still work.

29. Move client network.
    Move websocket setup, message routing, and `sendInput` into `public/client/network.js`.

    Verify: welcome/state messages arrive and input commands send.

30. Move client state registries.
    Move visual maps, latest object states, room/level/player state, fragment maps, and template maps into `public/client/state.js`.

    Verify: visual objects still update and room/level state still tracks.

31. Move client pure helpers.
    Move protocol rotation, degree conversion, role/name checks, aim clamp helpers, and vector clamp helpers into `public/client/utils.js`.

    Verify: dragging and aiming still work.

32. Move client level loading core.
    Move level load/dispose, visual root registration, arm/load target registration, gameplay root lookup, and arm rest pose into `public/client/level.js`.

    Verify: level loads and reload disposes old visuals.

33. Move client shadows and pick colliders.
    Move shadow setup, missile pick collider creation, collider-node discovery, bounds helpers, and scale helpers.

    Verify: shadows still render and missile pick target still feels enlarged.

34. Move client fragment visuals.
    Move fragment templates, cracked/fragment visuals, shrink observers, and fragment cleanup.

    Verify: block cracks/fragments visually and level reload clears leftovers.

35. Move client state application/rendering.
    Move applying server snapshots to meshes, arm updates, event routing, music state updates, and camera state updates into `public/client/rendering.js`.

    Verify: all objects move correctly, camera/music/sound/VFX behavior is unchanged.

36. Move client aim arrow and shot arc integration.
    Move aim arrow code into `public/client/aim.js`; keep `public/trebuche-shot-arc-prediction.js` as the helper.

    Verify: aim arrow, shot arc, invalid-pull hiding, and post-shot fade still work.

37. Move client drag pivot marker.
    Move hand marker creation/update/hide logic into `public/client/input.js` or a small `drag-marker.js`.

    Verify: hand marker appears at the grab point, follows rotation, and hides on release/reload.

38. Move client pointer input.
    Move picking, drag/aim gesture state, release velocity sampling, protocol point conversion, and input command sending into `public/client/input.js`.

    Verify: all dragging, loading, aiming, and firing behavior still works.

39. Move client boot last.
    Replace `public/client.js` with a small boot file or switch `index.html` to `public/client/index.js`.

    Verify: fresh page load works, all imports resolve, SFX/music toggles work, and a full round still works.

## Coarse Module Map

The smaller steps above are the sequence to follow. The coarse sections below describe the same destination by module.

Do this on a new branch from current `main`.

Do not merge `feat/server-refactor` directly.

### Step 1: Extract Pure Server Helpers

Move name checks, math helpers, rotation helpers, collider role helpers, and protocol conversions out of `server.js`.

Target:

```text
server/utils.js
```

Risk: low.

Test:

- server starts
- level loads
- objects still appear and move

### Step 2: Expand Event Helpers

Move sound/gameplay event helpers from `server.js` into:

```text
server/events.js
```

Use current `server/server-events.js` as the starting point.

Risk: low-medium.

Test:

- trebuchet release sound
- stretch sound start/stop
- missile/block sound
- king hit sound
- VFX event still arrives

### Step 3: Extract Trebuchet System

Move trebuchet loading, aim, release, and fire animation logic into:

```text
server/trebuchet.js
```

Risk: medium.

Test:

- drag missile to load target
- aim vector only works when pulled away from center
- release cancels if pull is invalid
- missile fires
- stretch sound cuts off on fire
- shot arc still matches direction

### Step 4: Extract Physics Layer

Move Havok setup and body helper functions into:

```text
server/physics.js
```

Responsibilities include:

- aggregate lifecycle
- sync body from object
- trigger state
- magnetic drag force
- constrain to plane
- velocity reads/writes
- contact collection

Risk: high.

Test:

- blocks collide while dragged
- drag pivot works
- missiles load with trigger behavior
- Havok contacts still emit impact events
- fragments still collide/remove

### Step 5: Extract Drag System

Move drag start/move/end behavior into:

```text
server/drag.js
```

Input layer should call drag APIs rather than mutate drag fields directly.

Risk: medium.

Test:

- missile direct drag remains good
- block magnetic drag remains good
- trebuchet movement remains constrained
- no-man's-land release still works
- hand marker still appears on client

### Step 6: Extract Fragment System

Move block damage, fragmentation, fragment hit, and pending removal behavior into:

```text
server/fragments.js
```

Risk: high.

Test:

- block hit count increments
- block fragments at correct threshold
- missile_fragments_block sound/VFX fires
- missile_hits_fragment works
- fragment cleanup works

### Step 7: Extract Level Layer

Move GLB loading and object registration into:

```text
server/level.js
```

Risk: high.

Test:

- level loads
- colliders match
- convex king/fragment handling works
- load targets work
- next level / round reset works
- no old objects remain after reload

### Step 8: Extract Simulation Orchestration

Move tick orchestration into:

```text
server/simulation.js
```

This should call physics, drag, trebuchet, contacts, fragments, and rules in a clear order.

Risk: medium-high.

Test:

- complete round can be played
- win detection works
- round transition works
- state messages remain stable

### Step 9: Extract Network / Rooms

Move websocket messaging and room/lobby handling into:

```text
server/network.js
server/rooms.js
```

Risk: medium-high.

Test:

- two players match
- spectators behave
- disconnect handling works
- lobby UI gets correct messages
- admin restart still works

### Step 10: Split Client Boot, Engine, Network, State

Start with the easiest client split:

```text
public/client/index.js
public/client/engine.js
public/client/network.js
public/client/state.js
```

Risk: medium.

Test:

- app boots
- websocket connects
- state applies
- player id/lobby still updates

### Step 11: Split Client Level / Rendering

Move level loading, mesh registration, shadows, fragments, and visual state application into:

```text
public/client/level.js
public/client/rendering.js
```

Risk: high.

Test:

- level loads
- block/king/missile visuals update
- fragments appear/shrink
- level reload disposes old visuals
- camera still initializes correctly

### Step 12: Split Client Input / UI / Aim

Move pointer handling, UI, aim arrow, and shot arc integration into:

```text
public/client/input.js
public/client/ui.js
public/client/aim.js
```

Risk: high.

Test:

- drag all object types
- hand marker follows grab pivot
- aim arrow works
- shot arc appears/fades
- reset/restart buttons work
- music/SFX toggles work

## Testing Gates

Use a small verification after every step. Use the full gate after any high-risk step.

Small gate:

```text
server starts
browser connects
level loads
no browser console import/syntax errors
basic object state updates
```

Full gate:

```text
server starts
browser connects
two players can join
lobby state is correct
drag blocks with magnetic force
grab pivot torque works
drag/load missile
trebuchet stretch sound starts/stops
shot arc appears/fades
missile fires correctly
Havok impact sounds play spatially
SFX default-on behavior works
missile_hit_block VFX triggers
missile_fragments_block VFX triggers
block fragmentation works
fragment removal works
king hit/win/round transition works
level reload clears old visuals/VFX/physics leftovers
```

## Practical Rules During Refactor

- Current `main` behavior wins over old branch behavior.
- Avoid broad rewrites.
- Move one ownership slice at a time.
- Keep commits small.
- Run syntax checks after every extraction.
- Manually test the game after every risky extraction.
- Do not introduce new gameplay behavior during structural moves.
- If behavior changes accidentally, fix it before continuing.

## Final Opinion

Anton is right about the need for layering and data ownership.

The current game is also already carrying a lot of working behavior that should not be thrown away.

The right compromise is a behavior-preserving rebuild: use Anton's architecture as the destination, but migrate current `main` into that shape gradually.
