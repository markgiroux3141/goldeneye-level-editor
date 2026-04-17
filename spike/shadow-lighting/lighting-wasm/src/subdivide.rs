// Triangle-native parametric subdivision with per-triangle level.
// Each parent tri with level N → N² sub-triangles via barycentric grid.
// Output is unindexed (sub-verts are unique per parent tri).

use crate::math::Vec3;

pub struct SubdivResult {
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub colors: Vec<f32>,
    pub indices: Vec<u32>,
}

fn get_vert(positions: &[f32], idx: u32) -> Vec3 {
    let i = idx as usize * 3;
    Vec3::new(positions[i], positions[i + 1], positions[i + 2])
}

fn face_normal(a: Vec3, b: Vec3, c: Vec3) -> Vec3 {
    b.sub(a).cross(c.sub(a)).normalize()
}

/// Subdivide each triangle by its own level. `levels.len() == indices.len() / 3`.
/// Produces a new unindexed triangle mesh with flat face normals.
pub fn subdivide_triangles(positions: &[f32], indices: &[u32], levels: &[u32]) -> SubdivResult {
    let tri_count = indices.len() / 3;
    assert_eq!(levels.len(), tri_count);

    // Pre-count outputs
    let mut total_sub_tris: usize = 0;
    for &n in levels.iter() {
        let n = n.max(1) as usize;
        total_sub_tris += n * n;
    }
    let total_verts = total_sub_tris * 3;

    let mut out_pos = Vec::with_capacity(total_verts * 3);
    let mut out_nor = Vec::with_capacity(total_verts * 3);
    let mut out_idx = Vec::with_capacity(total_verts);
    let mut out_col = vec![1.0f32; total_verts * 3];

    let mut next_idx: u32 = 0;

    for t in 0..tri_count {
        let n = levels[t].max(1);
        let ia = indices[t * 3];
        let ib = indices[t * 3 + 1];
        let ic = indices[t * 3 + 2];
        let a = get_vert(positions, ia);
        let b = get_vert(positions, ib);
        let c = get_vert(positions, ic);
        let normal = face_normal(a, b, c);

        let nf = n as f32;

        // Helper: compute vertex position at barycentric (i/N, j/N).
        // Using A=(0,0), B=(1,0) in grid space; u=i, v=j, w=N-i-j.
        let vert_at = |i: u32, j: u32| -> Vec3 {
            let u = i as f32 / nf;
            let v = j as f32 / nf;
            let w = 1.0 - u - v;
            // Position = w*A + u*B + v*C
            Vec3::new(
                w * a.x + u * b.x + v * c.x,
                w * a.y + u * b.y + v * c.y,
                w * a.z + u * b.z + v * c.z,
            )
        };

        let push_tri = |p0: Vec3, p1: Vec3, p2: Vec3,
                        out_pos: &mut Vec<f32>, out_nor: &mut Vec<f32>,
                        out_idx: &mut Vec<u32>, next: &mut u32| {
            for p in [p0, p1, p2] {
                out_pos.push(p.x); out_pos.push(p.y); out_pos.push(p.z);
                out_nor.push(normal.x); out_nor.push(normal.y); out_nor.push(normal.z);
                out_idx.push(*next);
                *next += 1;
            }
        };

        // Emit N² sub-triangles via barycentric grid.
        for j in 0..n {
            for i in 0..(n - j) {
                // "Up" triangle
                let v0 = vert_at(i, j);
                let v1 = vert_at(i + 1, j);
                let v2 = vert_at(i, j + 1);
                push_tri(v0, v1, v2, &mut out_pos, &mut out_nor, &mut out_idx, &mut next_idx);
            }
            if n > j + 1 {
                for i in 0..(n - j - 1) {
                    // "Down" triangle
                    let v0 = vert_at(i + 1, j);
                    let v1 = vert_at(i + 1, j + 1);
                    let v2 = vert_at(i, j + 1);
                    push_tri(v0, v1, v2, &mut out_pos, &mut out_nor, &mut out_idx, &mut next_idx);
                }
            }
        }
    }

    SubdivResult { positions: out_pos, normals: out_nor, colors: out_col, indices: out_idx }
}
