# Barrage

Currently playable at https://barrage.pages.dev/ 

Barrage is a 2 player PVP game for web and mobile. It uses 3D graphics, but the gameplay happens on a 2D plane.

Each player has a trebuchet, a fragile king, and a set of movable defensive blocks. The goal is to protect your own king while launching spherical projectiles at the opponent's defenses. For the first version, each king can withstand 3 hits. The player whose king takes 3 hits loses.

Players have two main actions:

- Aim and launch spherical projectiles with a drag/release gesture, similar to Angry Birds.
- Drag defensive blocks into position to protect the king.

The blocks are affected by physics. Incoming projectiles can knock them over, push them aside, or open gaps in the defense.

The game may become either turn based or continuous depending on how quickly the multiplayer communication works. The first implementation should support both directions by keeping the core actions simple: place blocks, launch projectiles, resolve impacts, update the king hit count.

## Core Technology

- Client: Babylon.js browser game
- Master/server: Node.js with Babylon.js for headless simulation
- Networking: WebSockets
- Level format: one shared GLB exported from Blender
- Input: touch or mouse

## Project Structure

```text
server.js             Node master/server, WebSocket host, headless Babylon scene
public/index.html     Browser page containing the Babylon canvas
public/client.js      Babylon browser client
public/config.js      Browser tuning values for lighting, shadows, and pointer drag feel
config/server.js      Master/server tuning values for authoritative gravity, mass, and friction
public/styles.css     Basic page/canvas styling
public/assets/        GLB files and other browser/server-loaded assets
blender/              Blender source files
```

The first trial level GLB should be exported to:

```text
public/assets/level1.glb
```

Run the app with:

```bash
npm run setup
npm start
```

Then open:

```text
http://localhost:3000
```

## Gameplay Plane

Gameplay is represented with two coordinates plus one rotation:

- `x`: horizontal gameplay coordinate
- `z`: depth/gameplay-plane coordinate
- `rot`: rotation around the Y axis in degrees

`rot: 0` means the object's imported/default upright rotation from Blender. Positive rotation is intended to mean clockwise around the Y axis from the gameplay camera's point of view. If Babylon's native rotation direction does not match this convention, the client/server should convert at the boundary and keep the protocol convention stable.

## Blender Entity Pattern

Each gameplay object is authored as a hierarchy:

```text
Block_Wood_P1_01 (Empty / entity root)
├── Col           simple collider mesh
└── Vis           textured render mesh
```

The empty parent name is the shared entity ID.

Child naming should stay short and consistent:

- `Col` for collider-only meshes used by the server physics simulation.
- `Vis` for visual-only meshes rendered by the client.
- `ColVis` for simple meshes that can be used for both collision and rendering.

Avoid spaces, punctuation, and symbols such as `&` in gameplay object names. The importer should only need to look for `Col`, `Vis`, or `ColVis`.

Valid patterns:

```text
Block_Wood_P1_01
├── Col
└── Vis

Block_Wood_P1_02
└── ColVis

King_P1
├── Col
└── Vis
```

Useful first-pass entity prefixes:

- `Block_` for draggable defensive blocks
- `King_` for the fragile objective
- `Projectile_` for spherical missiles
- `Trebuchet_` for launchers
- `Boundary_` for static level bounds
- `Spawn_` for spawn points or projectile origins
- `Decor_` for non-gameplay visual objects

Example trial level names:

```text
King_P1
King_P2
Trebuchet_P1
Trebuchet_P2
Block_Wood_P1_01
Block_Wood_P1_02
Block_Stone_P2_01
Projectile_P1_01
Projectile_P2_01
Boundary_Left
Boundary_Right
```

For the jam version, gameplay metadata can be encoded in names where needed, for example `Block_Wood_Drag_P1_01` or `Block_Stone_Drag_P2_01`.

## Server Responsibilities

The master/server is authoritative. It loads the same GLB file as the clients, but does not render it.

For each entity root, the server:

- Finds the `Collider` child.
- Uses the collider transform and shape to create a physics body.
- Ignores the `Visual` child.
- Owns the authoritative simulation.
- Validates player input.
- Enforces ownership, placement bounds, phase rules, and king hit counts.
- Sends object state and gameplay events to clients.

Clients should not send final object locations as truth. They send input intent. The server decides the resulting object state.

## Client Responsibilities

The client loads the same GLB file as the server.

For each entity root, the client:

