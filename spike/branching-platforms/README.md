# Branching Platforms Spike

Prototype for a branching-network platform editor. Nodes are junction points in
a graph; segments between nodes render as flat platforms (equal endpoint
heights) or staircases (different heights). Junction geometry is mitered clean
so the overlapping-rectangle problem from `docs/helper images/branching
platform.png` (BEFORE) becomes the clean Y shape (AFTER).

## Run

From the project root:

```
python dev-server.py 8765
```

Then open <http://localhost:8765/spike/branching-platforms/> in a browser.

## Controls

| Action | Control |
| --- | --- |
| Start segment | Click empty space (or segment edge to branch) |
| Set endpoint | Click again (snaps to existing node within 0.5 WT) |
| Adjust width while placing | Mouse wheel |
| Zoom (idle) | Mouse wheel |
| Pan | Middle-mouse drag |
| Select node | Click node dot |
| Raise / lower node height | ↑ / ↓ (when selected) |
| Delete node | Del / Backspace (when selected) |
| Cancel / deselect | Esc |

## Files

- [main.js](main.js) — scene, dirty-set rebuild orchestration
- [graph.js](graph.js) — `Node`, `Segment`, adjacency, `splitSegmentAt`
- [junctionGeometry.js](junctionGeometry.js) — miter math + cap polygon
- [segmentGeometry.js](segmentGeometry.js) — flat + stair builders using an
  along/perp basis per-segment
- [junctionCap.js](junctionCap.js) — cap top (triangle fan) + skirts on
  open-gap edges
- [topDownCamera.js](topDownCamera.js) — ortho camera + screen→world unproject
- [input.js](input.js) — state machine (IDLE / PLACING / SELECTED)
- [materials.js](materials.js) — loads the two simple-style textures from the
  main project (`public/textures/floor_doorframe.bmp`, `blue_stairs.bmp`)

## Known limitations

- No railings yet — user-requested but deferred to keep the spike focused on
  clean junction geometry.
- Very acute junctions are clamped (bevel) rather than fully spiked; not
  visually identical to an infinite miter join, but avoids degenerate polygons.
- No save/load. Graph lives in memory.
- No 3D preview view. Top-down only.
