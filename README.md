# GoldenEye Level Editor

A browser-based 3D level editor for creating GoldenEye 64-style environments. Built with Three.js using raw vertex-level geometry — no build tools required.

## How It Works

You start inside a rectangular volume and sculpt the level by pushing/pulling faces and cutting doors. The entire level is one continuous mesh made of connected volumes.

- **Push** a wall face to extend it outward
- **Pull** a wall face to shrink it inward
- **Cut a door** to create an opening with a tunnel — push the exit face to grow into new space
- If a volume already exists on the other side, the door auto-bridges them

Everything is quantized to wall thickness units (1 WT = 0.25m in world space).

## Running

Requires a local HTTP server (ES modules don't work from `file://`).

```bash
cd "GoldenEye Level Editor"
python -m http.server 8080
```

Open http://localhost:8080

## Controls

| Key | Action |
|-----|--------|
| **Click** | Enter pointer lock / Select face |
| **WASD** | Fly movement |
| **Mouse** | Look around |
| **Space / Shift** | Fly up / down |
| **+ / =** | Push selected face outward |
| **-** | Pull selected face inward |
| **T** | Toggle tool (Push/Pull / Door) |
| **X / Delete** | Delete selected volume |
| **Ctrl+Z** | Undo |
| **Ctrl+S** | Save level (JSON download + localStorage) |
| **Ctrl+O** | Load level from JSON file |
| **Escape** | Deselect / Exit pointer lock |

## HUD Settings (bottom-right)

- **Door W** — Door width in wall thickness units (default: 6)
- **Door H** — Door height in wall thickness units (default: 8)
- **Push Step** — How far each push/pull moves in WT units (default: 4)

## Architecture

```
src/
  main.js          — Entry point, render loop, event wiring
  scene.js         — Three.js scene, renderer, camera, lighting
  camera.js        — First-person fly camera (WASD + mouse)
  input.js         — Keyboard/mouse state tracking
  volume.js        — Volume data model (axis-aligned box)
  connection.js    — Connection model (door openings between volumes)
  state.js         — Editor state, undo, serialization
  geometry.js      — Raw BufferGeometry builder (vertex-level)
  materials.js     — Procedural textures
  raycaster.js     — Face picking via triangle index lookup
  actions.js       — Push/pull, door cutting, save/load
  collision.js     — AABB collision detection
  hud.js           — HUD display and settings inputs
```

### Key Design Decisions

- **No room concept** — the level is volumes + connections, sculpted from a starting box
- **Raw vertex geometry** — no BoxGeometry/PlaneGeometry. Full control over every triangle.
- **Uniform face model** — every selectable surface is a face with `{ volumeId, axis, side, position, bounds }`. No type tags. Geometry determines behavior.
- **Single mesh per volume** — one BufferGeometry with a triangle-index-to-faceId lookup table for raycasting
- **Wall thickness = 1 unit** — the fundamental unit. `WORLD_SCALE` (0.25) converts to Three.js meters.

## License

MIT
