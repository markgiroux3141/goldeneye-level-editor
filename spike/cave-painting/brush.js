// Fractal brush that modifies a sparse DensityField's corner samples.
//
// The brush boundary is not a sphere — FBM displaces the effective distance
// before the cosine falloff, so the carved shape is jagged like real rock.
// Writes are batched per-chunk: one chunk allocation + one tight typed-array
// loop per chunk, rather than a per-voxel Map lookup.

import { fbm3D } from './noise3D.js';
import { CHUNK_SIZE } from './densityField.js';

const FBM_FREQ = 0.6;                  // world-space frequency of the boundary noise
const DISPLACE_FRAC = 0.2;             // displacement amplitude as a fraction of radius
const FBM_OCTAVES = 2;

/**
 * Apply the brush to the density field.
 *   mode = 'subtract' (default click) drives density down (carves air).
 *   mode = 'add' (shift+click) drives density up (builds rock).
 *   mode = 'flatten' (F-toggle) blends density toward a horizontal plane at center.y.
 *
 * Marks overlapping chunks dirty (including low-side neighbors for seam correctness).
 * Returns true if any sample was modified.
 */
export function applyBrush(field, center, radius, strength, mode, dt) {
    if (mode === 'flatten') return applyFlattenBrush(field, center, radius, strength, dt);
    if (mode === 'smooth')  return applySmoothBrush(field, center, radius, strength, dt);
    if (mode === 'expand')  return applyExpandBrush(field, center, radius, strength, dt);

    const sign = (mode === 'add') ? +1 : -1;
    const dtScale = Math.min(dt * 60, 2); // ~60 fps baseline; cap so hitching doesn't over-apply

    const vs = field.voxelSize;
    const bs = CHUNK_SIZE;

    const displaceAmt = DISPLACE_FRAC * radius;
    const effectiveRadius = radius + displaceAmt;
    const effR2 = effectiveRadius * effectiveRadius;

    // World AABB expanded by displacement so outward FBM spikes aren't clipped.
    const minX = center.x - effectiveRadius, maxX = center.x + effectiveRadius;
    const minY = center.y - effectiveRadius, maxY = center.y + effectiveRadius;
    const minZ = center.z - effectiveRadius, maxZ = center.z + effectiveRadius;

    // Voxel-space AABB.
    const iMin = Math.floor(minX / vs), iMax = Math.ceil(maxX / vs);
    const jMin = Math.floor(minY / vs), jMax = Math.ceil(maxY / vs);
    const kMin = Math.floor(minZ / vs), kMax = Math.ceil(maxZ / vs);

    // Chunk range.
    const cxLo = Math.floor(iMin / bs), cxHi = Math.floor(iMax / bs);
    const cyLo = Math.floor(jMin / bs), cyHi = Math.floor(jMax / bs);
    const czLo = Math.floor(kMin / bs), czHi = Math.floor(kMax / bs);

    let modified = false;

    for (let ccz = czLo; ccz <= czHi; ccz++) {
        for (let ccy = cyLo; ccy <= cyHi; ccy++) {
            for (let ccx = cxLo; ccx <= cxHi; ccx++) {
                // Clip voxel range to this chunk's local [0..bs-1] corner indices.
                const liLo = Math.max(0, iMin - ccx * bs);
                const liHi = Math.min(bs - 1, iMax - ccx * bs);
                const ljLo = Math.max(0, jMin - ccy * bs);
                const ljHi = Math.min(bs - 1, jMax - ccy * bs);
                const lkLo = Math.max(0, kMin - ccz * bs);
                const lkHi = Math.min(bs - 1, kMax - ccz * bs);
                if (liLo > liHi || ljLo > ljHi || lkLo > lkHi) continue;

                const chunk = field.getOrCreateChunk(ccx, ccy, ccz);

                for (let lk = lkLo; lk <= lkHi; lk++) {
                    const wz = (ccz * bs + lk) * vs;
                    const dz = wz - center.z;
                    for (let lj = ljLo; lj <= ljHi; lj++) {
                        const wy = (ccy * bs + lj) * vs;
                        const dy = wy - center.y;
                        for (let li = liLo; li <= liHi; li++) {
                            const wx = (ccx * bs + li) * vs;
                            const dx = wx - center.x;
                            const d2 = dx * dx + dy * dy + dz * dz;
                            if (d2 > effR2) continue;

                            const dist = Math.sqrt(d2);
                            const fbmVal = fbm3D(wx * FBM_FREQ, wy * FBM_FREQ, wz * FBM_FREQ, FBM_OCTAVES);
                            const effDist = dist + fbmVal * displaceAmt;
                            if (effDist > radius) continue;

                            const clampedEff = effDist > 0 ? effDist : 0;
                            const falloff = 0.5 * (1 + Math.cos(Math.PI * clampedEff / radius));
                            const delta = sign * strength * falloff * dtScale;

                            chunk[li + bs * (lj + bs * lk)] += delta;
                            modified = true;
                        }
                    }
                }
            }
        }
    }

    if (modified) {
        field.markDirtyAABB(minX, minY, minZ, maxX, maxY, maxZ);
    }
    return modified;
}