- Finds the `Visual` child.
- Renders the visual mesh.
- Hides or ignores the `Collider` child.
- Sends player input to the server.
- Applies server state updates to visual objects.
- Plays local visual and audio effects from server events.

The client may show immediate local drag feedback, but the server state remains authoritative.

The browser client sends pointer intent only. The master/server owns the object motion, applies the current prototype physics, and broadcasts authoritative transforms back to all clients.

Server physics tuning values live in `config/server.js`, including:

- `gravity`
- `dynamicMass`
- `dynamicFriction`
- `dynamicRestitution`

Browser drag tuning values live in `public/config.js`, including:

- `dragHeightOffset`

## Communication Model

There are three initial message families:

- `input`: client to server
- `state`: server to clients
- `event`: server to clients

A `phase` message may be added if the game becomes turn based or phase based.

### Client Input

The client sends input intent using gameplay-plane coordinates.

Drag start:

```json
{
  "type": "input",
  "seq": 77,
  "action": "dragStart",
  "entityId": "Block_Wood_P1_01",
  "point": { "x": -3.5, "z": 0.8 }
}
```

Drag move:

```json
{
  "type": "input",
  "seq": 78,
  "action": "dragMove",
  "entityId": "Block_Wood_P1_01",
  "point": { "x": -3.2, "z": 1.0 }
}
```

Drag end:

```json
{
  "type": "input",
  "seq": 79,
  "action": "dragEnd",
  "entityId": "Block_Wood_P1_01",
  "point": { "x": -3.0, "z": 1.2 },
  "rot": 15
}
```

Fire:

```json
{
  "type": "input",
  "seq": 120,
  "action": "fire",
  "start": { "x": -5.0, "z": 0.0 },
  "end": { "x": -4.2, "z": 1.1 }
}
```

The server derives launch direction and power from the drag vector.

### Server State

The server sends authoritative object state with a monotonically increasing `tick`.

```json
{
  "type": "state",
  "tick": 1204,
  "serverTime": 20341,
  "objects": [
    {
      "id": "Block_Wood_P1_01",
      "x": -3.1,
      "z": 1.0,
      "rot": 8
    },
    {
      "id": "King_P1",
      "x": -6.0,
      "z": 0.0,
      "rot": 0,
      "hits": 1,
      "maxHits": 3
    }
  ]
}
```

For the first prototype, full state snapshots are acceptable. Later, this can be optimized to send changed objects plus occasional full snapshots.

### Events

Events are temporary gameplay moments such as impacts, sounds, particles, or king hits.

```json
{
  "type": "event",
  "tick": 1205,
  "events": [
    {
      "kind": "impact",
      "entityA": "Projectile_P1_01",
      "entityB": "Block_Wood_P2_03",
      "x": 2.3,
      "z": 0.6,
      "strength": 0.72
    },
    {
      "kind": "kingHit",
      "kingId": "King_P2",
      "hits": 2,
      "maxHits": 3
    }
  ]
}
```

Sound can be handled through events. The server can either send a direct sound event or send a gameplay event such as `impact`, and the client can choose the appropriate sound and particle effect.

## Tick And Buffering

The protocol includes counters now so interpolation and correction can be added without changing the message shape.

- Client input includes `seq`.
- Server state includes `tick`.
- Target server simulation rate: 60 ticks per second.
- Target client render rate: 60 frames per second.
- Initial client buffer: very shallow, about 2 ticks.

At 60 ticks per second:

```text
1 tick  = 16.67 ms
2 ticks = 33.33 ms
3 ticks = 50 ms
```

The first renderer can use the newest state immediately if needed. A slightly smoother version should keep the last 2-4 snapshots and render around 2 ticks behind the newest received state.

## First Prototype Goal

The first network test should prove the architecture before adding the full game loop:

1. Start the master/server.
2. Connect one or two browser clients.
3. Assign players as `P1` and `P2`.
4. Load the same GLB on server and clients.
5. Drag one defensive block on a client.
6. Send `dragStart`, `dragMove`, and `dragEnd` inputs to the server.
7. Broadcast authoritative state from the server.
8. Show the moved block on all connected clients.

After that works, add projectile firing, projectile/block impacts, and king hit detection.

## Design Principle

One GLB acts as the shared source of truth:

```text
Blender -> GLB
          ├── Server uses Collider children
          └── Client uses Visual children
```

This lets the level be designed once in Blender while keeping the server authoritative and the client focused on rendering, input, and presentation.
