use crate::chunk::{Chunk, CHUNK_SIZE};
use crate::chunk_window::ChunkWindow;
use crate::noise::fbm3d;
use hashbrown::{HashMap, HashSet};

// Packed chunk key: 21 bits per axis (range ~[-1M, +1M]). Plenty for the editor.
const KEY_BITS: u32 = 21;
const KEY_MASK: i64 = (1 << KEY_BITS) - 1;

#[inline(always)]
pub fn pack_key(cx: i32, cy: i32, cz: i32) -> i64 {
    let x = (cx as i64) & KEY_MASK;
    let y = (cy as i64) & KEY_MASK;
    let z = (cz as i64) & KEY_MASK;
    (x << (KEY_BITS * 2)) | (y << KEY_BITS) | z
}

pub struct World {
    pub chunks: HashMap<i64, Box<Chunk>>,
    pub dirty: HashSet<i64>,
    pub voxel_size: f32,
    pub default_density: f32,
}

impl World {
    pub fn new(voxel_size: f32, default_density: f32) -> Self {
        World {
            chunks: HashMap::with_capacity(512),
            dirty: HashSet::with_capacity(128),
            voxel_size,
            default_density,
        }
    }

    pub fn get_or_create_chunk_mut(&mut self, cx: i32, cy: i32, cz: i32) -> &mut Chunk {
        let key = pack_key(cx, cy, cz);
        let default = self.default_density;
        self.chunks
            .entry(key)
            .or_insert_with(|| Box::new(Chunk::new_filled(default)))
    }

    pub fn get_chunk(&self, cx: i32, cy: i32, cz: i32) -> Option<&Chunk> {
        self.chunks.get(&pack_key(cx, cy, cz)).map(|b| b.as_ref())
    }

    pub fn get_corner(&self, i: i32, j: i32, k: i32) -> f32 {
        let cs = CHUNK_SIZE as i32;
        let cx = i.div_euclid(cs);
        let cy = j.div_euclid(cs);
        let cz = k.div_euclid(cs);
        match self.get_chunk(cx, cy, cz) {
            Some(c) => {
                let li = i.rem_euclid(cs) as usize;
                let lj = j.rem_euclid(cs) as usize;
                let lk = k.rem_euclid(cs) as usize;
                c.data[Chunk::idx(li, lj, lk)]
            }
            None => self.default_density,
        }
    }

