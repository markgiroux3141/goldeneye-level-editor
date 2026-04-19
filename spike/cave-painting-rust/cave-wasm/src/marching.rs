use crate::chunk::CHUNK_SIZE;
use crate::chunk_window::ChunkWindow;
use crate::tables::{CORNER_OFFSETS, EDGE_CORNERS, EDGE_TABLE, TRI_TABLE};

const ISO: f32 = 0.0;
const TEX_TILE_METERS: f32 = 2.0;
const UV_SCALE: f32 = 1.0 / TEX_TILE_METERS;

pub struct MeshData {
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub uvs: Vec<f32>,
}

// Central-difference gradient at a window-local corner, clamped to [0..bs].
#[inline(always)]
fn corner_gradient(window: &ChunkWindow, li: usize, lj: usize, lk: usize) -> [f32; 3] {
    let bs = CHUNK_SIZE;
    let i_l = if li > 0 { li - 1 } else { li };
    let i_r = if li < bs { li + 1 } else { li };
    let j_l = if lj > 0 { lj - 1 } else { lj };
    let j_r = if lj < bs { lj + 1 } else { lj };
    let k_l = if lk > 0 { lk - 1 } else { lk };
    let k_r = if lk < bs { lk + 1 } else { lk };
    [
        window.get_corner(i_r, lj, lk) - window.get_corner(i_l, lj, lk),
        window.get_corner(li, j_r, lk) - window.get_corner(li, j_l, lk),
        window.get_corner(li, lj, k_r) - window.get_corner(li, lj, k_l),
    ]
}

