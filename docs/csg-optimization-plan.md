# CSG Performance Optimization Plan

## Problem

At ~450 brushes the editor becomes sluggish. The root cause: when any brush in a region changes, the **entire region is re-evaluated from scratch** — all baked + unbaked brushes are serialized to JSON, sent to WASM, and processed sequentially through the BSP-tree CSG algorithm. There is no caching of intermediate results. The system already has region-level incremental rebuilds (`rebuildAffectedRegions`), but within each region, every brush is replayed every time.

## Current Architecture Summary

- Brushes are clustered into independent regions via AABB overlap (O(n^2) BFS)
- Each region has a shell + baked brushes + unbaked brushes
- `evaluateBrushes()` concatenates ALL brushes, JSON.stringify's them, sends to WASM
- Rust `evaluate()` processes sequentially: shell -> subtract/union each brush
- Pre-merge optimization exists (3+ consecutive subtracts unioned first)
- `rebuildAllCSG()` tears down everything (triggered by undo, delete, view-mode toggle)
- WASM compiled with `opt-level = "z"` (size-optimized, not speed)

## Optimization Plan (4 tiers, ordered by impact/effort)

### Tier 1: `opt-level = 3` (free speed, 1 min)

Change `opt-level = "z"` to `opt-level = 3` in `spike/csg-wasm-bench/csg-wasm/Cargo.toml` line 17.

`"z"` optimizes for binary size. `3` enables aggressive inlining and loop unrolling — critical for the tight vertex loops in `split_polygon` and `clip_polygons`. Expected 10-30% speedup for ~30KB larger WASM binary.

### Tier 2: View-mode toggle skip CSG (quick win, JS-only)

`src/tools/indoorKeys.js` line 381 calls `rebuildAllCSG()` just to switch grid/textured. The CSG geometry hasn't changed — only materials/UVs differ.

**Change:** Store raw CSG geometry (positions/normals/indices) in `csgRegionMeshes` entries, add a `refreshAllCSGMaterials()` function that re-runs only `assignUVsAndZones` or applies grid material without re-evaluating CSG.

**Files:**
- `src/mesh/csgMesh.js` — store raw geometry in mesh data, add `refreshAllCSGMaterials()`
- `src/tools/indoorKeys.js` line 381 — call `refreshAllCSGMaterials()` instead of `rebuildAllCSG()`

### Tier 3: Baked polygon cache in Rust (biggest win)

The bake system already separates frozen brushes from active ones. But `evaluateBrushes()` sends ALL of them to WASM every time. The baked brushes never change — their CSG result can be cached.

**Approach:**

1. Add a `thread_local!` cache in lib.rs: `HashMap<u32, (u32, Vec<Polygon>)>` keyed by region ID, storing (baked_version, polygon_result_after_baked_brushes)
2. New WASM entry point: `evaluate_region_incremental(region_id, baked_version, baked_json, unbaked_json, world_scale)`
   - If cache hit (same region_id + baked_version): clone cached polygons, only replay unbaked brushes
   - If cache miss: evaluate baked brushes, cache result, then continue with unbaked
3. Add `clear_region_cache(id)` and `clear_all_caches()` exports, called from `rebuildAllCSG()`
4. Add `bakedVersion` counter to CSGRegion, incremented in `bake()`

**Files:**
- `spike/csg-wasm-bench/csg-wasm/src/lib.rs` — new entry point + cache
- `src/core/csg/CSGRegion.js` — split payload into baked/unbaked, call incremental API
- `src/core/csg/wasmCSG.js` — export new WASM wrapper
- `src/mesh/csgMesh.js` — call `clear_all_caches()` in `rebuildAllCSG()`

**Impact:** Region with 40 baked + 5 unbaked goes from 45 CSG ops to 5. This is the dominant win.

### Tier 4: AABB early-out in Rust evaluate() (opportunistic)

Before performing `csg_subtract`/`csg_union` on each brush, check if the brush's AABB overlaps the current result's bounding box. Skip brushes that can't affect the result. O(1) per brush.

**File:** `spike/csg-wasm-bench/csg-wasm/src/lib.rs` — add `compute_aabb()` helper, check before each CSG op in `evaluate()`

## Implementation Sequence

1. **Phase 1** — Tier 1 + Tier 2 (JS-only changes + Cargo.toml tweak)
2. **Phase 2** — Tier 3 (requires Rust changes + WASM rebuild + JS integration)
3. **Phase 3** — Tier 4 (small Rust addition, can be done during Phase 2 rebuild)

## Verification

1. Build WASM: `cd spike/csg-wasm-bench/csg-wasm && wasm-pack build --target web --release`
2. Copy outputs to `src/core/csg/wasm/`
3. Open editor, create 20+ rooms, bake, add a few more rooms, verify push/pull is responsive
4. Toggle view mode (grid/textured) — should be instant, no CSG re-evaluation
5. Undo/redo — should still work correctly (cache cleared on full rebuild)
6. Check console for any WASM panics
