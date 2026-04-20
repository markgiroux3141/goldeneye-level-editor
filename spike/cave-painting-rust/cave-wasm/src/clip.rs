// SDF-based boundary clip applied to stored cave densities at mesh read time.
//
// Density convention matches the rest of the crate: positive = solid,
// 0 = iso-surface, negative = air.
//
// Composition (per-point p, given `stored`):
//
//   d = stored
//   for s in subtracts:
//       d = min(d, sdf_box(p, s))        # carved air inside any subtract
//   if p is outside every subtract:
//       d = max(d, sdf_box(p, envelope)) # force solid outside envelope
//
// Skipping the envelope clamp when p is inside a subtract is what prevents a
// flat disc from forming at the envelope wall where a hallway punches through:
// the subtract keeps d < 0 on both sides of the wall, so no iso-crossing.
// Points outside the envelope AND inside a subtract could go negative (air)
// by this rule, but we never mesh chunks that don't overlap the envelope AABB,
// so that geometry is never generated.

pub struct BoundaryClip {
    pub envelope_min: [f32; 3],
    pub envelope_max: [f32; 3],
    // Each entry is (min, max) of a subtract-op brush AABB in the region.
    pub subtracts: Vec<([f32; 3], [f32; 3])>,
}

impl BoundaryClip {
    /// Signed distance to an axis-aligned box: positive outside, 0 on surface,
    /// negative inside (depth to nearest face, negated).
    #[inline(always)]
    pub fn sdf_box(p: [f32; 3], bmin: [f32; 3], bmax: [f32; 3]) -> f32 {
        let qx = (bmin[0] - p[0]).max(p[0] - bmax[0]);
        let qy = (bmin[1] - p[1]).max(p[1] - bmax[1]);
        let qz = (bmin[2] - p[2]).max(p[2] - bmax[2]);
        let ox = qx.max(0.0);
        let oy = qy.max(0.0);
        let oz = qz.max(0.0);
        let outside = (ox * ox + oy * oy + oz * oz).sqrt();
        let inside = qx.max(qy).max(qz).min(0.0);
        outside + inside
    }

    #[inline]
    pub fn effective_density(&self, p: [f32; 3], stored: f32) -> f32 {
        let mut d = stored;
        let mut inside_any_sub = false;
        for (smin, smax) in &self.subtracts {
            let s = Self::sdf_box(p, *smin, *smax);
            if s < 0.0 {
                inside_any_sub = true;
            }
            if s < d {
                d = s;
            }
        }
        if !inside_any_sub {
            let e = Self::sdf_box(p, self.envelope_min, self.envelope_max);
            if e > d {
                d = e;
            }
        }
        d
    }

    /// True when the clip is effectively a no-op on a chunk whose world-AABB
    /// lies entirely inside the envelope AND doesn't overlap any subtract.
    /// Lets meshing retain the min/max early-bail on interior chunks.
    pub fn is_noop_on_aabb(&self, chunk_min: [f32; 3], chunk_max: [f32; 3]) -> bool {
        let inside_env = chunk_min[0] >= self.envelope_min[0]
            && chunk_max[0] <= self.envelope_max[0]
            && chunk_min[1] >= self.envelope_min[1]
            && chunk_max[1] <= self.envelope_max[1]
            && chunk_min[2] >= self.envelope_min[2]
            && chunk_max[2] <= self.envelope_max[2];
        if !inside_env {
            return false;
        }
        for (smin, smax) in &self.subtracts {
            let overlaps = chunk_max[0] > smin[0]
                && chunk_min[0] < smax[0]
                && chunk_max[1] > smin[1]
                && chunk_min[1] < smax[1]
                && chunk_max[2] > smin[2]
                && chunk_min[2] < smax[2];
            if overlaps {
                return false;
            }
        }
        true
    }
}
