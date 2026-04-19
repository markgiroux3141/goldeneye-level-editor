use crate::chunk::{Chunk, CHUNK_SIZE, CHUNK_VOL};
use crate::noise::fbm3d;
use crate::world::World;

pub const MODE_SUBTRACT: u8 = 0;
pub const MODE_ADD: u8 = 1;
pub const MODE_FLATTEN: u8 = 2;
pub const MODE_SMOOTH: u8 = 3;
pub const MODE_EXPAND: u8 = 4;

const FBM_FREQ: f32 = 0.6;
const DISPLACE_FRAC: f32 = 0.2;
const FBM_OCTAVES: u32 = 2;

pub fn apply_brush(
    world: &mut World,
    mode: u8,
    cx: f32, cy: f32, cz: f32,
    radius: f32, strength: f32, dt: f32,
) -> bool {
    match mode {
        MODE_SUBTRACT => apply_sign(world, -1.0, cx, cy, cz, radius, strength, dt),
        MODE_ADD      => apply_sign(world,  1.0, cx, cy, cz, radius, strength, dt),
        MODE_FLATTEN  => apply_flatten(world, cx, cy, cz, radius, strength, dt),
        MODE_SMOOTH   => apply_smooth(world, cx, cy, cz, radius, strength, dt),
        MODE_EXPAND   => apply_expand(world, cx, cy, cz, radius, strength, dt),
        _ => false,
    }
}

// Common chunk-range setup. Returns (i_min,i_max, j_min,j_max, k_min,k_max,
// cx_lo,cx_hi, cy_lo,cy_hi, cz_lo,cz_hi).
#[inline]
fn aabb_to_chunk_range(
    vs: f32, bs: i32,
    min_x: f32, min_y: f32, min_z: f32,
    max_x: f32, max_y: f32, max_z: f32,
) -> (i32, i32, i32, i32, i32, i32, i32, i32, i32, i32, i32, i32) {
    let i_min = (min_x / vs).floor() as i32;
    let i_max = (max_x / vs).ceil()  as i32;
    let j_min = (min_y / vs).floor() as i32;
    let j_max = (max_y / vs).ceil()  as i32;
    let k_min = (min_z / vs).floor() as i32;
    let k_max = (max_z / vs).ceil()  as i32;
    let cx_lo = i_min.div_euclid(bs);
    let cx_hi = i_max.div_euclid(bs);
    let cy_lo = j_min.div_euclid(bs);
    let cy_hi = j_max.div_euclid(bs);
    let cz_lo = k_min.div_euclid(bs);
    let cz_hi = k_max.div_euclid(bs);
    (i_min, i_max, j_min, j_max, k_min, k_max, cx_lo, cx_hi, cy_lo, cy_hi, cz_lo, cz_hi)
}

