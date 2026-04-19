// Sparse-chunk 3D density field. One scalar per voxel corner.
// Convention: density > 0 = solid, density < 0 = air, iso-surface at 0.
//
// Storage: Map<packedKey, Float32Array(4096)>. Each chunk owns 16 corners
// along each axis. Chunks are allocated on first write; reads from unallocated
// chunks return `defaultDensity` (solid rock by default). World is unbounded
// — the player can carve in any direction.
//
// Seam handling: meshing chunk (cx,cy,cz) covers cells [0..15] which need
// corners [0..16] per axis. Corner 16 of chunk N = corner 0 of chunk N+1, so
// meshing reads from up to 8 chunks (the chunk itself + its +x/+y/+z/+xy/+xz
// /+yz/+xyz neighbors). `buildChunkWindow` prefetches all 8 so per-corner
// reads are O(1) typed-array lookups.
//
// Rust port notes:
//   - `chunks` → HashMap<(i32,i32,i32), Box<[f32; 4096]>> (hashbrown/ahash).
//   - `buildChunkWindow` → [Option<&[f32; 4096]>; 8].
//   - Per-chunk meshing is embarrassingly parallel (rayon::par_iter).
//   - Brush writes parallelize per chunk, sequential within a chunk.

import { fbm3D } from './noise3D.js';

export const CHUNK_SIZE = 16;           // corners per chunk axis
const CHUNK_VOLUME = CHUNK_SIZE ** 3;   // 4096

// Pack (cx,cy,cz) into a Number. 17 bits per axis × 3 = 51 bits, within safe int range.
// Allowed coord range: [-65536, +65536).
const KEY_BIAS = 1 << 16;
const KEY_MUL = 1 << 17;

export function chunkKey(cx, cy, cz) {
    return ((cx + KEY_BIAS) * KEY_MUL + (cy + KEY_BIAS)) * KEY_MUL + (cz + KEY_BIAS);
}

function unpackKey(key) {
    const cz = (key % KEY_MUL) - KEY_BIAS;
    const t = Math.floor(key / KEY_MUL);
    const cy = (t % KEY_MUL) - KEY_BIAS;
    const cx = Math.floor(t / KEY_MUL) - KEY_BIAS;
    return { cx, cy, cz };
}

export class DensityField {
    constructor({ voxelSize = 0.2, defaultDensity = 1.0 } = {}) {
        this.chunkSize = CHUNK_SIZE;
        this.voxelSize = voxelSize;
        this.defaultDensity = defaultDensity;
        this.chunks = new Map();
        this.dirtyChunks = new Set();
    }

    // --- Chunk accessors ---

    getOrCreateChunk(cx, cy, cz) {
        const key = chunkKey(cx, cy, cz);
        let chunk = this.chunks.get(key);
        if (!chunk) {
            chunk = new Float32Array(CHUNK_VOLUME);
            chunk.fill(this.defaultDensity);
            this.chunks.set(key, chunk);
        }
        return chunk;
    }

    getChunk(cx, cy, cz) {
        return this.chunks.get(chunkKey(cx, cy, cz)) || null;
    }

    getCorner(i, j, k) {
        const cx = Math.floor(i / CHUNK_SIZE);
        const cy = Math.floor(j / CHUNK_SIZE);
        const cz = Math.floor(k / CHUNK_SIZE);
        const chunk = this.chunks.get(chunkKey(cx, cy, cz));
        if (!chunk) return this.defaultDensity;
        const li = i - cx * CHUNK_SIZE;
        const lj = j - cy * CHUNK_SIZE;
        const lk = k - cz * CHUNK_SIZE;
        return chunk[li + CHUNK_SIZE * (lj + CHUNK_SIZE * lk)];
    }

    setCorner(i, j, k, v) {
        const cx = Math.floor(i / CHUNK_SIZE);
        const cy = Math.floor(j / CHUNK_SIZE);
        const cz = Math.floor(k / CHUNK_SIZE);
        const chunk = this.getOrCreateChunk(cx, cy, cz);
        const li = i - cx * CHUNK_SIZE;
        const lj = j - cy * CHUNK_SIZE;
        const lk = k - cz * CHUNK_SIZE;
        chunk[li + CHUNK_SIZE * (lj + CHUNK_SIZE * lk)] = v;
    }

    // --- Coordinate conversion ---

    worldToVoxel(x, y, z) {
        return { x: x / this.voxelSize, y: y / this.voxelSize, z: z / this.voxelSize };
    }

    voxelToWorld(i, j, k) {
        return { x: i * this.voxelSize, y: j * this.voxelSize, z: k * this.voxelSize };
    }

    // --- Dirty tracking ---

