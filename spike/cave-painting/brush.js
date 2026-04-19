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
 *
 * Affects corners within an FBM-displaced sphere of `radius`. Marks overlapping
 * chunks dirty (including low-side neighbors for seam correctness).
 * Returns true if any sample was modified.
 */
export function applyBrush(field, center, radius, strength, mode, dt) {
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
