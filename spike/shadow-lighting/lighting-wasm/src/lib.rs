mod math;
mod bvh;
mod bake;
mod edge_flip;
mod subdivide;
mod stencil;

use bake::{bake_vertex_colors, compute_tri_gradients, select_levels, Light};
use bvh::Bvh;
use math::{Triangle, Vec3};
use serde::Deserialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

// ─── Input types ───────────────────────────────────────────────────────

#[derive(Deserialize)]
struct LightInput {
    x: f32, y: f32, z: f32,
    color: [f32; 3],
    intensity: f32,
    range: f32,
    enabled: bool,
}

#[derive(Deserialize)]
struct AabbInput {
    #[serde(rename = "minX")] min_x: f32,
    #[serde(rename = "minY")] min_y: f32,
    #[serde(rename = "minZ")] min_z: f32,
    #[serde(rename = "maxX")] max_x: f32,
    #[serde(rename = "maxY")] max_y: f32,
    #[serde(rename = "maxZ")] max_z: f32,
}

fn parse_lights(json: &str) -> Vec<Light> {
    let parsed: Vec<LightInput> = serde_json::from_str(json).unwrap_or_default();
    parsed.into_iter().map(|l| Light {
        pos: Vec3::new(l.x, l.y, l.z),
        color: Vec3::new(l.color[0], l.color[1], l.color[2]),
        intensity: l.intensity,
        range: l.range,
        enabled: l.enabled,
    }).collect()
}

fn parse_aabbs(json: &str) -> Vec<stencil::Aabb3> {
    let parsed: Vec<AabbInput> = serde_json::from_str(json).unwrap_or_default();
    parsed.into_iter().map(|a| stencil::Aabb3 {
        min: [a.min_x, a.min_y, a.min_z],
        max: [a.max_x, a.max_y, a.max_z],
    }).collect()
}

// ─── BakedMesh output ──────────────────────────────────────────────────

#[wasm_bindgen]
pub struct BakedMesh {
    positions: Vec<f32>,
    normals: Vec<f32>,
    colors: Vec<f32>,
    indices: Vec<u32>,
}

#[wasm_bindgen]
impl BakedMesh {
    pub fn positions(&self) -> js_sys::Float32Array {
        let a = js_sys::Float32Array::new_with_length(self.positions.len() as u32);
        a.copy_from(&self.positions); a
    }
    pub fn normals(&self) -> js_sys::Float32Array {
        let a = js_sys::Float32Array::new_with_length(self.normals.len() as u32);
        a.copy_from(&self.normals); a
    }
    pub fn colors(&self) -> js_sys::Float32Array {
        let a = js_sys::Float32Array::new_with_length(self.colors.len() as u32);
        a.copy_from(&self.colors); a
    }
    pub fn indices(&self) -> js_sys::Uint32Array {
        let a = js_sys::Uint32Array::new_with_length(self.indices.len() as u32);
        a.copy_from(&self.indices); a
    }
    pub fn tri_count(&self) -> u32 { (self.indices.len() / 3) as u32 }
}

// ─── LightingBaker ─────────────────────────────────────────────────────

#[wasm_bindgen]
pub struct LightingBaker {
    lights: Vec<Light>,
    occluder_tris: Vec<Triangle>,
    bvh: Option<Bvh>,
}

fn emit_stencil_tris(tris: &[stencil::Tri], normal: Vec3, out_pos: &mut Vec<f32>, out_nor: &mut Vec<f32>) {
    for tri in tris.iter() {
        out_pos.push(tri.a.x); out_pos.push(tri.a.y); out_pos.push(tri.a.z);
        out_pos.push(tri.b.x); out_pos.push(tri.b.y); out_pos.push(tri.b.z);
        out_pos.push(tri.c.x); out_pos.push(tri.c.y); out_pos.push(tri.c.z);
        for _ in 0..3 {
            out_nor.push(normal.x); out_nor.push(normal.y); out_nor.push(normal.z);
        }
    }
}

#[wasm_bindgen]
impl LightingBaker {
    #[wasm_bindgen(constructor)]
    pub fn new(lights_json: &str) -> LightingBaker {
        LightingBaker {
            lights: parse_lights(lights_json),
            occluder_tris: Vec::new(),
            bvh: None,
        }
    }

    pub fn add_occluder(&mut self, positions: &[f32], indices: &[u32]) {
        let tri_count = indices.len() / 3;
        self.occluder_tris.reserve(tri_count);
        for t in 0..tri_count {
            let i0 = indices[t*3] as usize;
            let i1 = indices[t*3+1] as usize;
            let i2 = indices[t*3+2] as usize;
            let a = Vec3::new(positions[i0*3], positions[i0*3+1], positions[i0*3+2]);
            let b = Vec3::new(positions[i1*3], positions[i1*3+1], positions[i1*3+2]);
            let c = Vec3::new(positions[i2*3], positions[i2*3+1], positions[i2*3+2]);
            self.occluder_tris.push(Triangle { a, b, c });
        }
        self.bvh = None;
    }

