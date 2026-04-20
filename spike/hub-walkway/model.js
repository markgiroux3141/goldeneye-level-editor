// Data model for hub-walkway spike.
//
// Hub: axis-aligned rectangle (the main "rooms" of the level).
//   { id, x, z, sizeX, sizeZ, y, thickness }
//   x, z are MIN corner in WT.
// Walkway: connects two hub edges (can also connect to empty ground-end — not
//   implemented yet). Width is measured perpendicular to the walkway axis.
//   anchor: { hubId, edge: 'xMin'|'xMax'|'zMin'|'zMax', t: 0..1 }
//   { id, anchorA, anchorB, width }
// Flat when hubA.y === hubB.y; stairs when they differ.

export class World {
    constructor() {
        this.hubs = new Map();
        this.walkways = new Map();
        this._nextHubId = 1;
        this._nextWalkwayId = 1;
    }

    addHub(x, z, sizeX, sizeZ, y = 0, thickness = 1) {
        const id = this._nextHubId++;
        const hub = { id, x, z, sizeX, sizeZ, y, thickness };
        this.hubs.set(id, hub);
        return hub;
    }

    addWalkway(anchorA, anchorB, width) {
        const id = this._nextWalkwayId++;
        const w = { id, anchorA, anchorB, width };
        this.walkways.set(id, w);
        return w;
    }

    removeHub(id) {
        this.hubs.delete(id);
        // Cascade: remove walkways referencing this hub.
        for (const [wid, w] of [...this.walkways]) {
            if (w.anchorA.hubId === id || w.anchorB.hubId === id) {
                this.walkways.delete(wid);
            }
        }
    }

    removeWalkway(id) { this.walkways.delete(id); }

    // Walkways incident to a hub.
    walkwaysOfHub(hubId) {
        const arr = [];
        for (const w of this.walkways.values()) {
            if (w.anchorA.hubId === hubId || w.anchorB.hubId === hubId) arr.push(w);
        }
        return arr;
    }
}

// Helpers for working with hub edges and anchors.
export function hubEdgeLine(hub, edge) {
    const maxX = hub.x + hub.sizeX;
    const maxZ = hub.z + hub.sizeZ;
    switch (edge) {
        case 'xMin': return { a: { x: hub.x,  z: hub.z  }, b: { x: hub.x,  z: maxZ } };
        case 'xMax': return { a: { x: maxX,   z: hub.z  }, b: { x: maxX,   z: maxZ } };
        case 'zMin': return { a: { x: hub.x,  z: hub.z  }, b: { x: maxX,   z: hub.z } };
        case 'zMax': return { a: { x: hub.x,  z: maxZ   }, b: { x: maxX,   z: maxZ  } };
    }
    return null;
}

export function edgeNormal(edge) {
    switch (edge) {
        case 'xMin': return { x: -1, z: 0 };
        case 'xMax': return { x:  1, z: 0 };
        case 'zMin': return { x:  0, z: -1 };
        case 'zMax': return { x:  0, z:  1 };
    }
    return { x: 0, z: 0 };
}

// World-space xz of an anchor point (hub edge at offset t).
export function resolveAnchor(world, anchor) {
    const hub = world.hubs.get(anchor.hubId);
    const line = hubEdgeLine(hub, anchor.edge);
    return {
        x: line.a.x + (line.b.x - line.a.x) * anchor.t,
        z: line.a.z + (line.b.z - line.a.z) * anchor.t,
        y: hub.y,
    };
}

// Pick hub edge closest to point pt. Returns { hub, edge, t, dist } or null if too far.
export function pickHubEdge(world, pt, maxDist = 1.5) {
    let best = null;
    let bestDist = maxDist;
    for (const hub of world.hubs.values()) {
        for (const edge of ['xMin', 'xMax', 'zMin', 'zMax']) {
            const line = hubEdgeLine(hub, edge);
            const dx = line.b.x - line.a.x;
            const dz = line.b.z - line.a.z;
            const len2 = dx * dx + dz * dz;
            if (len2 < 1e-6) continue;
            const len = Math.sqrt(len2);
            const ax = dx / len, az = dz / len;
            const px = pt.x - line.a.x, pz = pt.z - line.a.z;
            const along = Math.max(0, Math.min(len, px * ax + pz * az));
            const foot = { x: line.a.x + along * ax, z: line.a.z + along * az };
            const d = Math.hypot(pt.x - foot.x, pt.z - foot.z);
            if (d < bestDist) {
                bestDist = d;
                best = {
                    hub, edge, t: along / len,
                    foot, dist: d,
                };
            }
        }
    }
    return best;
}

// Point-in-hub test (AABB).
export function pointInHub(hub, pt) {
    return pt.x >= hub.x && pt.x <= hub.x + hub.sizeX &&
           pt.z >= hub.z && pt.z <= hub.z + hub.sizeZ;
}

export function pickHubContaining(world, pt) {
    for (const hub of world.hubs.values()) {
        if (pointInHub(hub, pt)) return hub;
    }
    return null;
}
