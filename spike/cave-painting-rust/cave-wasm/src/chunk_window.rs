use crate::chunk::{Chunk, CHUNK_SIZE};

// 8-chunk neighborhood starting at (cx,cy,cz). Indexing encodes +x/+y/+z bits
// so local coords in [0..CHUNK_SIZE] inclusive resolve to the right chunk.
pub struct ChunkWindow<'a> {
    pub chunks: [Option<&'a Chunk>; 8],
    pub default_density: f32,
}

impl<'a> ChunkWindow<'a> {
    #[inline(always)]
    pub fn get_corner(&self, li: usize, lj: usize, lk: usize) -> f32 {
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

    // True when the 8-chunk union straddles the iso surface (0.0).
    // Lets meshChunk bail out when the whole window is entirely solid or entirely air.
    pub fn intersects_iso(&self) -> bool {
        let mut wmin = f32::INFINITY;
        let mut wmax = f32::NEG_INFINITY;
        for slot in &self.chunks {
            let (cmin, cmax) = match slot {
                Some(c) => (c.min, c.max),
                None => (self.default_density, self.default_density),
            };
            if cmin < wmin { wmin = cmin; }
            if cmax > wmax { wmax = cmax; }
        }
        wmin < 0.0 && wmax >= 0.0
    }
}