// ---------- subtract / add (fractal boundary) ----------
fn apply_sign(
    world: &mut World,
    sign: f32,
    cx: f32, cy: f32, cz: f32,
    radius: f32, strength: f32, dt: f32,
) -> bool {
    let dt_scale = (dt * 60.0).min(2.0);
    let vs = world.voxel_size;
    let bs = CHUNK_SIZE as i32;

    let displace_amt = DISPLACE_FRAC * radius;
    let eff_r = radius + displace_amt;
    let eff_r2 = eff_r * eff_r;

    let min_x = cx - eff_r; let max_x = cx + eff_r;
    let min_y = cy - eff_r; let max_y = cy + eff_r;
    let min_z = cz - eff_r; let max_z = cz + eff_r;

    let (i_min, i_max, j_min, j_max, k_min, k_max,
         cx_lo, cx_hi, cy_lo, cy_hi, cz_lo, cz_hi) =
        aabb_to_chunk_range(vs, bs, min_x, min_y, min_z, max_x, max_y, max_z);

    let mut modified = false;

    for ccz in cz_lo..=cz_hi {
        for ccy in cy_lo..=cy_hi {
            for ccx in cx_lo..=cx_hi {
                let li_lo = (0i32).max(i_min - ccx * bs);
                let li_hi = (bs - 1).min(i_max - ccx * bs);
                let lj_lo = (0i32).max(j_min - ccy * bs);
                let lj_hi = (bs - 1).min(j_max - ccy * bs);
                let lk_lo = (0i32).max(k_min - ccz * bs);
                let lk_hi = (bs - 1).min(k_max - ccz * bs);
                if li_lo > li_hi || lj_lo > lj_hi || lk_lo > lk_hi { continue; }

                let mut chunk_modified = false;
                let chunk = world.get_or_create_chunk_mut(ccx, ccy, ccz);

                for lk in lk_lo..=lk_hi {
                    let wz = (ccz * bs + lk) as f32 * vs;
                    let dz = wz - cz;
                    for lj in lj_lo..=lj_hi {
                        let wy = (ccy * bs + lj) as f32 * vs;
                        let dy = wy - cy;
                        for li in li_lo..=li_hi {
                            let wx = (ccx * bs + li) as f32 * vs;
                            let dx = wx - cx;
                            let d2 = dx * dx + dy * dy + dz * dz;
                            if d2 > eff_r2 { continue; }

                            let dist = d2.sqrt();
                            let fbm_val = fbm3d(wx * FBM_FREQ, wy * FBM_FREQ, wz * FBM_FREQ, FBM_OCTAVES);
                            let eff_dist = dist + fbm_val * displace_amt;
                            if eff_dist > radius { continue; }

                            let clamped = if eff_dist > 0.0 { eff_dist } else { 0.0 };
                            let falloff = 0.5 * (1.0 + (std::f32::consts::PI * clamped / radius).cos());
                            let delta = sign * strength * falloff * dt_scale;

                            let idx = Chunk::idx(li as usize, lj as usize, lk as usize);
                            chunk.data[idx] += delta;
                            chunk_modified = true;
                        }
                    }
                }
                if chunk_modified {
                    modified = true;
                    chunk.dirty_cache = true;
                }
            }
        }
    }

    if modified {
        // Refresh min/max for all affected chunks so mesh-skip can fast-path correctly.
        refresh_touched_min_max(world, cx_lo, cx_hi, cy_lo, cy_hi, cz_lo, cz_hi);
        world.mark_dirty_aabb(min_x, min_y, min_z, max_x, max_y, max_z);
    }
    modified
}

// ---------- flatten ----------
fn apply_flatten(
    world: &mut World,
    cx: f32, cy: f32, cz: f32,
    radius: f32, strength: f32, dt: f32,
) -> bool {
    let dt_scale = (dt * 60.0).min(2.0);
    let vs = world.voxel_size;
    let bs = CHUNK_SIZE as i32;
    let plane_y = cy;
    let r2 = radius * radius;

    let min_x = cx - radius; let max_x = cx + radius;
    let min_y = plane_y - radius; let max_y = plane_y + radius;
    let min_z = cz - radius; let max_z = cz + radius;

    let (i_min, i_max, j_min, j_max, k_min, k_max,
         cx_lo, cx_hi, cy_lo, cy_hi, cz_lo, cz_hi) =
        aabb_to_chunk_range(vs, bs, min_x, min_y, min_z, max_x, max_y, max_z);

    let mut modified = false;

    for ccz in cz_lo..=cz_hi {
        for ccy in cy_lo..=cy_hi {
            for ccx in cx_lo..=cx_hi {
                let li_lo = (0i32).max(i_min - ccx * bs);
                let li_hi = (bs - 1).min(i_max - ccx * bs);
                let lj_lo = (0i32).max(j_min - ccy * bs);
                let lj_hi = (bs - 1).min(j_max - ccy * bs);
                let lk_lo = (0i32).max(k_min - ccz * bs);
                let lk_hi = (bs - 1).min(k_max - ccz * bs);
                if li_lo > li_hi || lj_lo > lj_hi || lk_lo > lk_hi { continue; }

                let mut chunk_modified = false;
                let chunk = world.get_or_create_chunk_mut(ccx, ccy, ccz);

                for lk in lk_lo..=lk_hi {
                    let wz = (ccz * bs + lk) as f32 * vs;
                    let dz = wz - cz;
                    for lj in lj_lo..=lj_hi {
                        let wy = (ccy * bs + lj) as f32 * vs;
                        let target = plane_y - wy;
                        for li in li_lo..=li_hi {
                            let wx = (ccx * bs + li) as f32 * vs;
                            let dx = wx - cx;
                            let horiz2 = dx * dx + dz * dz;
                            if horiz2 > r2 { continue; }

                            let horiz = horiz2.sqrt();
                            let falloff = 0.5 * (1.0 + (std::f32::consts::PI * horiz / radius).cos());
                            let idx = Chunk::idx(li as usize, lj as usize, lk as usize);
                            let current = chunk.data[idx];
                            let diff = target - current;
                            let step_cap = strength * falloff * dt_scale;
                            let delta = if diff > step_cap {
                                step_cap
                            } else if diff < -step_cap {
                                -step_cap
                            } else {
                                diff
                            };
                            if delta == 0.0 { continue; }
                            chunk.data[idx] = current + delta;
                            chunk_modified = true;
                        }
                    }
                }
                if chunk_modified {
                    modified = true;
                    chunk.dirty_cache = true;
                }
            }
        }
    }

    if modified {
        refresh_touched_min_max(world, cx_lo, cx_hi, cy_lo, cy_hi, cz_lo, cz_hi);
        world.mark_dirty_aabb(min_x, min_y, min_z, max_x, max_y, max_z);
    }
    modified
}

