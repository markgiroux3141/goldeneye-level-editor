pub const CHUNK_SIZE: usize = 16;
pub const CHUNK_VOL: usize = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE;

pub struct Chunk {
    pub data: Box<[f32; CHUNK_VOL]>,
    pub min: f32,
    pub max: f32,
    pub dirty_cache: bool,
}

impl Chunk {
    pub fn new_filled(default: f32) -> Self {
        Chunk {
            data: Box::new([default; CHUNK_VOL]),
            min: default,
            max: default,
            dirty_cache: false,
        }
    }

    #[inline(always)]
    pub fn idx(li: usize, lj: usize, lk: usize) -> usize {
        li + CHUNK_SIZE * (lj + CHUNK_SIZE * lk)
    }

    pub fn refresh_min_max(&mut self) {
        let mut lo = f32::INFINITY;
        let mut hi = f32::NEG_INFINITY;
        for &v in self.data.iter() {
            if v < lo { lo = v; }
            if v > hi { hi = v; }
        }
        self.min = lo;
        self.max = hi;
        self.dirty_cache = false;
    }
}
