// Connection — a shared opening between two volumes (or an open exit)
// Replaces the old door concept. A connection defines where volumes connect.

import { WALL_THICKNESS, WORLD_SCALE } from './Volume.js';

// A connection links two volumes through a wall opening
// volBId can be null if the exit hasn't been extended yet
export function createConnection(id, volAId, axis, sideOnA, bounds, volBId) {
    return {
        id,
        volAId,             // volume where the opening was cut
        volBId: volBId || null,  // volume on the other side (null = unconnected exit)
        axis,               // 'x' | 'z' — which axis the wall is on
        sideOnA,            // 'min' | 'max' — which side of volA
        bounds,             // { u0, u1, v0, v1 } — opening bounds in world space
    };
}

// Compute door placement from a hit point on a volume's wall
export function computeDoorPlacement(vol, axis, side, hitPoint, doorWidth, doorHeight) {
    if (axis === 'y') return null; // no doors on floor/ceiling

    let faceW, faceH, localU;

    // hitPoint is in Three.js world space — convert to WT units
    const hx = hitPoint.x / WORLD_SCALE;
    const hz = hitPoint.z / WORLD_SCALE;

    if (axis === 'x') {
        faceW = vol.d; faceH = vol.h;
        localU = hz - vol.z;
    } else {
        faceW = vol.w; faceH = vol.h;
        localU = hx - vol.x;
    }

    if (faceW < doorWidth || faceH < doorHeight) return null;

    let doorU = Math.round(localU - doorWidth / 2);
    doorU = Math.max(0, Math.min(faceW - doorWidth, doorU));

    // Convert to world-space bounds
    let u0, u1, v0, v1;
    if (axis === 'x') {
        u0 = vol.z + doorU; u1 = u0 + doorWidth;
        v0 = vol.y; v1 = v0 + doorHeight;
    } else {
        u0 = vol.x + doorU; u1 = u0 + doorWidth;
        v0 = vol.y; v1 = v0 + doorHeight;
    }

    return { u0, u1, v0, v1 };
}

// Check if a connection already exists at these bounds on this face
export function connectionExistsAt(connections, volId, axis, side, bounds) {
    return connections.some(c =>
        c.volAId === volId && c.axis === axis && c.sideOnA === side &&
        c.bounds.u0 === bounds.u0 && c.bounds.u1 === bounds.u1 &&
        c.bounds.v0 === bounds.v0 && c.bounds.v1 === bounds.v1
    );
}

// Get all connections affecting a specific face of a volume
export function getConnectionsForFace(connections, volId, axis, side) {
    return connections.filter(c => {
        if (c.volAId === volId && c.axis === axis && c.sideOnA === side) return true;
        // Also check if this volume is on the B side
        if (c.volBId === volId && c.axis === axis) {
            const oppSide = c.sideOnA === 'min' ? 'max' : 'min';
            if (oppSide === side) return true;
        }
        return false;
    });
}