    // Mark all chunks affected by a world AABB. Low-side pad of 1 chunk is
    // needed because chunk N reads its corner[16] = chunk (N+1)'s corner[0];
    // modifying chunk (N+1)'s corner[0] means chunk N's mesh is stale too.
    // No high-side pad is needed.
    markDirtyAABB(minX, minY, minZ, maxX, maxY, maxZ) {
        const vs = this.voxelSize;
        const bs = CHUNK_SIZE;
        const iMin = Math.floor(minX / vs), iMax = Math.ceil(maxX / vs);
        const jMin = Math.floor(minY / vs), jMax = Math.ceil(maxY / vs);
        const kMin = Math.floor(minZ / vs), kMax = Math.ceil(maxZ / vs);

        const cxLo = Math.floor(iMin / bs) - 1;
        const cyLo = Math.floor(jMin / bs) - 1;
        const czLo = Math.floor(kMin / bs) - 1;
        const cxHi = Math.floor(iMax / bs);
        const cyHi = Math.floor(jMax / bs);
        const czHi = Math.floor(kMax / bs);

        for (let cz = czLo; cz <= czHi; cz++) {
            for (let cy = cyLo; cy <= cyHi; cy++) {
                for (let cx = cxLo; cx <= cxHi; cx++) {
                    this.dirtyChunks.add(chunkKey(cx, cy, cz));
                }
            }
        }
    }

    flushDirty(callback) {
        let n = 0;
        for (const key of this.dirtyChunks) {
            const { cx, cy, cz } = unpackKey(key);
            callback(cx, cy, cz);
            n++;
        }
        this.dirtyChunks.clear();
        return n;
    }

    // --- Meshing support ---

    // Build a read-only window giving O(1) access to any corner in local
    // coords [0..16]³ of chunk (cx,cy,cz). Fetches the 8 chunks at
    // (cx..cx+1, cy..cy+1, cz..cz+1) once. Missing chunks → defaultDensity.
    buildChunkWindow(cx, cy, cz) {
        const m = this.chunks;
        const c000 = m.get(chunkKey(cx    , cy    , cz    )) || null;
        const c100 = m.get(chunkKey(cx + 1, cy    , cz    )) || null;
        const c010 = m.get(chunkKey(cx    , cy + 1, cz    )) || null;
        const c110 = m.get(chunkKey(cx + 1, cy + 1, cz    )) || null;
        const c001 = m.get(chunkKey(cx    , cy    , cz + 1)) || null;
        const c101 = m.get(chunkKey(cx + 1, cy    , cz + 1)) || null;
        const c011 = m.get(chunkKey(cx    , cy + 1, cz + 1)) || null;
        const c111 = m.get(chunkKey(cx + 1, cy + 1, cz + 1)) || null;
        const chunks = [c000, c100, c010, c110, c001, c101, c011, c111];
        const def = this.defaultDensity;
        const bs = CHUNK_SIZE;
        return {
            chunkSize: bs,
            // li,lj,lk in [0..bs] inclusive. Local coord = bs rolls to next chunk.
            getCorner(li, lj, lk) {
                const xi = (li >> 4) & 1;
                const yi = (lj >> 4) & 1;
                const zi = (lk >> 4) & 1;
                const chunk = chunks[xi | (yi << 1) | (zi << 2)];
                if (!chunk) return def;
                const x = li & 15;
                const y = lj & 15;
                const z = lk & 15;
                return chunk[x + bs * (y + bs * z)];
            },
        };
    }

    // --- Initialization ---

    // Carve a noisy spherical cavity centered at `center` with ~`radius`.
    // Density = distFromCenter - (radius + fbmDisplacement): positive outside
    // (solid), negative inside (air), zero on the iso-surface. Only populates
    // chunks near the shell; the rest of space stays defaulted to solid rock.
    initHollowCavity({ center, radius, noiseAmp = 0.6, noiseFreq = 0.3 } = {}) {
        const [ccx, ccy, ccz] = center;
        const vs = this.voxelSize;
        const bs = CHUNK_SIZE;
        const margin = radius + noiseAmp + 1.0;

        const cxLo = Math.floor((ccx - margin) / vs / bs);
        const cyLo = Math.floor((ccy - margin) / vs / bs);
        const czLo = Math.floor((ccz - margin) / vs / bs);
        const cxHi = Math.floor((ccx + margin) / vs / bs);
        const cyHi = Math.floor((ccy + margin) / vs / bs);
        const czHi = Math.floor((ccz + margin) / vs / bs);

        for (let cz = czLo; cz <= czHi; cz++) {
            for (let cy = cyLo; cy <= cyHi; cy++) {
                for (let cx = cxLo; cx <= cxHi; cx++) {
                    const chunk = this.getOrCreateChunk(cx, cy, cz);
                    for (let lk = 0; lk < bs; lk++) {
                        const wz = (cz * bs + lk) * vs;
                        const dz = wz - ccz;
                        for (let lj = 0; lj < bs; lj++) {
                            const wy = (cy * bs + lj) * vs;
                            const dy = wy - ccy;
                            for (let li = 0; li < bs; li++) {
                                const wx = (cx * bs + li) * vs;
                                const dx = wx - ccx;
                                const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                                const disp = fbm3D(wx * noiseFreq, wy * noiseFreq, wz * noiseFreq, 4) * noiseAmp;
                                chunk[li + bs * (lj + bs * lk)] = d - (radius + disp);
                            }
                        }
                    }
                    this.dirtyChunks.add(chunkKey(cx, cy, cz));
                }
            }
        }
        // Also dirty the low-side neighbors so their seams update.
        for (let cz = czLo - 1; cz <= czHi; cz++) {
            for (let cy = cyLo - 1; cy <= cyHi; cy++) {
                for (let cx = cxLo - 1; cx <= cxHi; cx++) {
                    this.dirtyChunks.add(chunkKey(cx, cy, cz));
                }
            }
        }
    }
}