/**
 * Flatten brush — drives density toward a horizontal plane at center.y.
 * Selection is a vertical cylinder (horizontal radius); each voxel's density
 * is blended toward target = (planeY - wy), clamped per frame so flatten speed
 * follows the strength slider. Bidirectional: above-plane peaks carve down,
 * below-plane valleys fill up.
 */
function applyFlattenBrush(field, center, radius, strength, dt) {
    const dtScale = Math.min(dt * 60, 2);
    const vs = field.voxelSize;
    const bs = CHUNK_SIZE;

    const planeY = center.y;
    const r2 = radius * radius;

    const minX = center.x - radius, maxX = center.x + radius;
    const minY = planeY - radius,   maxY = planeY + radius;
    const minZ = center.z - radius, maxZ = center.z + radius;

    const iMin = Math.floor(minX / vs), iMax = Math.ceil(maxX / vs);
    const jMin = Math.floor(minY / vs), jMax = Math.ceil(maxY / vs);
    const kMin = Math.floor(minZ / vs), kMax = Math.ceil(maxZ / vs);

    const cxLo = Math.floor(iMin / bs), cxHi = Math.floor(iMax / bs);
    const cyLo = Math.floor(jMin / bs), cyHi = Math.floor(jMax / bs);
    const czLo = Math.floor(kMin / bs), czHi = Math.floor(kMax / bs);

    let modified = false;

    for (let ccz = czLo; ccz <= czHi; ccz++) {
        for (let ccy = cyLo; ccy <= cyHi; ccy++) {
            for (let ccx = cxLo; ccx <= cxHi; ccx++) {
                const liLo = Math.max(0, iMin - ccx * bs);
                const liHi = Math.min(bs - 1, iMax - ccx * bs);
                const ljLo = Math.max(0, jMin - ccy * bs);
                const ljHi = Math.min(bs - 1, jMax - ccy * bs);
                const lkLo = Math.max(0, kMin - ccz * bs);
                const lkHi = Math.min(bs - 1, kMax - ccz * bs);
                if (liLo > liHi || ljLo > ljHi || lkLo > lkHi) continue;

                const chunk = field.getOrCreateChunk(ccx, ccy, ccz);

                for (let lk = lkLo; lk <= lkHi; lk++) {
                    const wz = (ccz * bs + lk) * vs;
                    const dz = wz - center.z;
                    for (let lj = ljLo; lj <= ljHi; lj++) {
                        const wy = (ccy * bs + lj) * vs;
                        const target = planeY - wy;
                        for (let li = liLo; li <= liHi; li++) {
                            const wx = (ccx * bs + li) * vs;
                            const dx = wx - center.x;
                            const horiz2 = dx * dx + dz * dz;
                            if (horiz2 > r2) continue;

                            const horiz = Math.sqrt(horiz2);
                            const falloff = 0.5 * (1 + Math.cos(Math.PI * horiz / radius));
                            const idx = li + bs * (lj + bs * lk);
                            const current = chunk[idx];
                            const diff = target - current;
                            const stepCap = strength * falloff * dtScale;
                            const delta = diff > stepCap ? stepCap : (diff < -stepCap ? -stepCap : diff);
                            if (delta === 0) continue;
                            chunk[idx] = current + delta;
                            modified = true;
                        }
                    }
                }
            }
        }
    }

    if (modified) {
        field.markDirtyAABB(minX, minY, minZ, maxX, maxY, maxZ);
    }
    return modified;
}

