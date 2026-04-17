// 3D density field: Float32Array with 1 scalar per voxel corner sample.
// Convention: density > 0 = solid, density < 0 = air, iso-surface at 0.
//
// Partitioned into fixed-size "blocks" so brush strokes only re-mesh the
// blocks they touch. Each block is BLOCK_SIZE cells on a side. A block that
// owns cells [bi*BS .. bi*BS+BS) reads corner samples [bi*BS .. bi*BS+BS]
// (inclusive on max side) — that +1 overlap with the neighbor block is
// what avoids seams without explicit stitching.

import { fbm3D } from './noise3D.js';

export class DensityField {
    constructor({ resolution = 64, voxelSize = 0.2, blockSize = 16, origin = [0, 0, 0] } = {}) {
        this.res = resolution;                // number of CELLS per axis; corner samples = res+1
        this.corners = resolution + 1;         // corner-sample count per axis
        this.voxelSize = voxelSize;
        this.blockSize = blockSize;
        this.blocksPerAxis = resolution / blockSize;
        if (!Number.isInteger(this.blocksPerAxis)) {
            throw new Error(`resolution (${resolution}) must be a multiple of blockSize (${blockSize})`);
        }
        this.origin = origin.slice(); // world-space position of sample (0,0,0)

        // Samples are corner-indexed: corners^3 floats.
        this.data = new Float32Array(this.corners * this.corners * this.corners);

        // Dirty set, one boolean per block.
        const nBlocks = this.blocksPerAxis ** 3;
        this.dirty = new Uint8Array(nBlocks);
    }

    idx(i, j, k) {
        return i + this.corners * (j + this.corners * k);
    }

    get(i, j, k) {
        return this.data[i + this.corners * (j + this.corners * k)];
    }

    set(i, j, k, v) {
        this.data[i + this.corners * (j + this.corners * k)] = v;
    }

    blockIdx(bi, bj, bk) {
        return bi + this.blocksPerAxis * (bj + this.blocksPerAxis * bk);
    }

    // World-space <-> sample-index-space.
    worldToVoxel(x, y, z) {
        return {
            x: (x - this.origin[0]) / this.voxelSize,
            y: (y - this.origin[1]) / this.voxelSize,
            z: (z - this.origin[2]) / this.voxelSize,
        };
    }

    voxelToWorld(i, j, k) {
        return {
            x: this.origin[0] + i * this.voxelSize,
            y: this.origin[1] + j * this.voxelSize,
            z: this.origin[2] + k * this.voxelSize,
        };
    }

    // World-space AABB of the whole field (min, max corners).
    getWorldBounds() {
        const s = this.res * this.voxelSize;
        return {
            min: [this.origin[0], this.origin[1], this.origin[2]],
            max: [this.origin[0] + s, this.origin[1] + s, this.origin[2] + s],
        };
    }

    // Mark blocks as dirty that overlap a world-space AABB.
    // Includes adjacent blocks on edge touches to avoid visible pops.
    markDirtyAABB(minX, minY, minZ, maxX, maxY, maxZ) {
        const vMin = this.worldToVoxel(minX, minY, minZ);
        const vMax = this.worldToVoxel(maxX, maxY, maxZ);

        const bs = this.blockSize;
        const nb = this.blocksPerAxis;

        const biMin = Math.max(0, Math.floor(vMin.x / bs) - 1);
        const bjMin = Math.max(0, Math.floor(vMin.y / bs) - 1);
        const bkMin = Math.max(0, Math.floor(vMin.z / bs) - 1);
        const biMax = Math.min(nb - 1, Math.floor(vMax.x / bs));
        const bjMax = Math.min(nb - 1, Math.floor(vMax.y / bs));
        const bkMax = Math.min(nb - 1, Math.floor(vMax.z / bs));

        for (let bk = bkMin; bk <= bkMax; bk++) {
            for (let bj = bjMin; bj <= bjMax; bj++) {
                for (let bi = biMin; bi <= biMax; bi++) {
                    this.dirty[this.blockIdx(bi, bj, bk)] = 1;
                }
            }
        }
    }

    markAllDirty() {
        this.dirty.fill(1);
    }

    // Consume the dirty set. callback(bi, bj, bk) is invoked for each dirty block.
    // Returns count of blocks flushed.
    flushDirty(callback) {
        let n = 0;
        const nb = this.blocksPerAxis;
        for (let bk = 0; bk < nb; bk++) {
            for (let bj = 0; bj < nb; bj++) {
                for (let bi = 0; bi < nb; bi++) {
                    const idx = this.blockIdx(bi, bj, bk);
                    if (this.dirty[idx]) {
                        callback(bi, bj, bk);
                        this.dirty[idx] = 0;
                        n++;
                    }
                }
            }
        }
        return n;
    }

    // Initialize as lumpy rock volume:
    //   base > 0 throughout (solid), with large-scale FBM perturbation
    //   and a soft fade near the outer surfaces so the edges look rounded/eroded.
    initLumpyRock({ base = 1.0, fbmAmp = 0.6, fbmFreq = 0.04 } = {}) {
        const c = this.corners;
        const data = this.data;
        const vs = this.voxelSize;
        const ox = this.origin[0], oy = this.origin[1], oz = this.origin[2];
        const sizeWorld = this.res * vs;
        const centerX = ox + sizeWorld / 2;
        const centerY = oy + sizeWorld / 2;
        const centerZ = oz + sizeWorld / 2;
        const halfSize = sizeWorld / 2;

        for (let k = 0; k < c; k++) {
            for (let j = 0; j < c; j++) {
                for (let i = 0; i < c; i++) {
                    const wx = ox + i * vs;
                    const wy = oy + j * vs;
                    const wz = oz + k * vs;

                    // Soft erosion toward the outer faces of the cube — produces
                    // a rounded rocky lump rather than a perfect cube.
                    const ndx = (wx - centerX) / halfSize;
                    const ndy = (wy - centerY) / halfSize;
                    const ndz = (wz - centerZ) / halfSize;
                    const r = Math.max(Math.abs(ndx), Math.abs(ndy), Math.abs(ndz));
                    const edgeFade = 1 - Math.max(0, (r - 0.65) / 0.35); // 1 inside, 0 at the cube surface

                    const n = fbm3D(wx * fbmFreq, wy * fbmFreq, wz * fbmFreq, 4);
                    const v = base * edgeFade + fbmAmp * n;

                    data[i + c * (j + c * k)] = v;
                }
            }
        }
        this.markAllDirty();
    }
}