// ---------- smooth ----------
fn apply_smooth(
    world: &mut World,
    cx: f32, cy: f32, cz: f32,
    radius: f32, strength: f32, dt: f32,
) -> bool {
    let dt_scale = (dt * 60.0).min(2.0);
    let vs = world.voxel_size;
    let bs = CHUNK_SIZE as i32;
    let r2 = radius * radius;

    let min_x = cx - radius; let max_x = cx + radius;
    let min_y = cy - radius; let max_y = cy + radius;
    let min_z = cz - radius; let max_z = cz + radius;

    let (i_min, i_max, j_min, j_max, k_min, k_max,
         cx_lo, cx_hi, cy_lo, cy_hi, cz_lo, cz_hi) =
        aabb_to_chunk_range(vs, bs, min_x, min_y, min_z, max_x, max_y, max_z);

    let mut modified = false;
    // Stack scratch — reused per chunk so no per-chunk heap alloc.
    let mut scratch: [f32; CHUNK_VOL] = [0.0; CHUNK_VOL];
    let mut scratch_has: [bool; CHUNK_VOL] = [false; CHUNK_VOL];

    for ccz in cz_lo..=cz_hi {
        for ccy in cy_lo..=cy_hi {
            for ccx in cx_lo..=cx_hi {
                let li_lo = (0i32).max(i_min - ccx * bs);
                let li_hi = (bs - 1).min(i_max - ccx * bs);
                let lj_lo = (0i32).max(j_min - ccy * bs);
                let lj_hi = (bs - 1).min(j_max - ccy * bs);
                let lk_lo = (0i32).max(k_min - ccz * bs);
                let lk_hi = (bs - 1).min(k_max - ccz * bs);
                if li_lo > li_hi || lj_lo > lj_hi || lk_lo > lk_hi { continue; }

                // Read phase: compute new values via &World reads; store in scratch.
                let mut scratch_any = false;
                for lk in lk_lo..=lk_hi {
                    let gk = ccz * bs + lk;
                    let wz = gk as f32 * vs;
                    let dz = wz - cz;
                    for lj in lj_lo..=lj_hi {
                        let gj = ccy * bs + lj;
                        let wy = gj as f32 * vs;
                        let dy = wy - cy;
                        for li in li_lo..=li_hi {
                            let gi = ccx * bs + li;
                            let wx = gi as f32 * vs;
                            let dx = wx - cx;
                            let d2 = dx * dx + dy * dy + dz * dz;
                            if d2 > r2 { continue; }

                            let xp = world.get_corner(gi + 1, gj, gk);
                            let xn = world.get_corner(gi - 1, gj, gk);
                            let yp = world.get_corner(gi, gj + 1, gk);
                            let yn = world.get_corner(gi, gj - 1, gk);
                            let zp = world.get_corner(gi, gj, gk + 1);
                            let zn = world.get_corner(gi, gj, gk - 1);
                            let avg = (xp + xn + yp + yn + zp + zn) * (1.0 / 6.0);

                            let dist = d2.sqrt();
                            let falloff = 0.5 * (1.0 + (std::f32::consts::PI * dist / radius).cos());
                            let mut blend = strength * falloff * dt_scale * 0.5;
                            if blend > 1.0 { blend = 1.0; }

                            let current = world.get_corner(gi, gj, gk);
                            let delta = (avg - current) * blend;
                            if delta == 0.0 { continue; }

                            let idx = Chunk::idx(li as usize, lj as usize, lk as usize);
                            scratch[idx] = current + delta;
                            scratch_has[idx] = true;
                            scratch_any = true;
                        }
                    }
                }

                if !scratch_any { continue; }

                // Write phase: commit scratch into target chunk.
                let chunk = world.get_or_create_chunk_mut(ccx, ccy, ccz);
                for lk in lk_lo..=lk_hi {
                    for lj in lj_lo..=lj_hi {
                        for li in li_lo..=li_hi {
                            let idx = Chunk::idx(li as usize, lj as usize, lk as usize);
                            if scratch_has[idx] {
                                chunk.data[idx] = scratch[idx];
                                scratch_has[idx] = false;
                            }
                        }
                    }
                }
                chunk.dirty_cache = true;
                modified = true;
            }
        }
    }

    if modified {
        refresh_touched_min_max(world, cx_lo, cx_hi, cy_lo, cy_hi, cz_lo, cz_hi);
        world.mark_dirty_aabb(min_x, min_y, min_z, max_x, max_y, max_z);
    }
    modified
}