/**
 * Smoothing (relax) brush — blends each voxel toward the average of its 6
 * axis-aligned neighbors. Softens rough patches and jagged carving.
 *
 * Per-chunk snapshot avoids scan-order smearing for the dominant interior
 * reads; cross-chunk neighbor reads go through field.getCorner and may pick up
 * already-modified values from earlier-processed chunks — acceptable for a
 * gradual smoothing effect since the next frame corrects it.
 */
function applySmoothBrush(field, center, radius, strength, dt) {
    const dtScale = Math.min(dt * 60, 2);
    const vs = field.voxelSize;
    const bs = CHUNK_SIZE;
    const r2 = radius * radius;

    const minX = center.x - radius, maxX = center.x + radius;
    const minY = center.y - radius, maxY = center.y + radius;
    const minZ = center.z - radius, maxZ = center.z + radius;

    const iMin = Math.floor(minX / vs), iMax = Math.ceil(maxX / vs);
    const jMin = Math.floor(minY / vs), jMax = Math.ceil(maxY / vs);
    const kMin = Math.floor(minZ / vs), kMax = Math.ceil(maxZ / vs);

    const cxLo = Math.floor(iMin / bs), cxHi = Math.floor(iMax / bs);
    const cyLo = Math.floor(jMin / bs), cyHi = Math.floor(jMax / bs);
    const czLo = Math.floor(kMin / bs), czHi = Math.floor(kMax / bs);

    let modified = false;

    for (let ccz = czLo; ccz <= czHi; ccz++) {
        for (let ccy = cyLo; ccy <= cyHi; ccy++) {
            for (let ccx = cxLo; ccx <= cxHi; ccx++) {
                const liLo = Math.max(0, iMin - ccx * bs);
                const liHi = Math.min(bs - 1, iMax - ccx * bs);
                const ljLo = Math.max(0, jMin - ccy * bs);
                const ljHi = Math.min(bs - 1, jMax - ccy * bs);
                const lkLo = Math.max(0, kMin - ccz * bs);
                const lkHi = Math.min(bs - 1, kMax - ccz * bs);
                if (liLo > liHi || ljLo > ljHi || lkLo > lkHi) continue;

                const chunk = field.getOrCreateChunk(ccx, ccy, ccz);
                const snap = chunk.slice();

                for (let lk = lkLo; lk <= lkHi; lk++) {
                    const gk = ccz * bs + lk;
                    const wz = gk * vs;
                    const dz = wz - center.z;
                    for (let lj = ljLo; lj <= ljHi; lj++) {
                        const gj = ccy * bs + lj;
                        const wy = gj * vs;
                        const dy = wy - center.y;
                        for (let li = liLo; li <= liHi; li++) {
                            const gi = ccx * bs + li;
                            const wx = gi * vs;
                            const dx = wx - center.x;
                            const d2 = dx * dx + dy * dy + dz * dz;
                            if (d2 > r2) continue;

                            // 6-neighbor average. Fast path when neighbor lives in this chunk.
                            const xp = li < bs - 1 ? snap[(li + 1) + bs * (lj + bs * lk)]
                                                   : field.getCorner(gi + 1, gj, gk);
                            const xn = li > 0      ? snap[(li - 1) + bs * (lj + bs * lk)]
                                                   : field.getCorner(gi - 1, gj, gk);
                            const yp = lj < bs - 1 ? snap[li + bs * ((lj + 1) + bs * lk)]
                                                   : field.getCorner(gi, gj + 1, gk);
                            const yn = lj > 0      ? snap[li + bs * ((lj - 1) + bs * lk)]
                                                   : field.getCorner(gi, gj - 1, gk);
                            const zp = lk < bs - 1 ? snap[li + bs * (lj + bs * (lk + 1))]
                                                   : field.getCorner(gi, gj, gk + 1);
                            const zn = lk > 0      ? snap[li + bs * (lj + bs * (lk - 1))]
                                                   : field.getCorner(gi, gj, gk - 1);
                            const avg = (xp + xn + yp + yn + zp + zn) * (1 / 6);

                            const dist = Math.sqrt(d2);
                            const falloff = 0.5 * (1 + Math.cos(Math.PI * dist / radius));
                            let blend = strength * falloff * dtScale * 0.5;
                            if (blend > 1) blend = 1;

                            const idx = li + bs * (lj + bs * lk);
                            const current = chunk[idx];
                            const delta = (avg - current) * blend;
                            if (delta === 0) continue;
                            chunk[idx] = current + delta;
                            modified = true;
                        }
                    }
                }
            }
        }
    }

    if (modified) {
        field.markDirtyAABB(minX, minY, minZ, maxX, maxY, maxZ);
    }
    return modified;
}

