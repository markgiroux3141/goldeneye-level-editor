// geometry.js — Build test scene geometry as quad-based BufferGeometry.
// Each quad = 4 non-shared vertices + 6 indices (matching editor convention).

import * as THREE from 'three';

// Build a quad from 4 corner positions, returns { positions, normals, uvs, indices }
// Normal is computed from cross(p1-p0, p3-p0).
function quad(p0, p1, p2, p3, baseVertex) {
    const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const e2 = [p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    const nz = e1[0] * e2[1] - e1[1] * e2[0];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    const n = [nx / len, ny / len, nz / len];

    return {
        positions: [...p0, ...p1, ...p2, ...p3],
        normals: [...n, ...n, ...n, ...n],
        uvs: [0, 0, 1, 0, 1, 1, 0, 1],
        indices: [baseVertex, baseVertex + 1, baseVertex + 2, baseVertex, baseVertex + 2, baseVertex + 3],
    };
}

// Build a BufferGeometry from an array of quads.
// baseVertexOffset allows multiple buildGeometry calls to share an index space
// (not needed here but kept for flexibility).
function buildGeometry(quads) {
    const allPos = [], allNor = [], allUv = [], allCol = [], allIdx = [];
    for (const q of quads) {
        allPos.push(...q.positions);
        allNor.push(...q.normals);
        allUv.push(...q.uvs);
        allCol.push(1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1); // 4 verts × RGB white
        allIdx.push(...q.indices);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(allPos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(allNor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(allUv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(allCol, 3));
    geo.setIndex(allIdx);
    return geo;
}

// Build an axis-aligned box as 6 quads (inward-facing normals for rooms, outward for platforms)
function buildBox(cx, cy, cz, w, h, d, inward = false) {
    const hw = w / 2, hh = h / 2, hd = d / 2;
    const x0 = cx - hw, x1 = cx + hw;
    const y0 = cy - hh, y1 = cy + hh;
    const z0 = cz - hd, z1 = cz + hd;

    const quads = [];
    let base = 0;

    // Floor (y = y0): inward normal = +y (up into room)
    if (inward) {
        quads.push(quad([x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0], base));
    } else {
        quads.push(quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], base));
    }
    base += 4;

    // Ceiling (y = y1): inward normal = -y
    if (inward) {
        quads.push(quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], base));
    } else {
        quads.push(quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], base));
    }
    base += 4;

    // Front wall (z = z1): inward normal = -z
    if (inward) {
        quads.push(quad([x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1], base));
    } else {
        quads.push(quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], base));
    }
    base += 4;

    // Back wall (z = z0): inward normal = +z
    if (inward) {
        quads.push(quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], base));
    } else {
        quads.push(quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], base));
    }
    base += 4;

    // Left wall (x = x0): inward normal = +x
    if (inward) {
        quads.push(quad([x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1], base));
    } else {
        quads.push(quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], base));
    }
    base += 4;

    // Right wall (x = x1): inward normal = -x
    if (inward) {
        quads.push(quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], base));
    } else {
        quads.push(quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], base));
    }

    return quads;
}

// Build a wall with a door opening on the X axis (wall at x=wallX, spanning z and y).
function buildWallWithDoorX(z0, z1, y0, y1, wallX, dz0, dz1, doorTop, normalSign, startBase) {
    const quads = [];
    let base = startBase;
    const x = wallX;

    if (normalSign > 0) {
        // Normal = +x: vertices go z1→z0 (so cross product gives +x)
        // Top strip
        quads.push(quad([x, doorTop, z1], [x, doorTop, z0], [x, y1, z0], [x, y1, z1], base));
        base += 4;
        // Left pillar (high z side)
        if (dz1 < z1 - 0.01) {
            quads.push(quad([x, y0, z1], [x, y0, dz1], [x, doorTop, dz1], [x, doorTop, z1], base));
            base += 4;
        }
        // Right pillar (low z side)
        if (dz0 > z0 + 0.01) {
            quads.push(quad([x, y0, dz0], [x, y0, z0], [x, doorTop, z0], [x, doorTop, dz0], base));
            base += 4;
        }
    } else {
        // Normal = -x: vertices go z0→z1
        quads.push(quad([x, doorTop, z0], [x, doorTop, z1], [x, y1, z1], [x, y1, z0], base));
        base += 4;
        if (dz0 > z0 + 0.01) {
            quads.push(quad([x, y0, z0], [x, y0, dz0], [x, doorTop, dz0], [x, doorTop, z0], base));
            base += 4;
        }
        if (dz1 < z1 - 0.01) {
            quads.push(quad([x, y0, dz1], [x, y0, z1], [x, doorTop, z1], [x, doorTop, dz1], base));
            base += 4;
        }
    }

    return { quads, nextBase: base };
}

