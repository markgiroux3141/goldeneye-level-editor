mod chunk;
mod chunk_window;
mod clip;
mod noise;
mod world;
mod brush;
mod marching;
mod tables;

use wasm_bindgen::prelude::*;
use world::World;
use marching::MeshData;
use clip::BoundaryClip;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
    noise::init_perm(1337);
}

#[wasm_bindgen]
pub struct CaveWorld {
    world: World,
    dirty_buf: Vec<i32>,
    clip: Option<BoundaryClip>,
}

#[wasm_bindgen]
impl CaveWorld {
    #[wasm_bindgen(constructor)]
    pub fn new(voxel_size: f32, default_density: f32) -> CaveWorld {
        CaveWorld {
            world: World::new(voxel_size, default_density),
            dirty_buf: Vec::with_capacity(256),
            clip: None,
        }
    }

    pub fn init_hollow_cavity(
        &mut self,
        cx: f32, cy: f32, cz: f32,
        radius: f32, amp: f32, freq: f32,
    ) {
        self.world.init_hollow_cavity(cx, cy, cz, radius, amp, freq);
    }

    /// Configures the SDF boundary clip applied at mesh time.
    ///
    /// Layout of `aabbs` (all coords in world meters):
    ///   [0..6]  = envelope AABB:  [min_x, min_y, min_z, max_x, max_y, max_z]
    ///   [6..N]  = subtract AABBs: 6 floats each, concatenated
    ///
    /// An empty or malformed vec clears the clip (no-op reads; iso stays at
    /// the stored-density surface). See src/clip.rs for the composition rule.
    pub fn set_boundary_clip(&mut self, aabbs: Vec<f32>) {
        if aabbs.is_empty() || aabbs.len() < 6 || aabbs.len() % 6 != 0 {
            self.clip = None;
            return;
        }
        let envelope_min = [aabbs[0], aabbs[1], aabbs[2]];
        let envelope_max = [aabbs[3], aabbs[4], aabbs[5]];
        let mut subtracts = Vec::with_capacity((aabbs.len() - 6) / 6);
        let mut i = 6;
        while i + 6 <= aabbs.len() {
            subtracts.push((
                [aabbs[i    ], aabbs[i + 1], aabbs[i + 2]],
                [aabbs[i + 3], aabbs[i + 4], aabbs[i + 5]],
            ));
            i += 6;
        }
        self.clip = Some(BoundaryClip { envelope_min, envelope_max, subtracts });
    }

    /// mode: 0=subtract 1=add 2=flatten 3=smooth 4=expand
    pub fn apply_brush(
        &mut self,
        mode: u8,
        cx: f32, cy: f32, cz: f32,
        radius: f32, strength: f32, dt: f32,
    ) -> bool {
        brush::apply_brush(&mut self.world, mode, cx, cy, cz, radius, strength, dt)
    }

    /// Drains the dirty set into a flat [cx,cy,cz, cx,cy,cz, …] Int32Array.
    pub fn flush_dirty(&mut self) -> js_sys::Int32Array {
        self.world.drain_dirty(&mut self.dirty_buf);
        let arr = js_sys::Int32Array::new_with_length(self.dirty_buf.len() as u32);
        arr.copy_from(&self.dirty_buf);
        arr
    }

    /// Returns None when the chunk's 8-chunk window is entirely solid or air.
    pub fn mesh_chunk(&self, cx: i32, cy: i32, cz: i32) -> Option<MeshHandle> {
        let window = self.world.build_window(cx, cy, cz, self.clip.as_ref());
        let data = marching::mesh_chunk(&window, cx, cy, cz, self.world.voxel_size)?;
        Some(MeshHandle { data })
    }
}

#[wasm_bindgen]
pub struct MeshHandle {
    data: MeshData,
}

#[wasm_bindgen]
impl MeshHandle {
    pub fn positions(&self) -> js_sys::Float32Array {
        let arr = js_sys::Float32Array::new_with_length(self.data.positions.len() as u32);
        arr.copy_from(&self.data.positions);
        arr
    }

    pub fn normals(&self) -> js_sys::Float32Array {
        let arr = js_sys::Float32Array::new_with_length(self.data.normals.len() as u32);
        arr.copy_from(&self.data.normals);
        arr
    }

    pub fn uvs(&self) -> js_sys::Float32Array {
        let arr = js_sys::Float32Array::new_with_length(self.data.uvs.len() as u32);
        arr.copy_from(&self.data.uvs);
        arr
    }

    pub fn vert_count(&self) -> u32 {
        (self.data.positions.len() / 3) as u32
    }
}
