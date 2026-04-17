// Shadow stencil: project occluder AABB corners through lights onto each receiver
// face, then cut the mesh at axis-aligned shadow edges. Triangle-native.

use crate::bake::Light;
use crate::math::Vec3;

pub struct Aabb3 {
    pub min: [f32; 3],
    pub max: [f32; 3],
}

pub struct Cut {
    pub axis: usize,  // 0=x, 1=y, 2=z
    pub value: f32,
}

fn box_corners(a: &Aabb3) -> [[f32; 3]; 8] {
    let [x0, y0, z0] = a.min;
    let [x1, y1, z1] = a.max;
    [
        [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
        [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1],
    ]
}

fn project_point(light: &[f32; 3], point: &[f32; 3], n: &[f32; 3], pp: &[f32; 3]) -> Option<[f32; 3]> {
    let dx = point[0] - light[0];
    let dy = point[1] - light[1];
    let dz = point[2] - light[2];
    let denom = n[0] * dx + n[1] * dy + n[2] * dz;
    if denom.abs() < 1e-8 { return None; }
    let ex = pp[0] - light[0];
    let ey = pp[1] - light[1];
    let ez = pp[2] - light[2];
    let t = (n[0] * ex + n[1] * ey + n[2] * ez) / denom;
    if t < 0.5 { return None; }
    Some([light[0] + dx * t, light[1] + dy * t, light[2] + dz * t])
}

pub struct FaceInfo {
    pub normal: [f32; 3],
    pub point: [f32; 3],
    pub bounds: Aabb3,
}

/// Per-triangle face info: normal from cross of two edges, point = first vertex,
/// bounds = AABB of the 3 vertices.
pub fn face_info_for_tri(positions: &[f32], indices: &[u32], t: usize) -> FaceInfo {
    let ia = indices[t * 3] as usize;
    let ib = indices[t * 3 + 1] as usize;
    let ic = indices[t * 3 + 2] as usize;
    let ax = positions[ia * 3]; let ay = positions[ia * 3 + 1]; let az = positions[ia * 3 + 2];
    let bx = positions[ib * 3]; let by = positions[ib * 3 + 1]; let bz = positions[ib * 3 + 2];
    let cx = positions[ic * 3]; let cy = positions[ic * 3 + 1]; let cz = positions[ic * 3 + 2];

    let e1 = [bx - ax, by - ay, bz - az];
    let e2 = [cx - ax, cy - ay, cz - az];
    let mut nx = e1[1] * e2[2] - e1[2] * e2[1];
    let mut ny = e1[2] * e2[0] - e1[0] * e2[2];
    let mut nz = e1[0] * e2[1] - e1[1] * e2[0];
    let len = (nx * nx + ny * ny + nz * nz).sqrt().max(1e-12);
    nx /= len; ny /= len; nz /= len;

    let mn = [ax.min(bx).min(cx), ay.min(by).min(cy), az.min(bz).min(cz)];
    let mx = [ax.max(bx).max(cx), ay.max(by).max(cy), az.max(bz).max(cz)];

    FaceInfo { normal: [nx, ny, nz], point: [ax, ay, az], bounds: Aabb3 { min: mn, max: mx } }
}

pub fn compute_shadow_cuts(
    lights: &[Light],
    occluders: &[Aabb3],
    face: &FaceInfo,
    penumbra_width: f32,
) -> Vec<Cut> {
    let mut cuts: Vec<Cut> = Vec::new();

    let abs_n = [face.normal[0].abs(), face.normal[1].abs(), face.normal[2].abs()];
    let dom = if abs_n[0] > abs_n[1] && abs_n[0] > abs_n[2] { 0 }
              else if abs_n[1] > abs_n[2] { 1 } else { 2 };
    let in_plane_axes: [usize; 2] = match dom {
        0 => [1, 2],
        1 => [0, 2],
        _ => [0, 1],
    };

    for light in lights.iter() {
        if !light.enabled { continue; }
        let lp = [light.pos.x, light.pos.y, light.pos.z];

        for aabb in occluders.iter() {
            let corners = box_corners(aabb);
            let mut projected: Vec<[f32; 3]> = Vec::with_capacity(8);
            for c in corners.iter() {
                if let Some(p) = project_point(&lp, c, &face.normal, &face.point) {
                    projected.push(p);
                }
            }
            if projected.len() < 2 { continue; }

            for &a in in_plane_axes.iter() {
                let b_min = face.bounds.min[a];
                let b_max = face.bounds.max[a];
                if !(b_max > b_min) { continue; }

                let mut p_min = f32::INFINITY;
                let mut p_max = f32::NEG_INFINITY;
                for p in projected.iter() {
                    if p[a] < p_min { p_min = p[a]; }
                    if p[a] > p_max { p_max = p[a]; }
                }
                let occ_min = aabb.min[a];
                let occ_max = aabb.max[a];
                let candidates = [occ_min, occ_max, p_min, p_max];

                for &val in candidates.iter() {
                    if val <= b_min + 0.05 || val >= b_max - 0.05 { continue; }
                    let exists = cuts.iter().any(|c| c.axis == a && (c.value - val).abs() < 0.1);
                    if exists { continue; }
                    cuts.push(Cut { axis: a, value: val });

                    if penumbra_width > 0.0 {
                        let lo = val - penumbra_width;
                        if lo > b_min + 0.05 {
                            let e = cuts.iter().any(|c| c.axis == a && (c.value - lo).abs() < 0.1);
                            if !e { cuts.push(Cut { axis: a, value: lo }); }
                        }
                        let hi = val + penumbra_width;
                        if hi < b_max - 0.05 {
                            let e = cuts.iter().any(|c| c.axis == a && (c.value - hi).abs() < 0.1);
                            if !e { cuts.push(Cut { axis: a, value: hi }); }
                        }
                    }
                }
            }
        }
    }

    cuts
}

/// A triangle with three Vec3 vertices.
#[derive(Clone, Copy)]
pub struct Tri { pub a: Vec3, pub b: Vec3, pub c: Vec3 }

fn axis_val(v: Vec3, a: usize) -> f32 {
    match a { 0 => v.x, 1 => v.y, _ => v.z }
}

fn lerp_axis(a: Vec3, b: Vec3, axis: usize, val: f32) -> Vec3 {
    let av = axis_val(a, axis);
    let bv = axis_val(b, axis);
    let t = (val - av) / (bv - av);
    Vec3::new(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t)
}

pub fn split_tris_at_axis(tris: &[Tri], axis: usize, val: f32) -> Vec<Tri> {
    let mut result: Vec<Tri> = Vec::with_capacity(tris.len());
    for tri in tris.iter() {
        let verts = [tri.a, tri.b, tri.c];
        let vals = [axis_val(verts[0], axis), axis_val(verts[1], axis), axis_val(verts[2], axis)];
        let min_v = vals[0].min(vals[1]).min(vals[2]);
        let max_v = vals[0].max(vals[1]).max(vals[2]);

        if max_v <= val + 1e-6 || min_v >= val - 1e-6 {
            result.push(*tri);
            continue;
        }

        let mut sorted = [(verts[0], vals[0]), (verts[1], vals[1]), (verts[2], vals[2])];
        sorted.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        let lo = sorted[0].0;
        let mid = sorted[1].0;
        let hi = sorted[2].0;
        let mid_val = sorted[1].1;
        let p_lo_hi = lerp_axis(lo, hi, axis, val);

        if mid_val <= val {
            let p_mid_hi = lerp_axis(mid, hi, axis, val);
            result.push(Tri { a: lo, b: mid, c: p_lo_hi });
            result.push(Tri { a: mid, b: p_mid_hi, c: p_lo_hi });
            result.push(Tri { a: p_lo_hi, b: p_mid_hi, c: hi });
        } else {
            let p_lo_mid = lerp_axis(lo, mid, axis, val);
            result.push(Tri { a: lo, b: p_lo_mid, c: p_lo_hi });
            result.push(Tri { a: p_lo_mid, b: mid, c: p_lo_hi });
            result.push(Tri { a: mid, b: hi, c: p_lo_hi });
        }
    }
    result
}

pub fn tri_from_indices(positions: &[f32], indices: &[u32], t: usize) -> Tri {
    let ia = indices[t * 3] as usize;
    let ib = indices[t * 3 + 1] as usize;
    let ic = indices[t * 3 + 2] as usize;
    Tri {
        a: Vec3::new(positions[ia * 3], positions[ia * 3 + 1], positions[ia * 3 + 2]),
        b: Vec3::new(positions[ib * 3], positions[ib * 3 + 1], positions[ib * 3 + 2]),
        c: Vec3::new(positions[ic * 3], positions[ic * 3 + 1], positions[ic * 3 + 2]),
    }
}
