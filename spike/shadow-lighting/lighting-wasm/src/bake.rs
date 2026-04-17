// Per-vertex shadow-ray baking.

use crate::bvh::Bvh;
use crate::math::Vec3;

const SHADOW_BIAS: f32 = 0.05;
const AMBIENT: f32 = 0.08;

#[derive(Clone, Copy)]
pub struct Light {
    pub pos: Vec3,
    pub color: Vec3,  // RGB scalars
    pub intensity: f32,
    pub range: f32,
    pub enabled: bool,
}

/// Bake per-vertex colors in-place.
/// positions / normals: flat Vec<f32> (vertex_count * 3).
/// colors: flat Vec<f32> (vertex_count * 3) — overwritten.
pub fn bake_vertex_colors(
    positions: &[f32],
    normals: &[f32],
    colors: &mut [f32],
    lights: &[Light],
    bvh: &Bvh,
) {
    let vert_count = positions.len() / 3;
    for v in 0..vert_count {
        let vp = Vec3::new(positions[v*3], positions[v*3+1], positions[v*3+2]);
        let n = Vec3::new(normals[v*3], normals[v*3+1], normals[v*3+2]).normalize();

        let mut r = AMBIENT;
        let mut g = AMBIENT;
        let mut b = AMBIENT;

        for light in lights.iter() {
            if !light.enabled { continue; }
            let to_light = light.pos.sub(vp);
            let dist = to_light.length();
            if dist > light.range { continue; }
            let dir = to_light.scale(1.0 / dist);
            let n_dot_l = n.dot(dir).max(0.0);
            if n_dot_l <= 0.0 { continue; }

            let t = 1.0 - (dist / light.range);
            let attenuation = t * t;

            // Shadow ray — origin offset along normal to avoid self-hit
            let origin = vp.add(n.scale(SHADOW_BIAS));
            let ray_dist = dist - SHADOW_BIAS;
            if bvh.any_hit(origin, dir, SHADOW_BIAS, ray_dist) {
                continue;
            }

            let f = light.intensity * n_dot_l * attenuation;
            r += light.color.x * f;
            g += light.color.y * f;
            b += light.color.z * f;
        }

        colors[v*3]   = r.min(1.0);
        colors[v*3+1] = g.min(1.0);
        colors[v*3+2] = b.min(1.0);
    }
}

/// Compute per-triangle gradients from vertex colors (indexed mesh).
pub fn compute_tri_gradients(colors: &[f32], indices: &[u32]) -> Vec<f32> {
    let tri_count = indices.len() / 3;
    let mut out = vec![0.0f32; tri_count];
    let lum_of = |i: u32| {
        let k = i as usize * 3;
        0.299 * colors[k] + 0.587 * colors[k + 1] + 0.114 * colors[k + 2]
    };
    for t in 0..tri_count {
        let l0 = lum_of(indices[t * 3]);
        let l1 = lum_of(indices[t * 3 + 1]);
        let l2 = lum_of(indices[t * 3 + 2]);
        let d01 = (l0 - l1).abs();
        let d12 = (l1 - l2).abs();
        let d02 = (l0 - l2).abs();
        out[t] = d01.max(d12).max(d02);
    }
    out
}

pub fn select_levels(gradients: &[f32]) -> Vec<u32> {
    gradients.iter().map(|&g| {
        if g > 0.3 { 4 }
        else if g > 0.12 { 2 }
        else { 1 }
    }).collect()
}