    pub fn build_window(&self, cx: i32, cy: i32, cz: i32) -> ChunkWindow<'_> {
        ChunkWindow {
            chunks: [
                self.get_chunk(cx    , cy    , cz    ),
                self.get_chunk(cx + 1, cy    , cz    ),
                self.get_chunk(cx    , cy + 1, cz    ),
                self.get_chunk(cx + 1, cy + 1, cz    ),
                self.get_chunk(cx    , cy    , cz + 1),
                self.get_chunk(cx + 1, cy    , cz + 1),
                self.get_chunk(cx    , cy + 1, cz + 1),
                self.get_chunk(cx + 1, cy + 1, cz + 1),
            ],
            default_density: self.default_density,
        }
    }

    // Mark all chunks intersecting the world AABB dirty, with the -1 low-side pad
    // (chunk N's corner[16] is chunk N+1's corner[0], so modifying that corner
    // invalidates chunk N's mesh too).
    pub fn mark_dirty_aabb(
        &mut self,
        min_x: f32, min_y: f32, min_z: f32,
        max_x: f32, max_y: f32, max_z: f32,
    ) {
        let vs = self.voxel_size;
        let bs = CHUNK_SIZE as i32;
        let i_min = (min_x / vs).floor() as i32;
        let i_max = (max_x / vs).ceil()  as i32;
        let j_min = (min_y / vs).floor() as i32;
        let j_max = (max_y / vs).ceil()  as i32;
        let k_min = (min_z / vs).floor() as i32;
        let k_max = (max_z / vs).ceil()  as i32;

        let cx_lo = i_min.div_euclid(bs) - 1;
        let cy_lo = j_min.div_euclid(bs) - 1;
        let cz_lo = k_min.div_euclid(bs) - 1;
        let cx_hi = i_max.div_euclid(bs);
        let cy_hi = j_max.div_euclid(bs);
        let cz_hi = k_max.div_euclid(bs);

        for cz in cz_lo..=cz_hi {
            for cy in cy_lo..=cy_hi {
                for cx in cx_lo..=cx_hi {
                    self.dirty.insert(pack_key(cx, cy, cz));
                }
            }
        }
    }

    pub fn drain_dirty(&mut self, out: &mut Vec<i32>) {
        out.clear();
        out.reserve(self.dirty.len() * 3);
        for &key in self.dirty.iter() {
            let x = ((key >> (KEY_BITS * 2)) & KEY_MASK) as i32;
            let y = ((key >> KEY_BITS) & KEY_MASK) as i32;
            let z = (key & KEY_MASK) as i32;
            let sign_bit = 1i32 << (KEY_BITS - 1);
            let mask = sign_bit - 1;
            let cx = if x & sign_bit != 0 { (x & mask) - sign_bit } else { x };
            let cy = if y & sign_bit != 0 { (y & mask) - sign_bit } else { y };
            let cz = if z & sign_bit != 0 { (z & mask) - sign_bit } else { z };
            out.push(cx);
            out.push(cy);
            out.push(cz);
        }
        self.dirty.clear();
    }

    // Carve a noisy spherical cavity. Ports densityField.js:initHollowCavity.
    // Sparse: skips chunks guaranteed to stay default-solid.
    pub fn init_hollow_cavity(
        &mut self,
        ccx: f32, ccy: f32, ccz: f32,
        radius: f32, noise_amp: f32, noise_freq: f32,
    ) {
        let vs = self.voxel_size;
        let bs = CHUNK_SIZE as i32;
        let margin = radius + noise_amp + 1.0;

        let cx_lo = (((ccx - margin) / vs).floor() as i32).div_euclid(bs);
        let cy_lo = (((ccy - margin) / vs).floor() as i32).div_euclid(bs);
        let cz_lo = (((ccz - margin) / vs).floor() as i32).div_euclid(bs);
        let cx_hi = (((ccx + margin) / vs).floor() as i32).div_euclid(bs);
        let cy_hi = (((ccy + margin) / vs).floor() as i32).div_euclid(bs);
        let cz_hi = (((ccz + margin) / vs).floor() as i32).div_euclid(bs);

        let chunk_world = (bs as f32) * vs;
        let chunk_diag = chunk_world * (3.0_f32).sqrt() * 0.5;
        let skip_dist = radius + noise_amp + chunk_diag;
        let skip_dist_sq = skip_dist * skip_dist;

        for cz in cz_lo..=cz_hi {
            for cy in cy_lo..=cy_hi {
                for cx in cx_lo..=cx_hi {
                    // Sparse early-bail: chunks whose center is far outside the
                    // noisy shell are guaranteed all-solid — skip allocation.
                    let ccwx = (cx as f32 * bs as f32 + bs as f32 * 0.5) * vs;
                    let ccwy = (cy as f32 * bs as f32 + bs as f32 * 0.5) * vs;
                    let ccwz = (cz as f32 * bs as f32 + bs as f32 * 0.5) * vs;
                    let dx = ccwx - ccx;
                    let dy = ccwy - ccy;
                    let dz = ccwz - ccz;
                    let d2 = dx * dx + dy * dy + dz * dz;
                    if d2 > skip_dist_sq {
                        continue;
                    }

                    let chunk = self.get_or_create_chunk_mut(cx, cy, cz);
                    let mut lo = f32::INFINITY;
                    let mut hi = f32::NEG_INFINITY;
                    for lk in 0..CHUNK_SIZE {
                        let wz = (cz * bs + lk as i32) as f32 * vs;
                        let dz = wz - ccz;
                        for lj in 0..CHUNK_SIZE {
                            let wy = (cy * bs + lj as i32) as f32 * vs;
                            let dy = wy - ccy;
                            for li in 0..CHUNK_SIZE {
                                let wx = (cx * bs + li as i32) as f32 * vs;
                                let dx = wx - ccx;
                                let d = (dx * dx + dy * dy + dz * dz).sqrt();
                                let disp = fbm3d(
                                    wx * noise_freq,
                                    wy * noise_freq,
                                    wz * noise_freq,
                                    4,
                                ) * noise_amp;
                                let v = d - (radius + disp);
                                chunk.data[Chunk::idx(li, lj, lk)] = v;
                                if v < lo { lo = v; }
                                if v > hi { hi = v; }
                            }
                        }
                    }
                    chunk.min = lo;
                    chunk.max = hi;
                    chunk.dirty_cache = false;
                    self.dirty.insert(pack_key(cx, cy, cz));
                }
            }
        }
        // Low-side neighbors so seams update too.
        for cz in (cz_lo - 1)..=cz_hi {
            for cy in (cy_lo - 1)..=cy_hi {
                for cx in (cx_lo - 1)..=cx_hi {
                    self.dirty.insert(pack_key(cx, cy, cz));
                }
            }
        }
    }
}
