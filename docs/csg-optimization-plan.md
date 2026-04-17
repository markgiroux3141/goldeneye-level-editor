# CSG Performance Optimization Plan

## Status (April 2026)

### Phase 1 — completed

| Change | File | Impact measured |
|---|---|---|
| `opt-level = 3` + `codegen-units = 1` | [spike/csg-wasm-bench/csg-wasm/Cargo.toml](../spike/csg-wasm-bench/csg-wasm/Cargo.toml) | Part of ~5× speedup |
| AABB early-reject in `evaluate_region` | [spike/csg-wasm-bench/csg-wasm/src/lib.rs](../spike/csg-wasm-bench/csg-wasm/src/lib.rs) | Skips disjoint subtracts + appends disjoint unions |
| JSON-keyed WASM result cache (128-entry FIFO) | [src/core/csg/CSGRegion.js](../src/core/csg/CSGRegion.js) | Unchanged regions skip WASM entirely on `rebuildAllCSG` |
| `rebuildAffectedRegions` auto-assigns unmapped brushes | [src/mesh/csgMesh.js](../src/mesh/csgMesh.js) | Push/pull no longer silently falls back to full rebuild |
| `brushId → brush` Map in uvZones (killed `brushes.find`) | [src/core/csg/uvZones.js](../src/core/csg/uvZones.js) | ~1.4M comparisons/edit → ~35k |
| Frame-AABB fast-path in uvZones | [src/core/csg/uvZones.js](../src/core/csg/uvZones.js) | UV ~170ms → ~10ms on 4k-tri levels |
| Deferred EdgesGeometry (150ms debounce) | [src/mesh/csgMesh.js](../src/mesh/csgMesh.js) | Edges cost off the hot path |

Per-edit cost at 35 brushes: **~200ms → ~35ms**. Timing logs are still wired up in `csgMesh.js` / `CSGRegion.js` — search for `[CSG]` in the DevTools console.

### Current bottleneck profile (35 brushes, ~4k tris after CSG)

- **WASM `eval`: ~23ms** — dominant; floor of current edit cost
- UV pass: ~10ms
- Edges: 0ms on edit, pops in ~150ms after pause
- Total: ~35ms

To hit 60fps (<16ms) on active edits we need to attack WASM or reduce the work feeding it.

## Remaining Opportunities (ordered by impact/effort)

### Tier 1 — View-mode toggle should skip CSG (quick, JS-only)

Toggling grid/textured still calls `rebuildAllCSG()` (see [src/tools/indoorKeys.js](../src/tools/indoorKeys.js) — search `rebuildAllCSG` calls triggered by the V key). CSG geometry is unchanged; only materials/UVs differ.

**Change:** store raw (pre-UV) geometry alongside each region mesh, add `refreshAllCSGMaterials()` that re-runs only `assignUVsAndZones` (or swaps to `_gridMaterial`). Call it from the V-key handler instead of `rebuildAllCSG()`.

**Files:**
- [src/mesh/csgMesh.js](../src/mesh/csgMesh.js) — extend region mesh data with raw geo, add `refreshAllCSGMaterials()`
- `src/tools/indoorKeys.js` — route V-key to the new function

**Estimated impact:** view-mode toggles become instant regardless of brush count. No hot-path edit win, but a persistent UX annoyance today.

### Tier 2 — Split mega-regions (medium, semantic change)

