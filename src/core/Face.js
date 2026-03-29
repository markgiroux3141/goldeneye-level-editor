// Face identity, bounds helpers, and comparison
// Shared by geometry, actions, and any module that works with face data.
// No Three.js dependency — pure data.

export function facesMatch(a, b) {
    if (!a || !b) return false;
    return a.volumeId === b.volumeId &&
           a.axis === b.axis &&
           a.side === b.side &&
           a.position === b.position &&
           a.bounds.u0 === b.bounds.u0 &&
           a.bounds.u1 === b.bounds.u1 &&
           a.bounds.v0 === b.bounds.v0 &&
           a.bounds.v1 === b.bounds.v1;
}

// Get tangent axis ranges for a face:
// axis 'x': u = z, v = y
// axis 'y': u = x, v = z
// axis 'z': u = x, v = y
export function getVolumeFaceBounds(vol, axis) {
    if (axis === 'x') return { u0: vol.z, u1: vol.z + vol.d, v0: vol.y, v1: vol.y + vol.h };
    if (axis === 'y') return { u0: vol.x, u1: vol.x + vol.w, v0: vol.z, v1: vol.z + vol.d };
    return { u0: vol.x, u1: vol.x + vol.w, v0: vol.y, v1: vol.y + vol.h };
}

export function getFacePosition(vol, axis, side) {
    if (axis === 'x') return side === 'min' ? vol.x : vol.x + vol.w;
    if (axis === 'y') return side === 'min' ? vol.y : vol.y + vol.h;
    return side === 'min' ? vol.z : vol.z + vol.d;
}