    pub fn build(&mut self) {
        let tris = std::mem::take(&mut self.occluder_tris);
        self.bvh = Some(Bvh::build(tris));
    }

    fn ensure_bvh(&mut self) {
        if self.bvh.is_none() { self.build(); }
    }

    /// Mode: no subdivision. Returns source positions/normals with baked colors.
    pub fn bake_none(&mut self, positions: &[f32], normals: &[f32], indices: &[u32]) -> BakedMesh {
        self.ensure_bvh();
        let bvh = self.bvh.as_ref().unwrap();
        let vert_count = positions.len() / 3;
        let mut colors = vec![1.0f32; vert_count * 3];
        bake_vertex_colors(positions, normals, &mut colors, &self.lights, bvh);
        BakedMesh {
            positions: positions.to_vec(),
            normals: normals.to_vec(),
            colors,
            indices: indices.to_vec(),
        }
    }

    /// Mode: uniform per-tri subdivision N×N. Edge-flips coplanar slivers first.
    pub fn bake_uniform(&mut self, positions: &[f32], _normals: &[f32], indices: &[u32], n: u32) -> BakedMesh {
        self.ensure_bvh();
        let bvh = self.bvh.as_ref().unwrap();

        let flipped = edge_flip::flip_to_delaunay(positions, indices.to_vec());
        let tri_count = flipped.len() / 3;
        let levels = vec![n; tri_count];
        let sub = subdivide::subdivide_triangles(positions, &flipped, &levels);
        let mut colors = sub.colors;
        bake_vertex_colors(&sub.positions, &sub.normals, &mut colors, &self.lights, bvh);
        BakedMesh {
            positions: sub.positions,
            normals: sub.normals,
            colors,
            indices: sub.indices,
        }
    }

    /// Mode: adaptive per-tri. Edge-flip → coarse bake → gradient → selective subdivide → rebake.
    pub fn bake_adaptive(&mut self, positions: &[f32], _normals: &[f32], indices: &[u32]) -> BakedMesh {
        self.ensure_bvh();
        let bvh = self.bvh.as_ref().unwrap();

        let flipped = edge_flip::flip_to_delaunay(positions, indices.to_vec());

        // Pass 1 uses flat face-normals on the flipped mesh (subdivide level=1 is a
        // cheap way to get one vertex per tri vertex with the correct flat normal).
        let tri_count = flipped.len() / 3;
        let ones = vec![1u32; tri_count];
        let base = subdivide::subdivide_triangles(positions, &flipped, &ones);
        let mut base_colors = base.colors.clone();
        bake_vertex_colors(&base.positions, &base.normals, &mut base_colors, &self.lights, bvh);

        let gradients = compute_tri_gradients(&base_colors, &base.indices);
        let levels = select_levels(&gradients);

        // Pass 2: selective subdivision on the same flipped mesh.
        let sub = subdivide::subdivide_triangles(positions, &flipped, &levels);
        let mut colors = sub.colors;
        bake_vertex_colors(&sub.positions, &sub.normals, &mut colors, &self.lights, bvh);

        BakedMesh {
            positions: sub.positions,
            normals: sub.normals,
            colors,
            indices: sub.indices,
        }
    }

    /// Mode: stencil cuts at projected shadow edges. Edge-flip → per-tri cuts → bake.
    pub fn bake_stencil(
        &mut self,
        positions: &[f32],
        _normals: &[f32],
        indices: &[u32],
        other_aabbs_json: &str,
        penumbra_width: f32,
    ) -> BakedMesh {
        self.ensure_bvh();
        let bvh = self.bvh.as_ref().unwrap();
        let occluders = parse_aabbs(other_aabbs_json);

        let flipped = edge_flip::flip_to_delaunay(positions, indices.to_vec());
        let tri_count = flipped.len() / 3;

        let mut all_pos: Vec<f32> = Vec::new();
        let mut all_nor: Vec<f32> = Vec::new();

        for t in 0..tri_count {
            let face = stencil::face_info_for_tri(positions, &flipped, t);
            let cuts = stencil::compute_shadow_cuts(&self.lights, &occluders, &face, penumbra_width);
            let mut tris: Vec<stencil::Tri> = vec![stencil::tri_from_indices(positions, &flipped, t)];
            for cut in cuts.iter() {
                tris = stencil::split_tris_at_axis(&tris, cut.axis, cut.value);
            }
            let normal = Vec3::new(face.normal[0], face.normal[1], face.normal[2]);
            emit_stencil_tris(&tris, normal, &mut all_pos, &mut all_nor);
        }

        let vert_count = all_pos.len() / 3;
        let mut colors = vec![1.0f32; vert_count * 3];
        bake_vertex_colors(&all_pos, &all_nor, &mut colors, &self.lights, bvh);

        let mut idx_out = vec![0u32; vert_count];
        for i in 0..vert_count { idx_out[i] = i as u32; }

        BakedMesh { positions: all_pos, normals: all_nor, colors, indices: idx_out }
    }
}
