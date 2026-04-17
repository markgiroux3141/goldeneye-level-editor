// Spherical brush that modifies a DensityField's corner samples.
// Cosine falloff × FBM-modulated magnitude so surfaces are organic, not perfectly spherical.

import { fbm3D } from './noise3D.js';

const FBM_FREQ = 0.8;    // scale of the noise variation on brush magnitude (per world meter)
const FBM_AMP  = 0.5;    // modulation strength; (1 + FBM_AMP * fbm) stays in [0.5, 1.5]

/**
 * Apply the brush to the density field.
 *   mode = 'subtract' (default click) drives density down (carves air out of rock)
 *   mode = 'add' (shift+click) drives density up (builds rock back up)
 *
 * Affects corners within `radius` of `center`. Marks overlapping blocks dirty.
 * Returns true if any sample was modified.
 */
export function applyBrush(field, center, radius, strength, mode, dt) {
    const sign = (mode === 'add') ? +1 : -1;
    const dtScale = Math.min(dt * 60, 2); // ~60 fps baseline; cap so hitching doesn't over-apply

    const vs = field.voxelSize;
    const c = field.corners;
    const ox = field.origin[0], oy = field.origin[1], oz = field.origin[2];

    // Sample-index AABB of the affected region.
    const v = field.worldToVoxel(center.x, center.y, center.z);
    const rVox = radius / vs;
    const iMin = Math.max(0, Math.floor(v.x - rVox));
    const jMin = Math.max(0, Math.floor(v.y - rVox));
    const kMin = Math.max(0, Math.floor(v.z - rVox));
    const iMax = Math.min(c - 1, Math.ceil(v.x + rVox));
    const jMax = Math.min(c - 1, Math.ceil(v.y + rVox));
    const kMax = Math.min(c - 1, Math.ceil(v.z + rVox));

    const r2 = radius * radius;
    let modified = false;

    for (let kk = kMin; kk <= kMax; kk++) {
        const wz = oz + kk * vs;
        for (let jj = jMin; jj <= jMax; jj++) {
            const wy = oy + jj * vs;
            for (let ii = iMin; ii <= iMax; ii++) {
                const wx = ox + ii * vs;
                const dx = wx - center.x;
                const dy = wy - center.y;
                const dz = wz - center.z;
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 > r2) continue;

                const dist = Math.sqrt(d2);
                const falloff = 0.5 * (1 + Math.cos(Math.PI * dist / radius));
                const n = fbm3D(wx * FBM_FREQ, wy * FBM_FREQ, wz * FBM_FREQ, 3);
                const noiseFactor = 1 + FBM_AMP * n; // in [1-FBM_AMP, 1+FBM_AMP]
                const delta = sign * strength * falloff * noiseFactor * dtScale;

                const idx = field.idx(ii, jj, kk);
                field.data[idx] += delta;
                modified = true;
            }
        }
    }

    if (modified) {
        field.markDirtyAABB(
            center.x - radius, center.y - radius, center.z - radius,
            center.x + radius, center.y + radius, center.z + radius,
        );
    }
    return modified;
}
