// Simple BVH over triangles with median-split build + Möller-Trumbore intersection.

use crate::math::{Aabb, Triangle, Vec3};

const LEAF_MAX_TRIS: usize = 4;

pub struct BvhNode {
    pub bounds: Aabb,
    // If leaf: start/count index into `tris`. If inner: left = child index, right = child index.
    pub left: i32,
    pub right: i32,
    pub start: u32,
    pub count: u32,
}

pub struct Bvh {
    pub nodes: Vec<BvhNode>,
    pub tris: Vec<Triangle>,
}

impl Bvh {
    pub fn build(mut tris: Vec<Triangle>) -> Bvh {
        let mut nodes: Vec<BvhNode> = Vec::new();
        if tris.is_empty() {
            nodes.push(BvhNode {
                bounds: Aabb::empty(), left: -1, right: -1, start: 0, count: 0,
            });
            return Bvh { nodes, tris };
        }
        build_recursive(&mut tris, 0, 0, &mut nodes);
        Bvh { nodes, tris }
    }

    /// Returns true if a ray from `origin` in direction `dir` hits any triangle
    /// with `tmin < t < tmax`.
    pub fn any_hit(&self, origin: Vec3, dir: Vec3, tmin: f32, tmax: f32) -> bool {
        if self.nodes.is_empty() { return false; }
        let inv_dir = Vec3::new(
            if dir.x.abs() > 1e-20 { 1.0 / dir.x } else { f32::INFINITY },
            if dir.y.abs() > 1e-20 { 1.0 / dir.y } else { f32::INFINITY },
            if dir.z.abs() > 1e-20 { 1.0 / dir.z } else { f32::INFINITY },
        );
        let mut stack: [i32; 64] = [0; 64];
        let mut sp: usize = 0;
        stack[sp] = 0; sp += 1;
        while sp > 0 {
            sp -= 1;
            let idx = stack[sp] as usize;
            let node = &self.nodes[idx];
            if !node.bounds.ray_hit(origin, inv_dir, tmax) { continue; }
            if node.left < 0 {
                // leaf
                let start = node.start as usize;
                let end = start + node.count as usize;
                for i in start..end {
                    if let Some(t) = intersect_triangle(origin, dir, &self.tris[i]) {
                        if t > tmin && t < tmax { return true; }
                    }
                }
            } else {
                if sp + 2 <= stack.len() {
                    stack[sp] = node.left; sp += 1;
                    stack[sp] = node.right; sp += 1;
                }
            }
        }
        false
    }
}

fn build_recursive(tris: &mut [Triangle], start: u32, depth: u32, nodes: &mut Vec<BvhNode>) -> i32 {
    let node_idx = nodes.len();
    // Reserve slot
    nodes.push(BvhNode { bounds: Aabb::empty(), left: -1, right: -1, start: 0, count: 0 });

    let count = tris.len();
    // Compute bounds
    let mut bounds = Aabb::empty();
    for t in tris.iter() { bounds = bounds.union(t.aabb()); }

    if count <= LEAF_MAX_TRIS || depth > 40 {
        nodes[node_idx] = BvhNode {
            bounds, left: -1, right: -1, start, count: count as u32,
        };
        return node_idx as i32;
    }

    // Median split along longest axis by centroid
    let axis = bounds.longest_axis();
    tris.sort_by(|a, b| {
        let ac = a.centroid().axis(axis);
        let bc = b.centroid().axis(axis);
        ac.partial_cmp(&bc).unwrap_or(std::cmp::Ordering::Equal)
    });
    let mid = count / 2;
    if mid == 0 || mid == count {
        // Degenerate split — make leaf
        nodes[node_idx] = BvhNode {
            bounds, left: -1, right: -1, start, count: count as u32,
        };
        return node_idx as i32;
    }

    let (left_slice, right_slice) = tris.split_at_mut(mid);
    let left_idx = build_recursive(left_slice, start, depth + 1, nodes);
    let right_idx = build_recursive(right_slice, start + mid as u32, depth + 1, nodes);

    nodes[node_idx] = BvhNode {
        bounds,
        left: left_idx,
        right: right_idx,
        start: 0,
        count: 0,
    };
    node_idx as i32
}

/// Möller-Trumbore ray/triangle intersection. Returns t if hit, else None.
fn intersect_triangle(origin: Vec3, dir: Vec3, tri: &Triangle) -> Option<f32> {
    const EPS: f32 = 1e-7;
    let e1 = tri.b.sub(tri.a);
    let e2 = tri.c.sub(tri.a);
    let p = dir.cross(e2);
    let det = e1.dot(p);
    if det.abs() < EPS { return None; }
    let inv_det = 1.0 / det;
    let s = origin.sub(tri.a);
    let u = s.dot(p) * inv_det;
    if u < 0.0 || u > 1.0 { return None; }
    let q = s.cross(e1);
    let v = dir.dot(q) * inv_det;
    if v < 0.0 || u + v > 1.0 { return None; }
    let t = e2.dot(q) * inv_det;
    if t > EPS { Some(t) } else { None }
}