// Returns None if the chunk's 8-chunk window is entirely solid or entirely air.
pub fn mesh_chunk(window: &ChunkWindow, cx: i32, cy: i32, cz: i32, voxel_size: f32) -> Option<MeshData> {
    if !window.intersects_iso() {
        return None;
    }

    let bs = CHUNK_SIZE;
    let ox = cx as f32 * bs as f32 * voxel_size;
    let oy = cy as f32 * bs as f32 * voxel_size;
    let oz = cz as f32 * bs as f32 * voxel_size;

    let mut corner_vals = [0f32; 8];
    // Un-normalized gradients per corner — we normalize once per emitted vertex.
    let mut corner_grads = [0f32; 24];
    let mut edge_pos = [0f32; 36];
    let mut edge_grad = [0f32; 36];

    let mut positions: Vec<f32> = Vec::with_capacity(3072);
    let mut normals: Vec<f32> = Vec::with_capacity(3072);
    let mut uvs: Vec<f32> = Vec::with_capacity(2048);

    for lk in 0..bs {
        for lj in 0..bs {
            for li in 0..bs {
                let mut cube_index: usize = 0;
                for c in 0..8 {
                    let off = CORNER_OFFSETS[c];
                    let v = window.get_corner(
                        li + off[0] as usize,
                        lj + off[1] as usize,
                        lk + off[2] as usize,
                    );
                    corner_vals[c] = v;
                    if v < ISO {
                        cube_index |= 1 << c;
                    }
                }

                let edge_mask = EDGE_TABLE[cube_index];
                if edge_mask == 0 {
                    continue;
                }

                for c in 0..8 {
                    let off = CORNER_OFFSETS[c];
                    let g = corner_gradient(
                        window,
                        li + off[0] as usize,
                        lj + off[1] as usize,
                        lk + off[2] as usize,
                    );
                    corner_grads[c * 3    ] = g[0];
                    corner_grads[c * 3 + 1] = g[1];
                    corner_grads[c * 3 + 2] = g[2];
                }

                for e in 0..12 {
                    if edge_mask & (1u16 << e) == 0 {
                        continue;
                    }
                    let [c0, c1] = EDGE_CORNERS[e];
                    let v0 = corner_vals[c0];
                    let v1 = corner_vals[c1];
                    let mut t = 0.5f32;
                    let denom = v1 - v0;
                    if denom.abs() > 1e-8 {
                        t = (ISO - v0) / denom;
                        if t < 0.0 { t = 0.0; } else if t > 1.0 { t = 1.0; }
                    }
                    let off0 = CORNER_OFFSETS[c0];
                    let off1 = CORNER_OFFSETS[c1];
                    let pi = (li as i32 + off0[0]) as f32 + t * (off1[0] - off0[0]) as f32;
                    let pj = (lj as i32 + off0[1]) as f32 + t * (off1[1] - off0[1]) as f32;
                    let pk = (lk as i32 + off0[2]) as f32 + t * (off1[2] - off0[2]) as f32;
                    edge_pos[e * 3    ] = ox + pi * voxel_size;
                    edge_pos[e * 3 + 1] = oy + pj * voxel_size;
                    edge_pos[e * 3 + 2] = oz + pk * voxel_size;

                    // Interpolated un-normalized gradient; normalization happens at vertex emit.
                    let gx = corner_grads[c0 * 3    ] + t * (corner_grads[c1 * 3    ] - corner_grads[c0 * 3    ]);
                    let gy = corner_grads[c0 * 3 + 1] + t * (corner_grads[c1 * 3 + 1] - corner_grads[c0 * 3 + 1]);
                    let gz = corner_grads[c0 * 3 + 2] + t * (corner_grads[c1 * 3 + 2] - corner_grads[c0 * 3 + 2]);
                    edge_grad[e * 3    ] = gx;
                    edge_grad[e * 3 + 1] = gy;
                    edge_grad[e * 3 + 2] = gz;
                }

                let tri_base = cube_index * 16;
                let mut t_i = 0;
                while t_i < 16 {
                    let e0 = TRI_TABLE[tri_base + t_i];
                    if e0 == -1 {
                        break;
                    }
                    let e1 = TRI_TABLE[tri_base + t_i + 1];
                    let e2 = TRI_TABLE[tri_base + t_i + 2];
                    let e0 = e0 as usize;
                    let e1 = e1 as usize;
                    let e2 = e2 as usize;

                    let p0 = [edge_pos[e0 * 3], edge_pos[e0 * 3 + 1], edge_pos[e0 * 3 + 2]];
                    let p1 = [edge_pos[e1 * 3], edge_pos[e1 * 3 + 1], edge_pos[e1 * 3 + 2]];
                    let p2 = [edge_pos[e2 * 3], edge_pos[e2 * 3 + 1], edge_pos[e2 * 3 + 2]];
                    positions.extend_from_slice(&p0);
                    positions.extend_from_slice(&p1);
                    positions.extend_from_slice(&p2);

                    for &e in &[e0, e1, e2] {
                        let gx = edge_grad[e * 3    ];
                        let gy = edge_grad[e * 3 + 1];
                        let gz = edge_grad[e * 3 + 2];
                        // Normal points from solid into air: -gradient, normalized.
                        let mut nx = -gx;
                        let mut ny = -gy;
                        let mut nz = -gz;
                        let len2 = nx * nx + ny * ny + nz * nz;
                        if len2 > 1e-12 {
                            let inv = 1.0 / len2.sqrt();
                            nx *= inv; ny *= inv; nz *= inv;
                        }
                        normals.push(nx);
                        normals.push(ny);
                        normals.push(nz);
                    }

                    let ex0 = p1[0] - p0[0]; let ey0 = p1[1] - p0[1]; let ez0 = p1[2] - p0[2];
                    let ex1 = p2[0] - p0[0]; let ey1 = p2[1] - p0[1]; let ez1 = p2[2] - p0[2];
                    let fnx = ey0 * ez1 - ez0 * ey1;
                    let fny = ez0 * ex1 - ex0 * ez1;
                    let fnz = ex0 * ey1 - ey0 * ex1;
                    let abs_x = fnx.abs();
                    let abs_y = fny.abs();
                    let abs_z = fnz.abs();

                    let (u0, v0uv, u1, v1uv, u2, v2uv);
                    if abs_x >= abs_y && abs_x >= abs_z {
                        let s = if fnx < 0.0 { -1.0 } else { 1.0 };
                        u0 = p0[2] * s; v0uv = p0[1];
                        u1 = p1[2] * s; v1uv = p1[1];
                        u2 = p2[2] * s; v2uv = p2[1];
                    } else if abs_y >= abs_z {
                        let s = if fny < 0.0 { -1.0 } else { 1.0 };
                        u0 = p0[0]; v0uv = p0[2] * s;
                        u1 = p1[0]; v1uv = p1[2] * s;
                        u2 = p2[0]; v2uv = p2[2] * s;
                    } else {
                        let s = if fnz < 0.0 { -1.0 } else { 1.0 };
                        u0 = p0[0] * s; v0uv = p0[1];
                        u1 = p1[0] * s; v1uv = p1[1];
                        u2 = p2[0] * s; v2uv = p2[1];
                    }
                    uvs.push(u0 * UV_SCALE); uvs.push(v0uv * UV_SCALE);
                    uvs.push(u1 * UV_SCALE); uvs.push(v1uv * UV_SCALE);
                    uvs.push(u2 * UV_SCALE); uvs.push(v2uv * UV_SCALE);

                    t_i += 3;
                }
            }
        }
    }

    if positions.is_empty() {
        None
    } else {
        Some(MeshData { positions, normals, uvs })
    }
}