// Build the test scene: two rooms connected by a doorway
export function buildTestScene() {
    // Room A (left): 16 × 10 × 16, centered at (-10, 5, 0)
    // Room B (right): 16 × 10 × 16, centered at (10, 5, 0)
    // Shared wall at x = 2, with a door opening
    // Door: z = [-2, 2], y = [0, 7]

    const roomQuads = [];
    let base = 0;

    // --- Room A: x = [-18, 2], y = [0, 10], z = [-8, 8] ---
    const ax0 = -18, ax1 = 2, ay0 = 0, ay1 = 10, az0 = -8, az1 = 8;

    // Floor A
    roomQuads.push(quad([ax0, ay0, az1], [ax1, ay0, az1], [ax1, ay0, az0], [ax0, ay0, az0], base)); base += 4;
    // Ceiling A
    roomQuads.push(quad([ax0, ay1, az0], [ax1, ay1, az0], [ax1, ay1, az1], [ax0, ay1, az1], base)); base += 4;
    // Front wall A (z=8, normal -z)
    roomQuads.push(quad([ax1, ay0, az1], [ax0, ay0, az1], [ax0, ay1, az1], [ax1, ay1, az1], base)); base += 4;
    // Back wall A (z=-8, normal +z)
    roomQuads.push(quad([ax0, ay0, az0], [ax1, ay0, az0], [ax1, ay1, az0], [ax0, ay1, az0], base)); base += 4;
    // Left wall A (x=-18, normal +x)
    roomQuads.push(quad([ax0, ay0, az1], [ax0, ay0, az0], [ax0, ay1, az0], [ax0, ay1, az1], base)); base += 4;
    // Right wall A (x=2, normal -x) — has door opening
    {
        const res = buildWallWithDoorX(az0, az1, ay0, ay1, ax1, -2, 2, 7, -1, base);
        roomQuads.push(...res.quads);
        base = res.nextBase;
    }

    // --- Room B: x = [2, 22], y = [0, 10], z = [-8, 8] ---
    const bx0 = 2, bx1 = 22, by0 = 0, by1 = 10, bz0 = -8, bz1 = 8;

    // Floor B
    roomQuads.push(quad([bx0, by0, bz1], [bx1, by0, bz1], [bx1, by0, bz0], [bx0, by0, bz0], base)); base += 4;
    // Ceiling B
    roomQuads.push(quad([bx0, by1, bz0], [bx1, by1, bz0], [bx1, by1, bz1], [bx0, by1, bz1], base)); base += 4;
    // Front wall B (z=8, normal -z)
    roomQuads.push(quad([bx1, by0, bz1], [bx0, by0, bz1], [bx0, by1, bz1], [bx1, by1, bz1], base)); base += 4;
    // Back wall B (z=-8, normal +z)
    roomQuads.push(quad([bx0, by0, bz0], [bx1, by0, bz0], [bx1, by1, bz0], [bx0, by1, bz0], base)); base += 4;
    // Left wall B (x=2, normal +x) — has door opening
    {
        const res = buildWallWithDoorX(bz0, bz1, by0, by1, bx0, -2, 2, 7, +1, base);
        roomQuads.push(...res.quads);
        base = res.nextBase;
    }
    // Right wall B (x=22, normal -x)
    roomQuads.push(quad([bx1, ay0, bz0], [bx1, ay0, bz1], [bx1, ay1, bz1], [bx1, ay1, bz0], base)); base += 4;

    const roomGeo = buildGeometry(roomQuads);

    // Door frame pieces (act as occluders for shadow casting)
    // Top lintel: spans the door width, sits above the opening
    const lintelQuads = buildBox(2, 8.5, 0, 1.0, 3, 4.2, false);
    const lintelGeo = buildGeometry(lintelQuads);
    const lintelAABB = { minX: 1.5, maxX: 2.5, minY: 7, maxY: 10, minZ: -2.1, maxZ: 2.1 };

    // Left door jamb
    const ljQuads = buildBox(2, 3.5, -3.1, 1.0, 7, 2.0, false);
    const ljGeo = buildGeometry(ljQuads);
    const ljAABB = { minX: 1.5, maxX: 2.5, minY: 0, maxY: 7, minZ: -4.1, maxZ: -2.1 };

    // Right door jamb
    const rjQuads = buildBox(2, 3.5, 3.1, 1.0, 7, 2.0, false);
    const rjGeo = buildGeometry(rjQuads);
    const rjAABB = { minX: 1.5, maxX: 2.5, minY: 0, maxY: 7, minZ: 2.1, maxZ: 4.1 };

    // A table/platform inside Room A
    const tableQuads = buildBox(-10, 1.5, 0, 5, 3, 4, false);
    const tableGeo = buildGeometry(tableQuads);
    const tableAABB = { minX: -12.5, maxX: -7.5, minY: 0, maxY: 3, minZ: -2, maxZ: 2 };

    return {
        room: { geometry: roomGeo, quads: roomQuads },
        platforms: [
            { geometry: lintelGeo, quads: lintelQuads, aabb: lintelAABB },
            { geometry: ljGeo, quads: ljQuads, aabb: ljAABB },
            { geometry: rjGeo, quads: rjQuads, aabb: rjAABB },
            { geometry: tableGeo, quads: tableQuads, aabb: tableAABB },
        ],
    };
}

// Default lights — one in each room
export function defaultLights() {
    return [
        // Bright warm light in Room A (the lit room)
        { x: -8, y: 8, z: 0, color: { r: 1, g: 0.9, b: 0.7 }, intensity: 5.0, range: 25, enabled: true },
        // Dim cool light in Room B (the dark room receiving door light)
        { x: 14, y: 8, z: 0, color: { r: 0.5, g: 0.6, b: 0.8 }, intensity: 1.5, range: 18, enabled: true },
    ];
}
