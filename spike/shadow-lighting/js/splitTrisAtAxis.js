// splitTrisAtAxis.js — Split triangles along an axis-aligned plane.
// Adapted from src/core/csg/uvZones.js for standalone use.

import * as THREE from 'three';

// Interpolate between two Vector3s at a given axis value
function lerpAtAxis(a, b, axis, val) {
    const av = a[axis], bv = b[axis];
    const t = (val - av) / (bv - av);
    return new THREE.Vector3(
        a.x + (b.x - a.x) * t,
        a.y + (b.y - a.y) * t,
        a.z + (b.z - a.z) * t,
    );
}

// Split an array of triangles along axis=value plane.
// Each triangle is { a, b, c } of Vector3.
// Returns expanded array of triangles.
export function splitTrisAtAxis(tris, splitAxis, val) {
    const result = [];
    const getVal = v => v[splitAxis];

    for (const tri of tris) {
        const verts = [tri.a, tri.b, tri.c];
        const vals = verts.map(getVal);
        const minV = Math.min(vals[0], vals[1], vals[2]);
        const maxV = Math.max(vals[0], vals[1], vals[2]);

        // Triangle entirely on one side — keep as-is
        if (maxV <= val + 1e-6 || minV >= val - 1e-6) {
            result.push(tri);
            continue;
        }

        // Sort vertices by axis value
        const sorted = verts.slice().sort((a, b) => getVal(a) - getVal(b));
        const [lo, mid, hi] = sorted;
        const pLoHi = lerpAtAxis(lo, hi, splitAxis, val);

        if (getVal(mid) <= val) {
            const pMidHi = lerpAtAxis(mid, hi, splitAxis, val);
            result.push({ a: lo, b: mid, c: pLoHi });
            result.push({ a: mid, b: pMidHi, c: pLoHi });
            result.push({ a: pLoHi, b: pMidHi, c: hi });
        } else {
            const pLoMid = lerpAtAxis(lo, mid, splitAxis, val);
            result.push({ a: lo, b: pLoMid, c: pLoHi });
            result.push({ a: pLoMid, b: mid, c: pLoHi });
            result.push({ a: mid, b: hi, c: pLoHi });
        }
    }
    return result;
}
