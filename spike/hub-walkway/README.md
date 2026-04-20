# Hub-Walkway Spike

Alternate model vs. [spike/branching-platforms](../branching-platforms/): two
explicit entity types.

- **Hub** — axis-aligned rectangular platform (the "rooms"). Placed by clicking
  two opposite corners.
- **Walkway** — connects a point on one hub's edge to a point on another hub's
  edge. Arbitrary angle; flat if both hubs share a height, stairs if they differ.

The hub's skirt is cut out where a walkway attaches, so the walkway meets the
hub cleanly (modulo a small visual seam for oblique attachments — geometry is
watertight but the endcap is perpendicular to the walkway axis rather than
flush with the hub edge).

## Run

```
python dev-server.py 8765
```

Open <http://localhost:8765/spike/hub-walkway/>.

## Controls

| Action | Control |
| --- | --- |
| Start hub | Click empty space |
| Commit hub | Click opposite corner |
| Start walkway | Click hub edge (green snap ring appears on hover) |
| Commit walkway | Click a different hub's edge |
| Adjust walkway width | Wheel (during walkway placement) |
| Zoom | Wheel (idle) |
| Pan | Middle-mouse drag |
| Select hub | Click inside a hub |
| Raise / lower hub | ↑ / ↓ (when selected) |
| Delete hub | Del / Backspace (cascades attached walkways) |
| Cancel / deselect | Esc |
