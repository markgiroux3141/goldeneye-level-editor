// subdivide.js — Adaptive per-quad subdivision.
// Each quad can have its own subdivision level N (1=no change, 2=4 sub-quads, 4=16, etc.)
// Adapted from src/lighting/subdivide.js with per-quad level support.

import * as THREE from 'three';

function bilerp3(p0, p1, p2, p3, u, v) {
    return [
        (1 - u) * (1 - v) * p0[0] + u * (1 - v) * p1[0] + u * v * p2[0] + (1 - u) * v * p3[0],
        (1 - u) * (1 - v) * p0[1] + u * (1 - v) * p1[1] + u * v * p2[1] + (1 - u) * v * p3[1],
        (1 - u) * (1 - v) * p0[2] + u * (1 - v) * p1[2] + u * v * p2[2] + (1 - u) * v * p3[2],
    ];
}

/**
 * Subdivide a BufferGeometry with per-quad subdivision levels.
 *
 * @param {THREE.BufferGeometry} srcGeo - Source geometry (4 verts per quad)
 * @param {number|number[]} levels - Single N for all quads, or per-quad array
 * @returns {THREE.BufferGeometry}
 */
export function subdivideGeometry(srcGeo, levels) {
    const srcPos = srcGeo.getAttribute('position');
    const srcNor = srcGeo.getAttribute('normal');
    const numQuads = srcPos.count / 4;

    // Normalize levels to per-quad array
    const perQuad = typeof levels === 'number'
        ? new Array(numQuads).fill(levels)
        : levels;

    // Count total sub-quads
    let totalSubQuads = 0;
    for (let q = 0; q < numQuads; q++) {
        const n = perQuad[q] || 1;
        totalSubQuads += n * n;
    }

    // Allocate output
    const positions = new Float32Array(totalSubQuads * 4 * 3);
    const normals = new Float32Array(totalSubQuads * 4 * 3);
    const colorArr = new Float32Array(totalSubQuads * 4 * 3);
    const indices = new Uint32Array(totalSubQuads * 6);

    let vOff = 0;
    let sqIdx = 0;

    for (let q = 0; q < numQuads; q++) {
        const N = perQuad[q] || 1;
        const base = q * 4;

        const p0 = [srcPos.getX(base), srcPos.getY(base), srcPos.getZ(base)];
        const p1 = [srcPos.getX(base + 1), srcPos.getY(base + 1), srcPos.getZ(base + 1)];
        const p2 = [srcPos.getX(base + 2), srcPos.getY(base + 2), srcPos.getZ(base + 2)];
        const p3 = [srcPos.getX(base + 3), srcPos.getY(base + 3), srcPos.getZ(base + 3)];

        const nx = srcNor.getX(base), ny = srcNor.getY(base), nz = srcNor.getZ(base);

        for (let j = 0; j < N; j++) {
            for (let i = 0; i < N; i++) {
                const u0 = i / N, u1 = (i + 1) / N;
                const v0 = j / N, v1 = (j + 1) / N;

                const corners = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
                for (let k = 0; k < 4; k++) {
                    const [u, v] = corners[k];
                    const sp = bilerp3(p0, p1, p2, p3, u, v);
                    const pIdx = (vOff + k) * 3;
                    positions[pIdx] = sp[0]; positions[pIdx + 1] = sp[1]; positions[pIdx + 2] = sp[2];
                    normals[pIdx] = nx; normals[pIdx + 1] = ny; normals[pIdx + 2] = nz;

                    const cIdx = (vOff + k) * 3;
                    colorArr[cIdx] = 1; colorArr[cIdx + 1] = 1; colorArr[cIdx + 2] = 1;
                }

                const iIdx = sqIdx * 6;
                indices[iIdx] = vOff; indices[iIdx + 1] = vOff + 1; indices[iIdx + 2] = vOff + 2;
                indices[iIdx + 3] = vOff; indices[iIdx + 4] = vOff + 2; indices[iIdx + 5] = vOff + 3;

                vOff += 4;
                sqIdx++;
            }
        }
    }

    const newGeo = new THREE.BufferGeometry();
    newGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    newGeo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    newGeo.setAttribute('color', new THREE.Float32BufferAttribute(colorArr, 3));
    newGeo.setIndex(new THREE.BufferAttribute(indices, 1));
    return newGeo;
}

/**
 * Build a BufferGeometry from an array of { a, b, c } Vector3 triangles + a normal.
 * Used after splitTrisAtAxis to convert triangles back to a renderable geometry.
 */
export function trianglesToGeometry(tris, faceNormal) {
    const posArr = new Float32Array(tris.length * 3 * 3);
    const norArr = new Float32Array(tris.length * 3 * 3);
    const colArr = new Float32Array(tris.length * 3 * 3);
    const idxArr = new Uint32Array(tris.length * 3);

    for (let i = 0; i < tris.length; i++) {
        const { a, b, c } = tris[i];
        const base = i * 3;
        const p = base * 3;

        posArr[p]   = a.x; posArr[p+1] = a.y; posArr[p+2] = a.z;
        posArr[p+3] = b.x; posArr[p+4] = b.y; posArr[p+5] = b.z;
        posArr[p+6] = c.x; posArr[p+7] = c.y; posArr[p+8] = c.z;

        // Use provided face normal (or compute from triangle)
        let nx, ny, nz;
        if (faceNormal) {
            nx = faceNormal.x; ny = faceNormal.y; nz = faceNormal.z;
        } else {
            const e1x = b.x - a.x, e1y = b.y - a.y, e1z = b.z - a.z;
            const e2x = c.x - a.x, e2y = c.y - a.y, e2z = c.z - a.z;
            nx = e1y * e2z - e1z * e2y;
            ny = e1z * e2x - e1x * e2z;
            nz = e1x * e2y - e1y * e2x;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
            nx /= len; ny /= len; nz /= len;
        }

        for (let k = 0; k < 3; k++) {
            norArr[p + k * 3] = nx;
            norArr[p + k * 3 + 1] = ny;
            norArr[p + k * 3 + 2] = nz;
            colArr[p + k * 3] = 1;
            colArr[p + k * 3 + 1] = 1;
            colArr[p + k * 3 + 2] = 1;
        }

        idxArr[base]   = base;
        idxArr[base+1] = base + 1;
        idxArr[base+2] = base + 2;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(norArr, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colArr, 3));
    geo.setIndex(new THREE.BufferAttribute(idxArr, 1));
    return geo;
}