// ---------- expand (SDF sphere, one-sided carve) ----------
fn apply_expand(
    world: &mut World,
    cx: f32, cy: f32, cz: f32,
    radius: f32, strength: f32, dt: f32,
) -> bool {
    let dt_scale = (dt * 60.0).min(2.0);
    let vs = world.voxel_size;
    let bs = CHUNK_SIZE as i32;
    let r2 = radius * radius;

    let min_x = cx - radius; let max_x = cx + radius;
    let min_y = cy - radius; let max_y = cy + radius;
    let min_z = cz - radius; let max_z = cz + radius;

    let (i_min, i_max, j_min, j_max, k_min, k_max,
         cx_lo, cx_hi, cy_lo, cy_hi, cz_lo, cz_hi) =
        aabb_to_chunk_range(vs, bs, min_x, min_y, min_z, max_x, max_y, max_z);

    let step_cap = strength * dt_scale;
    let mut modified = false;

    for ccz in cz_lo..=cz_hi {
        for ccy in cy_lo..=cy_hi {
            for ccx in cx_lo..=cx_hi {
                let li_lo = (0i32).max(i_min - ccx * bs);
                let li_hi = (bs - 1).min(i_max - ccx * bs);
                let lj_lo = (0i32).max(j_min - ccy * bs);
                let lj_hi = (bs - 1).min(j_max - ccy * bs);
                let lk_lo = (0i32).max(k_min - ccz * bs);
                let lk_hi = (bs - 1).min(k_max - ccz * bs);
                if li_lo > li_hi || lj_lo > lj_hi || lk_lo > lk_hi { continue; }

                let mut chunk_modified = false;
                let chunk = world.get_or_create_chunk_mut(ccx, ccy, ccz);

                for lk in lk_lo..=lk_hi {
                    let wz = (ccz * bs + lk) as f32 * vs;
                    let dz = wz - cz;
                    for lj in lj_lo..=lj_hi {
                        let wy = (ccy * bs + lj) as f32 * vs;
                        let dy = wy - cy;
                        for li in li_lo..=li_hi {
                            let wx = (ccx * bs + li) as f32 * vs;
                            let dx = wx - cx;
                            let d2 = dx * dx + dy * dy + dz * dz;
                            if d2 > r2 { continue; }

                            let target = d2.sqrt() - radius;
                            let idx = Chunk::idx(li as usize, lj as usize, lk as usize);
                            let current = chunk.data[idx];
                            let diff = target - current;
                            if diff >= 0.0 { continue; }

                            let delta = if diff < -step_cap { -step_cap } else { diff };
                            chunk.data[idx] = current + delta;
                            chunk_modified = true;
                        }
                    }
                }
                if chunk_modified {
                    modified = true;
                    chunk.dirty_cache = true;
                }
            }
        }
    }

    if modified {
        refresh_touched_min_max(world, cx_lo, cx_hi, cy_lo, cy_hi, cz_lo, cz_hi);
        world.mark_dirty_aabb(min_x, min_y, min_z, max_x, max_y, max_z);
    }
    modified
}

fn refresh_touched_min_max(
    world: &mut World,
    cx_lo: i32, cx_hi: i32,
    cy_lo: i32, cy_hi: i32,
    cz_lo: i32, cz_hi: i32,
) {
    for ccz in cz_lo..=cz_hi {
        for ccy in cy_lo..=cy_hi {
            for ccx in cx_lo..=cx_hi {
                let key = crate::world::pack_key(ccx, ccy, ccz);
                if let Some(chunk) = world.chunks.get_mut(&key) {
                    if chunk.dirty_cache {
                        chunk.refresh_min_max();
                    }
                }
            }
        }
    }
}
