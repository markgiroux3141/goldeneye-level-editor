mod chunk;
mod chunk_window;
mod noise;
mod world;
mod brush;
mod marching;
mod tables;

use wasm_bindgen::prelude::*;
use world::World;
use marching::MeshData;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
    noise::init_perm(1337);
}

#[wasm_bindgen]
pub struct CaveWorld {
    world: World,
    dirty_buf: Vec<i32>,
}

#[wasm_bindgen]
impl CaveWorld {
    #[wasm_bindgen(constructor)]
    pub fn new(voxel_size: f32, default_density: f32) -> CaveWorld {
        CaveWorld {
            world: World::new(voxel_size, default_density),
            dirty_buf: Vec::with_capacity(256),
        }
    }

    pub fn init_hollow_cavity(
        &mut self,
        cx: f32, cy: f32, cz: f32,
        radius: f32, amp: f32, freq: f32,
    ) {
        self.world.init_hollow_cavity(cx, cy, cz, radius, amp, freq);
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
        let window = self.world.build_window(cx, cy, cz);
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