Clustering uses `brushesOverlapOrTouch` ([src/core/csg/regions.js:39](../src/core/csg/regions.js#L39)) — any hallway brush that *touches* two rooms transitively glues them into one region. Profiling shows 35-brush levels with distinct rooms collapsing into a single region, so every edit re-CSGs the whole level.

**Approach A — strict overlap.** Switch clustering rule from "touch" to "interior intersection". Rooms separated by a wall stop merging.

**Approach B — explicit seam tagging.** Mark doorframe / hole-frame brushes as "non-transitive" — they can belong to a region but don't cause adjacent rooms to merge.

**Risk:** either approach changes how brushes interact at seams. A door cut across two rooms needs both rooms to see the cut — we'd need the CSG pipeline to evaluate that brush in both regions. Requires careful handling around save/load to not break existing levels.

**Estimated impact:** on a typical multi-room level, 3–8× reduction in per-edit brush count (one room at a time instead of the whole level). Likely the single biggest remaining win.

**Files:**
- [src/core/csg/regions.js](../src/core/csg/regions.js) — clustering rule
- [src/mesh/csgMesh.js](../src/mesh/csgMesh.js) — handle cross-region brushes if Approach B
- `src/csg/csgActions.js` — any code that assumes one-region-per-brush

### Tier 3 — Rust-side baked polygon cache (big, spec'd but not built)

The bake system separates frozen brushes from active ones, but `evaluateBrushes()` still sends ALL of them to WASM every time. Baked brushes never change.

**Approach:**
1. Add `thread_local!` cache in [spike/csg-wasm-bench/csg-wasm/src/lib.rs](../spike/csg-wasm-bench/csg-wasm/src/lib.rs): `HashMap<u32, (u32, Vec<Polygon>)>` keyed by region id → (baked_version, polygon_result_after_baked).
2. New WASM entry point `evaluate_region_incremental(region_id, baked_version, baked_json, unbaked_json, world_scale)`. Hit = clone cached polys, replay only unbaked brushes. Miss = evaluate baked, cache, then continue.
3. Export `clear_region_cache(id)` / `clear_all_caches()`, called from `rebuildAllCSG()`.
4. Add `bakedVersion` counter on `CSGRegion`, increment in `bake()`.

**Files:**
- [spike/csg-wasm-bench/csg-wasm/src/lib.rs](../spike/csg-wasm-bench/csg-wasm/src/lib.rs)
- [src/core/csg/CSGRegion.js](../src/core/csg/CSGRegion.js) — split payload into baked/unbaked
- [src/core/csg/wasmCSG.js](../src/core/csg/wasmCSG.js) — export new wrapper
- [src/mesh/csgMesh.js](../src/mesh/csgMesh.js) — clear cache in `rebuildAllCSG()`

**Estimated impact:** Region with 40 baked + 5 unbaked goes from 45 CSG ops to 5 — ~9× speedup after bake. Only helps users who bake; a no-op on unbaked flows.

### Tier 4 — Reduce BSP sliver count (big, algorithmic)

Profiling showed 43k triangles for 37 brushes in one session. The custom BSP in [spike/csg-wasm-bench/csg-wasm/src/csg.rs](../spike/csg-wasm-bench/csg-wasm/src/csg.rs) fragments polygons aggressively during Sutherland-Hodgman clipping and never merges them back. That inflates downstream cost (uvZones, faceMap, EdgesGeometry, GPU upload) even after WASM returns.

**Options:**
- **Post-pass coplanar merge** in Rust — detect adjacent coplanar triangles with shared edges and merge into larger polygons before triangulating. Retains the custom BSP.
- **Switch to [manifold-rs](https://github.com/elalish/manifold)** — production-grade mesh boolean library, much less sliver generation. Larger rewrite, different data model.
- **Weld + decimate in JS** pre-uvZones — less surgical but easier to try first. Three.js has `BufferGeometryUtils.mergeVertices`.

**Estimated impact:** Could 5–10× reduce triangle count, which compounds across every downstream stage. Depending on option, either a 1–2 day task (weld) or a multi-week task (manifold).

### Tier 5 — Rust allocation hygiene (small, opportunistic)

`split_polygon` in [spike/csg-wasm-bench/csg-wasm/src/csg.rs](../spike/csg-wasm-bench/csg-wasm/src/csg.rs) allocates `Vec<[f32;3]>` for `f_verts` / `b_verts` inside the hot loop. Pre-allocate scratch buffers at `Node::clip_polygons` level and pass them down.

**Estimated impact:** 10–20% off the 23ms WASM time (~2–5ms). Small, but the only change at this tier that doesn't alter semantics.

### Tier 6 — Typed-array pre-allocation in uvZones (small)

`newPos`, `newNormals`, `newUVs`, `newColors`, `newFaceIds` in [src/core/csg/uvZones.js](../src/core/csg/uvZones.js) are growing `Array`s filled with `push()`. At 4k tris that's ~36k `push()` calls per attribute. Pre-allocate `Float32Array(triCount * 9)` and write by index.

**Estimated impact:** 2–3ms off the 10ms UV cost.

## Implementation sequence

1. **Tier 1 (view-mode skip)** — smallest independent win, good warm-up.
2. **Tier 3 (Rust baked cache)** — biggest concrete win for baked flows. Spec is already complete.
3. **Tier 2 (mega-region split)** — big fundamental win, but needs a design session on seam semantics first. Don't start until 1 + 3 are measured.
4. **Tier 4 (sliver reduction)** — revisit once edit cost is dominated by something other than the BSP size.
5. **Tier 5, 6** — fill-in work when the bigger tiers are blocked.

## Verification

All tiers: the `[CSG]` timing logs in [src/mesh/csgMesh.js](../src/mesh/csgMesh.js) and [src/core/csg/CSGRegion.js](../src/core/csg/CSGRegion.js) are still wired up. Record a before/after block of 10 push/pulls at 35+ brushes, compare `uv` / `eval` / `total`.

Tier-specific:
- **Tier 1:** toggle V (grid/textured) — no `[CSG] FULL REBUILD` line should appear.
- **Tier 2:** build a two-room level connected by a hallway — `incr rebuild end: 1/N regions` where N > 1 (not 1/1).
- **Tier 3:** bake, then push/pull — `eval` should drop substantially vs unbaked.
- **Tier 4:** `tris` field in `[CSG] region N: ...` should shrink dramatically.

After any Rust change: rebuild wasm (`wasm-pack build --target web` in [spike/csg-wasm-bench/csg-wasm](../spike/csg-wasm-bench/csg-wasm)) and copy `pkg/csg_wasm.js` + `pkg/csg_wasm_bg.wasm` to [src/core/csg/wasm/](../src/core/csg/wasm/). Hard-refresh Brave (Ctrl+Shift+R) — the cache will bite.
