mod csg;

use csg::{csg_subtract, csg_union, polygons_to_mesh, Polygon};
use serde::Deserialize;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

// ─── Init ───────────────────────────────────────────────────────────

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

// ─── Input types (deserialized from JSON) ───────────────────────────

#[derive(Deserialize)]
struct TaperValue {
    u: f32,
    v: f32,
}

#[derive(Deserialize)]
struct BrushInput {
    #[serde(default)]
    #[allow(dead_code)]
    id: i32,
    #[serde(default = "default_op")]
    op: String,
    x: f64,
    y: f64,
    z: f64,
    w: f64,
    h: f64,
    d: f64,
    #[serde(default)]
    taper: HashMap<String, TaperValue>,
}

fn default_op() -> String {
    "subtract".to_string()
}

#[derive(Deserialize)]
struct RegionInput {
    shell: BrushInput,
    brushes: Vec<BrushInput>,
}

// ─── Brush → Polygon conversion ────────────────────────────────────

/// Convert a brush definition to 6 quad polygons (a closed convex box).
fn brush_to_polygons(b: &BrushInput, ws: f32) -> Vec<Polygon> {
    let ws64 = ws as f64;
    let x0 = (b.x * ws64) as f32;
    let x1 = ((b.x + b.w) * ws64) as f32;
    let y0 = (b.y * ws64) as f32;
    let y1 = ((b.y + b.h) * ws64) as f32;
    let z0 = (b.z * ws64) as f32;
    let z1 = ((b.z + b.d) * ws64) as f32;

    // 8 corners of the box
    let mut c: [[f32; 3]; 8] = [
        [x0, y0, z0], // 0: ---
        [x1, y0, z0], // 1: +--
        [x0, y1, z0], // 2: -+-
        [x1, y1, z0], // 3: ++-
        [x0, y0, z1], // 4: --+
        [x1, y0, z1], // 5: +-+
        [x0, y1, z1], // 6: -++
        [x1, y1, z1], // 7: +++
    ];

    // Apply taper: inset face vertices toward center
    let cx = (x0 + x1) / 2.0;
    let cy = (y0 + y1) / 2.0;
    let cz = (z0 + z1) / 2.0;
    let center = [cx, cy, cz];

    for (face_key, tv) in &b.taper {
        let (indices, u_axis, v_axis): (&[usize], usize, usize) = match face_key.as_str() {
            "x-min" => (&[0, 2, 4, 6], 2, 1), // U=z, V=y
            "x-max" => (&[1, 3, 5, 7], 2, 1),
            "y-min" => (&[0, 1, 4, 5], 0, 2), // U=x, V=z
            "y-max" => (&[2, 3, 6, 7], 0, 2),
            "z-min" => (&[0, 1, 2, 3], 0, 1), // U=x, V=y
            "z-max" => (&[4, 5, 6, 7], 0, 1),
            _ => continue,
        };

        for &idx in indices {
            let u_sign = if c[idx][u_axis] >= center[u_axis] {
                1.0
            } else {
                -1.0
            };
            let v_sign = if c[idx][v_axis] >= center[v_axis] {
                1.0
            } else {
                -1.0
            };
            c[idx][u_axis] -= u_sign * tv.u * ws;
            c[idx][v_axis] -= v_sign * tv.v * ws;
        }
    }

    // 6 faces, CCW winding from outside
    let face_defs: [([usize; 4], [f32; 3]); 6] = [
        ([0, 4, 6, 2], [-1.0, 0.0, 0.0]), // x-min
        ([1, 3, 7, 5], [1.0, 0.0, 0.0]),   // x-max
        ([0, 1, 5, 4], [0.0, -1.0, 0.0]),  // y-min
        ([2, 6, 7, 3], [0.0, 1.0, 0.0]),   // y-max
        ([0, 2, 3, 1], [0.0, 0.0, -1.0]),  // z-min
        ([4, 5, 7, 6], [0.0, 0.0, 1.0]),   // z-max
    ];

    let mut polygons = Vec::with_capacity(6);
    for (vi, _default_normal) in &face_defs {
        let verts = vec![c[vi[0]], c[vi[1]], c[vi[2]], c[vi[3]]];
        // Compute actual plane from vertices (handles taper correctly)
        if let Some(poly) = Polygon::new(verts) {
            polygons.push(poly);
        }
    }

    polygons
}

// ─── CSG Evaluation ─────────────────────────────────────────────────

#[derive(Clone, Copy)]
struct Aabb {
    min: [f32; 3],
    max: [f32; 3],
}

impl Aabb {
    fn from_brush(b: &BrushInput, ws: f32) -> Self {
        let ws64 = ws as f64;
        // Taper only insets face vertices; the raw box bounds are still a
        // conservative AABB, so the tapered geometry is always contained.
        Aabb {
            min: [
                (b.x * ws64) as f32,
                (b.y * ws64) as f32,
                (b.z * ws64) as f32,
            ],
            max: [
                ((b.x + b.w) * ws64) as f32,
                ((b.y + b.h) * ws64) as f32,
                ((b.z + b.d) * ws64) as f32,
            ],
        }
    }

