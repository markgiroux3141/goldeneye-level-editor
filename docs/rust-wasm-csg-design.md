thi# Rust WASM CSG Accelerator — Design Document

Reference design for replacing the JavaScript CSG pipeline with a Rust WASM module.
Not an immediate implementation — captured here for future work.

---

## Table of Contents

1. [Current Architecture](#current-architecture)
2. [Why Rust WASM](#why-rust-wasm)
3. [Phase 1: CSG Boolean Evaluation](#phase-1-csg-boolean-evaluation)
4. [Phase 2: Face Identity Recovery](#phase-2-face-identity-recovery)
5. [Phase 3: UV/Zone Assignment](#phase-3-uvzone-assignment)
6. [Phase 4: Lighting Bake](#phase-4-lighting-bake)
7. [Build and Deployment](#build-and-deployment)
8. [Risks and Mitigations](#risks-and-mitigations)

---

## Current Architecture

The editor uses `three-bvh-csg` (pure JavaScript, BVH-accelerated) for all CSG operations.

**Pipeline:**

```
BrushDef[] → clusterBrushes() → CSGRegion[]
  each region → evaluateBrushes()
    shell.toCSGBrush()
    - bakedCSGBrush (if present)
    ± each unbaked brush (with pre-merge optimization)
  → raw geometry (indexed triangle soup)
  → buildFaceMap()          # recover per-tri brush/face identity
  → assignUVsAndZones()     # un-index, split, classify, compute UVs
  → THREE.Mesh + materials
```

**Key files:**

| File | Role |
|------|------|
| `src/core/BrushDef.js` | Brush data model + Three.js CSG brush conversion |
| `src/core/csg/CSGRegion.js` | Per-region CSG evaluation + baking |
| `src/core/csg/faceMap.js` | Triangle → brush face identity recovery |
| `src/core/csg/uvZones.js` | Zone classification, triangle splitting, UV computation |
| `src/core/csg/regions.js` | Spatial clustering (flood-fill on AABB overlap) |
| `src/mesh/csgMesh.js` | Mesh lifecycle, rebuild coordination |
| `src/lighting/lightBaker.js` | Per-vertex baked lighting + shadows |

**Existing optimizations:**
- Consecutive brush pre-merging: runs of 3+ subtractive brushes unioned first, then subtracted once
- Incremental region rebuilds: only dirty regions re-evaluated
- Single shared CSG evaluator with BVH caching
- Manual baking: merge interior into single brush

---

## Why Rust WASM

All brushes are **axis-aligned boxes** (with optional planar taper). This is dramatically simpler than general mesh CSG — it reduces to clipping convex polyhedra against axis-aligned half-spaces. A custom Rust implementation exploiting this constraint will far outperform a general-purpose JS CSG library.

**Expected speedups by phase:**

| Phase | Operation | Expected Speedup |
|-------|-----------|-----------------|
| 1 | CSG boolean evaluation | 10–30x |
| 2 | Face identity matching | 5–10x (plus algorithmic improvement) |
| 3 | UV/zone assignment | 3–5x |
| 4 | Lighting bake | 20–50x |

Additional benefit: no GC pauses during editing → smoother frame times.

---

## Phase 1: CSG Boolean Evaluation

**Target:** Replace `CSGRegion.evaluateBrushes()` (`src/core/csg/CSGRegion.js:63`)

### Rust Project Structure

```
csg-wasm/
  Cargo.toml
  src/
    lib.rs            # wasm-bindgen entry points
    brush.rs          # BrushDef equivalent
    polyhedron.rs     # Convex polyhedron representation
    csg.rs            # Boolean operations (union, subtract)
    mesh.rs           # Output mesh builder (indexed triangles)
```

### Dependencies

```toml
[package]
name = "csg-wasm"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
wasm-bindgen = "0.2"
js-sys = "0.3"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
glam = "0.29"                    # SIMD-friendly vec3 math
console_error_panic_hook = "0.1" # readable panic traces in dev

[profile.release]
opt-level = "z"    # size optimization
lto = true
```

### Rust Data Structures

```rust
// brush.rs
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum BrushOp { Add, Subtract }

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TaperValue { pub u: f32, pub v: f32 }

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BrushDef {
    pub id: i32,              // -1 = shell, 0 = baked, >0 = user brush
    pub op: BrushOp,
    pub x: i32, pub y: i32, pub z: i32,   // WT position (min corner)
    pub w: i32, pub h: i32, pub d: i32,   // WT dimensions
    pub taper: HashMap<String, TaperValue>, // "x-min" → {u, v}
    pub is_doorframe: bool,
    pub is_hole_frame: bool,
    pub is_brace: bool,
    pub is_stair_step: bool,
    pub scheme_key: String,
    pub floor_y: i32,
}

// polyhedron.rs
use glam::Vec3;

/// A convex polyhedron as a set of planar polygonal faces.
/// Each face is a convex polygon wound CCW when viewed from outside.
#[derive(Clone)]
pub struct ConvexPoly {
    pub faces: Vec<Face>,
}

#[derive(Clone)]
pub struct Face {
    pub normal: Vec3,
    pub vertices: Vec<Vec3>,
    pub plane_d: f32,           // n · v = d for any vertex on this face
    pub source_brush_id: i32,   // which brush generated this face (-1 = shell)
    pub source_axis: u8,        // 0=x, 1=y, 2=z
    pub source_side: u8,        // 0=min, 1=max
}

// mesh.rs — output buffer
pub struct MeshOutput {
    pub positions: Vec<f32>,  // [x0,y0,z0, x1,y1,z1, ...]
    pub normals: Vec<f32>,
    pub indices: Vec<u32>,
}
```

### CSG Algorithm

Since all primitives are convex polyhedra (boxes, optionally tapered):

**Subtract(accumulator, brush):**
1. Compute the clip planes of `brush` (6 for a box, potentially non-axis-aligned if tapered)
2. For each polygon in `accumulator`:
   - If fully outside `brush` → keep unchanged
   - If fully inside `brush` → discard
   - If straddling a clip plane → split at intersection, keep the outside fragment
3. Generate cap polygons on `brush`'s planes where it intersects `accumulator`

**Union(a, b):** Used for pre-merging consecutive subtractive brushes.
For convex-vs-convex: `Union(A, B) = A + B - Intersection(A, B)`.
Since we only union simple boxes before a single subtraction, the intermediate result's complexity is bounded.

**Key optimization for axis-aligned faces:**
When both the accumulator polygon and clip plane are axis-aligned, splitting is just a coordinate comparison — no general plane-polygon intersection needed. This is the common case (tapered faces are the exception).

### WASM Interface

```rust
// lib.rs
use wasm_bindgen::prelude::*;
use js_sys::{Float32Array, Uint32Array};

#[wasm_bindgen]
pub struct CSGResult {
    positions: Vec<f32>,
    normals: Vec<f32>,
    indices: Vec<u32>,
}

#[wasm_bindgen]
impl CSGResult {
    pub fn positions(&self) -> Float32Array {
        Float32Array::from(&self.positions[..])
    }
    pub fn normals(&self) -> Float32Array {
        Float32Array::from(&self.normals[..])
    }
    pub fn indices(&self) -> Uint32Array {
        Uint32Array::from(&self.indices[..])
    }
    pub fn tri_count(&self) -> u32 {
        (self.indices.len() / 3) as u32
    }
}

/// Evaluate CSG for a single region.
/// `brushes_json`: JSON array of BrushDef (shell first, then user brushes)
/// `world_scale`: 0.25 (1 WT = 0.25 Three.js meters)
#[wasm_bindgen]
pub fn evaluate_region(brushes_json: &str, world_scale: f32) -> CSGResult {
    // 1. Deserialize brushes
    // 2. Separate shell from user brushes
    // 3. Build shell polyhedron
    // 4. Apply pre-merge optimization for consecutive subtractive runs
    // 5. Evaluate CSG: shell ± brushes
    // 6. Triangulate output polygons
    // 7. Scale by world_scale
    // 8. Return CSGResult
    todo!()
}
```

### JS Integration

In `src/core/csg/CSGRegion.js`, replace the body of `evaluateBrushes()`:

```javascript
// At module top:
let wasmCSG = null;
try {
    const mod = await import('/wasm/csg_wasm.js');
    await mod.default();  // init WASM
    wasmCSG = mod;
} catch (e) {
    console.warn('WASM CSG not available, using JS fallback');
}

// In evaluateBrushes():
evaluateBrushes() {
    this.updateShell();
    const t0 = performance.now();

    let geometry;

    if (wasmCSG && !this.bakedCSGBrush) {
        // WASM fast path (no baked geometry yet)
        const brushData = JSON.stringify([
            this.shell.toJSON(),
            ...this.brushes.map(b => b.toJSON())
        ]);
        const result = wasmCSG.evaluate_region(brushData, WORLD_SCALE);

        geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position',
            new THREE.Float32BufferAttribute(result.positions(), 3));
        geometry.setAttribute('normal',
            new THREE.Float32BufferAttribute(result.normals(), 3));
        geometry.setIndex(new THREE.Uint32BufferAttribute(result.indices(), 1));
        result.free(); // release WASM memory
    } else {
        // JS fallback (original three-bvh-csg path)
        let r = this.shell.toCSGBrush();
        if (this.bakedCSGBrush) {
            r = csgEvaluator.evaluate(r, this.bakedCSGBrush, SUBTRACTION);
        }
        // ... existing pre-merge + sequential eval logic ...
        geometry = r.geometry;
    }

    const elapsed = performance.now() - t0;
    const allBrushes = [this.shell, ...this.brushes];
    const faceIds = buildFaceMap(geometry, allBrushes);
    return { geometry, timeMs: elapsed, faceIds };
}
```

### Baked Geometry Handling

Phase 1 uses the JS fallback when `bakedCSGBrush` exists (arbitrary mesh from previous merges). Phase 2 adds support for passing baked geometry as a vertex/index buffer to WASM.

---

## Phase 2: Face Identity Recovery

**Target:** Replace `buildFaceMap()` (`src/core/csg/faceMap.js:12`)

### Why Chain with Phase 1

Face mapping runs on CSG output. If CSG is already in Rust, the mesh data is in WASM memory — passing it to JS for face mapping and back is wasteful. Better to chain: CSG → face map → return combined result.

### Algorithmic Improvement

Current JS: O(triangles x brushFaces) linear scan with tolerance checks.

Rust approach:
1. **Propagate identity through CSG** — during clipping, tag each output polygon with its source brush. Most triangles get identity "for free" without any post-hoc matching.
2. **Fallback for split/boundary triangles** — use spatial indexing:
   - Group brush faces by axis (3 buckets)
   - Within each axis, sort by position
   - Per triangle: classify dominant normal → axis, binary search for position, check centroid containment
   - Complexity: O(T * log(B)) instead of O(T * B * 6)

### Extended Output

```rust
#[wasm_bindgen]
pub struct CSGResult {
    positions: Vec<f32>,
    normals: Vec<f32>,
    indices: Vec<u32>,
    // Phase 2 additions:
    face_brush_ids: Vec<i32>,    // per-triangle: source brush id
    face_axes: Vec<u8>,          // per-triangle: 0=x, 1=y, 2=z
    face_sides: Vec<u8>,         // per-triangle: 0=min, 1=max
    face_positions: Vec<f32>,    // per-triangle: world position along axis
}

#[wasm_bindgen]
impl CSGResult {
    pub fn face_brush_ids(&self) -> Int32Array { ... }
    pub fn face_axes(&self) -> Uint8Array { ... }
    pub fn face_sides(&self) -> Uint8Array { ... }
    pub fn face_positions(&self) -> Float32Array { ... }
}
```

JS side reconstructs the `faceIds` array from these typed arrays instead of calling `buildFaceMap`.

### Baked Geometry Support

With face identity propagation built into the CSG clipper, we can now accept baked geometry as input:

```rust
#[wasm_bindgen]
pub fn evaluate_region_with_baked(
    brushes_json: &str,
    baked_positions: &[f32],   // from bakedCSGBrush.geometry
    baked_indices: &[u32],
    baked_normals: &[f32],
    world_scale: f32,
) -> CSGResult { ... }
```

This eliminates the JS fallback for baked regions.

---

## Phase 3: UV/Zone Assignment

**Target:** Replace `assignUVsAndZones()` (`src/core/csg/uvZones.js`)

### What It Does

1. Un-index geometry (per-triangle vertices for independent UVs)
2. Split triangles at doorframe/holeframe AABB boundaries
3. Split wall triangles at `WALL_SPLIT_V = 6 WT` height
4. Classify each triangle into zones 0–7
5. Compute world-space UVs per face axis
6. Sort triangles by material group
7. Emit group ranges for Three.js material array

### Zones

| Zone | Meaning | Classification |
|------|---------|---------------|
| 0 | Floor | Normal points up (+Y) |
| 1 | Ceiling | Normal points down (-Y) |
| 2 | Lower wall | Horizontal normal, below WALL_SPLIT_V |
| 3 | Upper wall | Horizontal normal, above WALL_SPLIT_V |
| 5 | Tunnel wall | Inside door/hole frame brush |
| 6 | Tunnel floor | Floor of door frame |
| 7 | Brace | Brush has `isBrace` flag |

### Extended Interface

```rust
#[wasm_bindgen]
pub fn evaluate_region_full(
    brushes_json: &str,
    world_scale: f32,
    wall_split_v: i32,       // 6 WT
) -> CSGFullResult;

#[wasm_bindgen]
pub struct CSGFullResult {
    // Un-indexed, split, UV-mapped geometry
    positions: Vec<f32>,       // 3 per vertex, 3 verts per tri (no index buffer)
    normals: Vec<f32>,
    uvs: Vec<f32>,             // 2 per vertex
    colors: Vec<f32>,          // 3 per vertex (all white initially)

    // Per-triangle identity
    face_brush_ids: Vec<i32>,
    face_axes: Vec<u8>,
    face_sides: Vec<u8>,
    face_positions: Vec<f32>,

    // Material groups (sorted by group)
    group_starts: Vec<u32>,       // byte offset into positions
    group_counts: Vec<u32>,       // triangle count per group
    group_zone_indices: Vec<u32>, // zone index (0-7) per group

    // Scheme keys for JS material lookup
    scheme_keys_json: String,  // JSON: ["facility_white_tile", ...]
}
```

JS side constructs `THREE.BufferGeometry` with `groups` array and looks up materials by scheme key + zone. Material creation stays in JS (Three.js objects).

### UV Rules (for reference)

- **X-axis face:** U = z, V = y
- **Y-axis face:** U = x, V = z
- **Z-axis face:** U = x, V = y
- Wall V anchored to `brush.floorY` (not world Y=0)

---

## Phase 4: Lighting Bake

**Target:** Replace `bakeGeometry()` in `src/lighting/lightBaker.js`

This is independent of Phases 1–3 and can be developed in parallel.

### Why It's the Biggest Single Win

The lighting bake does per-vertex raycasting against all scene geometry for every light. It's embarrassingly parallel CPU work — exactly where Rust excels over JS.

### Interface

```rust
#[wasm_bindgen]
pub fn bake_lighting(
    // Target mesh to light (positions/normals as flat f32 arrays)
    target_positions: &[f32],
    target_normals: &[f32],

    // Occluder geometry (all scene meshes combined into one buffer)
    occluder_positions: &[f32],
    occluder_indices: &[u32],

    // Lights as JSON
    lights_json: &str,  // [{x,y,z, r,g,b, intensity, range}]

    // Parameters
    ambient: f32,
    ao_samples: u32,
    shadow_bias: f32,
    world_scale: f32,
) -> Float32Array;  // output: per-vertex colors (r,g,b per vertex)
```

### Rust BVH for Raycasting

Use the `bvh` crate (v0.9) to build a BVH over occluder triangles. This replaces Three.js's `Raycaster.intersectObjects`. For axis-aligned geometry, BVH construction and traversal are particularly fast.

### AO Sampling

Port the hemisphere sampling (Hammersley sequence + cosine weighting) directly. Pre-compute sample directions once. The per-vertex AO loop is a tight raycast loop that Rust handles 20–50x faster than JS.

### JS Integration

In `src/lighting/lightBaker.js`, the bake function collects all scene meshes into combined buffers, calls the WASM function, and writes the returned colors back into `BufferAttribute('color')`.

### Future: WASM Threads

If `SharedArrayBuffer` is available (requires `Cross-Origin-Isolation` headers), the bake can be parallelized across WASM threads using `wasm-bindgen-rayon`. The lighting bake is embarrassingly parallel — each vertex is independent. This could yield another 4–8x on top of the Rust speedup.

---

## Build and Deployment

### Build Command

```bash
cd csg-wasm
wasm-pack build --target web --out-dir ../public/wasm
wasm-opt -Oz ../public/wasm/csg_wasm_bg.wasm -o ../public/wasm/csg_wasm_bg.wasm
```

`--target web` generates an ES module (`csg_wasm.js` + `csg_wasm_bg.wasm`) compatible with the project's no-bundler, import-map architecture.

### File Layout

```
public/
  wasm/
    csg_wasm.js          # generated ES module glue
    csg_wasm_bg.wasm     # compiled WASM binary
csg-wasm/
  Cargo.toml
  src/
    lib.rs
    brush.rs
    polyhedron.rs
    csg.rs
    mesh.rs
```

### Loading in JS

```javascript
// Async init at app startup (e.g., in main.js)
let wasmCSG = null;
try {
    const mod = await import('./wasm/csg_wasm.js');
    await mod.default();
    wasmCSG = mod;
    console.log('WASM CSG loaded');
} catch (e) {
    console.warn('WASM CSG unavailable, using JS fallback:', e.message);
}
export { wasmCSG };
```

No changes to `index.html` import map needed — the WASM glue is loaded as a relative import.

### Dev Server

The existing `dev-server.py` serves static files. It needs to serve `.wasm` files with the correct MIME type (`application/wasm`). Add to the server if not already handled:

```python
# In dev-server.py, ensure WASM MIME type:
mimetypes.add_type('application/wasm', '.wasm')
```

---

## Risks and Mitigations

### 1. Numerical Precision Differences

**Risk:** Rust f32 math may produce slightly different triangle splits than JS `three-bvh-csg`, causing visual glitches at seams.

**Mitigation:** Use the same WT grid quantization. All brush coordinates are integers in WT — snap output vertices to the WT grid where appropriate. Use epsilon tolerances matching `CSG_CENTROID_TOL = 0.5 WT`.

### 2. Tapered Brush Geometry

**Risk:** Taper modifies box vertices to create non-axis-aligned faces. The CSG clipper must handle arbitrary planar faces, not just axis-aligned.

**Mitigation:** The convex polyhedron clipper handles arbitrary convex polygons by design. Axis-aligned is the fast path; tapered faces use the general (but still fast) plane-polygon intersection.

### 3. WASM File Size

**Risk:** With `serde_json`, `glam`, and BVH code, the WASM binary could be 200–500KB.

**Mitigation:** Use `wasm-opt -Oz`. Strip debug info in release builds. Consider replacing `serde_json` with a lighter input format (e.g., flat binary packing via `DataView`) if size is a concern. The module loads once and caches.

### 4. Baked Geometry Passthrough

**Risk:** The `bakedCSGBrush` is an arbitrary mesh, not a simple box. Phase 1 can't handle it.

**Mitigation:** Phase 1 falls back to JS when baked geometry exists. Phase 2 adds arbitrary mesh input support. Baking is manual and infrequent — the fallback covers the transition.

### 5. Browser Compatibility

**Risk:** WASM not supported.

**Mitigation:** All modern browsers support WASM. The existing import map approach already requires a modern browser. The JS fallback path ensures the editor works everywhere regardless.

### 6. Debugging Difficulty

**Risk:** WASM is harder to debug than JS.

**Mitigation:** Use `console_error_panic_hook` for readable Rust panics. Write comprehensive Rust unit tests (`cargo test`). Build a comparison mode that runs both JS and WASM paths and logs differences.

---

## Testing Strategy

### Unit Tests (Rust)

```bash
cd csg-wasm && cargo test
```

Test cases:
- Single box shell, no brushes → 12 triangles (6 faces, 2 tris each)
- Shell minus one centered box → room interior
- Shell minus two adjacent boxes → connected rooms
- Pre-merge: 5 consecutive subtracts → same result as sequential
- Tapered brush subtraction
- Face identity propagation through clipping

### Integration Tests (Browser)

Run both JS and WASM paths on the same brush set, compare:
- Triangle count matches (within tolerance for different triangulation)
- Vertex positions within epsilon
- Face identity assignments match
- UV coordinates match

### Regression Tests

Load saved level JSON files, evaluate all regions via both paths. Compare mesh checksums. Automate with a headless browser test harness.

---

## Implementation Priority

Phases 1+2 together deliver the biggest impact for interactive editing (CSG eval + face mapping in one WASM call). Phase 3 is a natural extension. Phase 4 is independent and highest impact for the bake operation specifically.

**Recommended order:** Phase 1+2 → Phase 3 → Phase 4

**Estimated effort:**
- Phase 1+2: 2–4 weeks
- Phase 3: 1–2 weeks
- Phase 4: 2–3 weeks