/**
 * Expand (blast) brush — drives density toward the SDF of a sphere centered at
 * `center` with radius `radius`. One-sided: only carves (pushes density down
 * toward air), never fills. Produces clean round voids regardless of existing
 * terrain. Good for hollowing out spherical rooms with a single click.
 */
function applyExpandBrush(field, center, radius, strength, dt) {
    const dtScale = Math.min(dt * 60, 2);
    const vs = field.voxelSize;
    const bs = CHUNK_SIZE;
    const r2 = radius * radius;

    const minX = center.x - radius, maxX = center.x + radius;
    const minY = center.y - radius, maxY = center.y + radius;
    const minZ = center.z - radius, maxZ = center.z + radius;

    const iMin = Math.floor(minX / vs), iMax = Math.ceil(maxX / vs);
    const jMin = Math.floor(minY / vs), jMax = Math.ceil(maxY / vs);
    const kMin = Math.floor(minZ / vs), kMax = Math.ceil(maxZ / vs);

    const cxLo = Math.floor(iMin / bs), cxHi = Math.floor(iMax / bs);
    const cyLo = Math.floor(jMin / bs), cyHi = Math.floor(jMax / bs);
    const czLo = Math.floor(kMin / bs), czHi = Math.floor(kMax / bs);

    const stepCap = strength * dtScale;
    let modified = false;

    for (let ccz = czLo; ccz <= czHi; ccz++) {
        for (let ccy = cyLo; ccy <= cyHi; ccy++) {
            for (let ccx = cxLo; ccx <= cxHi; ccx++) {
                const liLo = Math.max(0, iMin - ccx * bs);
                const liHi = Math.min(bs - 1, iMax - ccx * bs);
                const ljLo = Math.max(0, jMin - ccy * bs);
                const ljHi = Math.min(bs - 1, jMax - ccy * bs);
                const lkLo = Math.max(0, kMin - ccz * bs);
                const lkHi = Math.min(bs - 1, kMax - ccz * bs);
                if (liLo > liHi || ljLo > ljHi || lkLo > lkHi) continue;

                const chunk = field.getOrCreateChunk(ccx, ccy, ccz);

                for (let lk = lkLo; lk <= lkHi; lk++) {
                    const wz = (ccz * bs + lk) * vs;
                    const dz = wz - center.z;
                    for (let lj = ljLo; lj <= ljHi; lj++) {
                        const wy = (ccy * bs + lj) * vs;
                        const dy = wy - center.y;
                        for (let li = liLo; li <= liHi; li++) {
                            const wx = (ccx * bs + li) * vs;
                            const dx = wx - center.x;
                            const d2 = dx * dx + dy * dy + dz * dz;
                            if (d2 > r2) continue;

                            // Target SDF of sphere boundary: negative inside, zero on surface.
                            const target = Math.sqrt(d2) - radius;
                            const idx = li + bs * (lj + bs * lk);
                            const current = chunk[idx];
                            const diff = target - current;
                            if (diff >= 0) continue; // already at or past target (air enough)

                            const delta = diff < -stepCap ? -stepCap : diff;
                            chunk[idx] = current + delta;
                            modified = true;
                        }
                    }
                }
            }
        }
    }

    if (modified) {
        field.markDirtyAABB(minX, minY, minZ, maxX, maxY, maxZ);
    }
    return modified;
}
