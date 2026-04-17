// Coplanar edge-flip to Delaunay. Works on an indexed triangle mesh.
// Only flips edges shared by two triangles whose face normals agree (coplanar),
// and only when the diagonal is non-Delaunay by the angle-sum criterion.

use std::collections::HashMap;

use crate::math::Vec3;

const COPLANAR_EPS: f32 = 1e-4;
const ANGLE_EPS: f32 = 1e-3;
const MAX_PASSES: usize = 5;

fn get_vert(positions: &[f32], idx: u32) -> Vec3 {
    let i = idx as usize * 3;
    Vec3::new(positions[i], positions[i + 1], positions[i + 2])
}

fn face_normal(positions: &[f32], tri: &[u32; 3]) -> Vec3 {
    let a = get_vert(positions, tri[0]);
    let b = get_vert(positions, tri[1]);
    let c = get_vert(positions, tri[2]);
    b.sub(a).cross(c.sub(a)).normalize()
}

fn opposite_vertex(tri: &[u32; 3], a: u32, b: u32) -> u32 {
    for &v in tri.iter() {
        if v != a && v != b { return v; }
    }
    tri[0]
}

/// Angle at vertex `apex` in the triangle formed with the other two edge endpoints.
fn angle_at(apex: Vec3, p: Vec3, q: Vec3) -> f32 {
    let d1 = p.sub(apex);
    let d2 = q.sub(apex);
    let l1 = d1.length().max(1e-12);
    let l2 = d2.length().max(1e-12);
    let c = (d1.dot(d2) / (l1 * l2)).clamp(-1.0, 1.0);
    c.acos()
}

fn build_edge_map(indices: &[u32]) -> HashMap<(u32, u32), Vec<usize>> {
    let mut map: HashMap<(u32, u32), Vec<usize>> = HashMap::new();
    let tri_count = indices.len() / 3;
    for t in 0..tri_count {
        let a = indices[t * 3];
        let b = indices[t * 3 + 1];
        let c = indices[t * 3 + 2];
        for (x, y) in [(a, b), (b, c), (c, a)].iter().copied() {
            let key = if x < y { (x, y) } else { (y, x) };
            map.entry(key).or_default().push(t);
        }
    }
    map
}

fn read_tri(indices: &[u32], t: usize) -> [u32; 3] {
    [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]]
}

fn write_tri(indices: &mut [u32], t: usize, tri: [u32; 3]) {
    indices[t * 3] = tri[0];
    indices[t * 3 + 1] = tri[1];
    indices[t * 3 + 2] = tri[2];
}

/// Given the four verts of a quad (edge a-b shared, opposites o1 in tri1, o2 in tri2),
/// produce the two new triangles that share diagonal o1-o2 instead, preserving
/// the original face normals.
fn flipped_triangles(
    positions: &[f32],
    orig1: [u32; 3],
    orig2: [u32; 3],
    a: u32,
    b: u32,
    o1: u32,
    o2: u32,
) -> ([u32; 3], [u32; 3]) {
    let n1_orig = face_normal(positions, &orig1);
    let n2_orig = face_normal(positions, &orig2);

    // Candidate tri replacing orig1: {a, o1, o2} in either winding. Pick one
    // whose normal matches n1_orig.
    let cand1 = [[a, o1, o2], [a, o2, o1]];
    let new1 = if face_normal(positions, &cand1[0]).dot(n1_orig) >= 0.0 { cand1[0] } else { cand1[1] };

    // Candidate tri replacing orig2: {b, o1, o2} in either winding.
    let cand2 = [[b, o2, o1], [b, o1, o2]];
    let new2 = if face_normal(positions, &cand2[0]).dot(n2_orig) >= 0.0 { cand2[0] } else { cand2[1] };

    (new1, new2)
}

pub fn flip_to_delaunay(positions: &[f32], mut indices: Vec<u32>) -> Vec<u32> {
    for _pass in 0..MAX_PASSES {
        let edge_map = build_edge_map(&indices);
        let mut flipped = false;

        // Snapshot keys so we can mutate indices while iterating.
        let keys: Vec<(u32, u32)> = edge_map.keys().copied().collect();

        for key in keys {
            let tris = match edge_map.get(&key) {
                Some(v) if v.len() == 2 => v.clone(),
                _ => continue,
            };
            let t1_idx = tris[0];
            let t2_idx = tris[1];
            let tri1 = read_tri(&indices, t1_idx);
            let tri2 = read_tri(&indices, t2_idx);

            let (a, b) = key;

            // Still present? Another flip may have moved vertices out of this edge.
            let still1 = tri1.contains(&a) && tri1.contains(&b);
            let still2 = tri2.contains(&a) && tri2.contains(&b);
            if !(still1 && still2) { continue; }

            // Coplanarity
            let n1 = face_normal(positions, &tri1);
            let n2 = face_normal(positions, &tri2);
            if (n1.dot(n2) - 1.0).abs() > COPLANAR_EPS { continue; }

            // Opposites
            let o1 = opposite_vertex(&tri1, a, b);
            let o2 = opposite_vertex(&tri2, a, b);
            if o1 == o2 { continue; }

            // Delaunay angle-sum criterion: if the two angles opposite the shared
            // edge sum to more than π, the diagonal is non-Delaunay → flip.
            let ang1 = angle_at(get_vert(positions, o1), get_vert(positions, a), get_vert(positions, b));
            let ang2 = angle_at(get_vert(positions, o2), get_vert(positions, a), get_vert(positions, b));
            if ang1 + ang2 <= std::f32::consts::PI + ANGLE_EPS { continue; }

            // Also require that the flip doesn't create a degenerate tri
            // (collinear o1-o2 with a or b).
            let ang_new1 = angle_at(get_vert(positions, a), get_vert(positions, o1), get_vert(positions, o2));
            let ang_new2 = angle_at(get_vert(positions, b), get_vert(positions, o1), get_vert(positions, o2));
            if ang_new1 < ANGLE_EPS || ang_new2 < ANGLE_EPS { continue; }

            let (new1, new2) = flipped_triangles(positions, tri1, tri2, a, b, o1, o2);
            write_tri(&mut indices, t1_idx, new1);
            write_tri(&mut indices, t2_idx, new2);
            flipped = true;
        }

        if !flipped { break; }
    }

    indices
}