    fn intersects(&self, other: &Aabb) -> bool {
        self.min[0] <= other.max[0]
            && self.max[0] >= other.min[0]
            && self.min[1] <= other.max[1]
            && self.max[1] >= other.min[1]
            && self.min[2] <= other.max[2]
            && self.max[2] >= other.min[2]
    }

    fn union(&self, other: &Aabb) -> Aabb {
        Aabb {
            min: [
                self.min[0].min(other.min[0]),
                self.min[1].min(other.min[1]),
                self.min[2].min(other.min[2]),
            ],
            max: [
                self.max[0].max(other.max[0]),
                self.max[1].max(other.max[1]),
                self.max[2].max(other.max[2]),
            ],
        }
    }
}

fn evaluate(shell: &BrushInput, brushes: &[BrushInput], world_scale: f32) -> Vec<Polygon> {
    let mut result = brush_to_polygons(shell, world_scale);
    // Accumulator AABB — grows with unions, subtracts never grow it, so this
    // stays a correct upper bound for early-rejecting non-overlapping brushes.
    let mut acc_aabb = Aabb::from_brush(shell, world_scale);

    let mut i = 0;
    while i < brushes.len() {
        let is_subtract = brushes[i].op == "subtract";
        let brush_aabb = Aabb::from_brush(&brushes[i], world_scale);

        if is_subtract {
            // Disjoint subtract is a no-op — skip the BSP build entirely.
            if !brush_aabb.intersects(&acc_aabb) {
                i += 1;
                continue;
            }

            // Look ahead for consecutive subtractive run
            let mut run_end = i + 1;
            while run_end < brushes.len() && brushes[run_end].op == "subtract" {
                run_end += 1;
            }
            let run_len = run_end - i;

            if run_len >= 3 {
                // Pre-merge: union every overlapping brush in the run, then
                // subtract once. Non-overlapping brushes are dropped outright.
                let mut merged: Vec<Polygon> = Vec::new();
                let mut started = false;
                for j in i..run_end {
                    let ja = Aabb::from_brush(&brushes[j], world_scale);
                    if !ja.intersects(&acc_aabb) {
                        continue;
                    }
                    let polys = brush_to_polygons(&brushes[j], world_scale);
                    if !started {
                        merged = polys;
                        started = true;
                    } else {
                        merged = csg_union(merged, polys);
                    }
                }
                if started {
                    result = csg_subtract(result, merged);
                }
                i = run_end;
                continue;
            }
        }

        let polys = brush_to_polygons(&brushes[i], world_scale);
        if is_subtract {
            result = csg_subtract(result, polys);
        } else if !brush_aabb.intersects(&acc_aabb) {
            // Disjoint union — concatenate polygons directly; no BSP needed.
            result.extend(polys);
            acc_aabb = acc_aabb.union(&brush_aabb);
        } else {
            result = csg_union(result, polys);
            acc_aabb = acc_aabb.union(&brush_aabb);
        }
        i += 1;
    }

    result
}

// ─── WASM API ───────────────────────────────────────────────────────

#[wasm_bindgen]
pub struct CSGResult {
    positions: Vec<f32>,
    normals: Vec<f32>,
    indices: Vec<u32>,
}

#[wasm_bindgen]
impl CSGResult {
    pub fn get_positions(&self) -> js_sys::Float32Array {
        let arr = js_sys::Float32Array::new_with_length(self.positions.len() as u32);
        arr.copy_from(&self.positions);
        arr
    }

    pub fn get_normals(&self) -> js_sys::Float32Array {
        let arr = js_sys::Float32Array::new_with_length(self.normals.len() as u32);
        arr.copy_from(&self.normals);
        arr
    }

    pub fn get_indices(&self) -> js_sys::Uint32Array {
        let arr = js_sys::Uint32Array::new_with_length(self.indices.len() as u32);
        arr.copy_from(&self.indices);
        arr
    }

    pub fn tri_count(&self) -> u32 {
        (self.indices.len() / 3) as u32
    }

    pub fn vert_count(&self) -> u32 {
        (self.positions.len() / 3) as u32
    }
}

/// Evaluate CSG for a single region.
/// `region_json`: JSON with { shell: BrushInput, brushes: BrushInput[] }
/// `world_scale`: 0.25 (1 WT = 0.25 world units)
#[wasm_bindgen]
pub fn evaluate_region(region_json: &str, world_scale: f32) -> CSGResult {
    let input: RegionInput =
        serde_json::from_str(region_json).expect("Failed to parse region JSON");

    let polygons = evaluate(&input.shell, &input.brushes, world_scale);
    let (positions, normals, indices) = polygons_to_mesh(&polygons);

    CSGResult {
        positions,
        normals,
        indices,
    }
}
