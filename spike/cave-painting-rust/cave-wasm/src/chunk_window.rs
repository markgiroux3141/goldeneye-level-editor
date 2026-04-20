use crate::chunk::{Chunk, CHUNK_SIZE};
use crate::clip::BoundaryClip;

// 8-chunk neighborhood starting at (cx,cy,cz). Indexing encodes +x/+y/+z bits
// so local coords in [0..CHUNK_SIZE] inclusive resolve to the right chunk.
//
// When `clip` is Some, corner reads apply the SDF-based boundary clip at the
// point's world coordinate; stored densities are never mutated.
pub struct ChunkWindow<'a> {
    pub chunks: [Option<&'a Chunk>; 8],
    pub default_density: f32,
    pub base_cx: i32,
    pub base_cy: i32,
    pub base_cz: i32,
    pub voxel_size: f32,
    pub clip: Option<&'a BoundaryClip>,
}

impl<'a> ChunkWindow<'a> {
    #[inline(always)]
    fn get_stored(&self, li: usize, lj: usize, lk: usize) -> f32 {
        let xi = (li >> 4) & 1;
        let yi = (lj >> 4) & 1;
        let zi = (lk >> 4) & 1;
        let idx = xi | (yi << 1) | (zi << 2);
        match self.chunks[idx] {
            Some(c) => {
                let x = li & 15;
                let y = lj & 15;
                let z = lk & 15;
                c.data[x + CHUNK_SIZE * (y + CHUNK_SIZE * z)]
            }
            None => self.default_density,
        }
    }

    #[inline(always)]
    pub fn get_corner(&self, li: usize, lj: usize, lk: usize) -> f32 {
        let stored = self.get_stored(li, lj, lk);
        match self.clip {
            None => stored,
            Some(clip) => {
                let cs = CHUNK_SIZE as i32;
                let wx = (self.base_cx * cs + li as i32) as f32 * self.voxel_size;
                let wy = (self.base_cy * cs + lj as i32) as f32 * self.voxel_size;
                let wz = (self.base_cz * cs + lk as i32) as f32 * self.voxel_size;
                clip.effective_density([wx, wy, wz], stored)
            }
        }
    }

    // True when the 8-chunk union straddles the iso surface (0.0). With a clip
    // active, the min/max short-circuit is only valid on chunks where the clip
    // is a no-op; otherwise we conservatively return true so meshing runs.
    pub fn intersects_iso(&self) -> bool {
        if let Some(clip) = self.clip {
            let cs = CHUNK_SIZE as i32;
            let chunk_min = [
                (self.base_cx * cs) as f32 * self.voxel_size,
                (self.base_cy * cs) as f32 * self.voxel_size,
                (self.base_cz * cs) as f32 * self.voxel_size,
            ];
            let chunk_max = [
                ((self.base_cx + 2) * cs) as f32 * self.voxel_size,
                ((self.base_cy + 2) * cs) as f32 * self.voxel_size,
                ((self.base_cz + 2) * cs) as f32 * self.voxel_size,
            ];
            if !clip.is_noop_on_aabb(chunk_min, chunk_max) {
                return true;
            }
        }

        let mut wmin = f32::INFINITY;
        let mut wmax = f32::NEG_INFINITY;
        for slot in &self.chunks {
            let (cmin, cmax) = match slot {
                Some(c) => (c.min, c.max),
                None => (self.default_density, self.default_density),
            };
            if cmin < wmin {
                wmin = cmin;
            }
            if cmax > wmax {
                wmax = cmax;
            }
        }
        wmin < 0.0 && wmax >= 0.0
    }
}
