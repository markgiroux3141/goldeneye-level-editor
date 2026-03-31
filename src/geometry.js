// Low-level mesh builder: raw vertices, triangles, UVs
// Every room = ONE BufferGeometry + faceId lookup table
// A room is a hollow rectangular prism — 6 flat inner-face quads.
// Wall thickness only manifests visually through door tunnels.
//
// FACE MODEL: Every selectable quad is a face with uniform structure:
//   { roomId, axis, side, position, bounds: { u0, u1, v0, v1 } }
// No type tags. Geometry determines behavior.
//
// NORMALS: Derived from winding order (cross product of triangle edges).
// Winding is the single source of truth, like Blender.

import * as THREE from 'three';
import { WALL_THICKNESS, WORLD_SCALE } from './core/Volume.js';
import { facesMatch, getVolumeFaceBounds, getFacePosition } from './core/Face.js';

// Re-export for any consumers that imported facesMatch from here
export { facesMatch };

const S = WORLD_SCALE; // shorthand for vertex scaling

// ============================================================
// GEOMETRY BUILDER
// ============================================================
class GeometryBuilder {
    constructor() {
        this.positions = [];
        this.normals = [];
        this.uvs = [];
        this.colors = [];
        this.indices = [];
        this.faceIds = [];
        this.zones = [];     // material zone per quad
        this.vertexCount = 0;
        this.quadCount = 0;
    }

    addQuad(p0, p1, p2, p3, uv0, uv1, uv2, uv3, faceId, highlight, flip = false, zone = 0) {
        const base = this.vertexCount;

        // Flip reverses winding by swapping p1↔p3 (and their UVs)
        const [vp1, vp3] = flip ? [p3, p1] : [p1, p3];
        const [vuv1, vuv3] = flip ? [uv3, uv1] : [uv1, uv3];

        this.positions.push(
            p0[0]*S, p0[1]*S, p0[2]*S, vp1[0]*S, vp1[1]*S, vp1[2]*S,
            p2[0]*S, p2[1]*S, p2[2]*S, vp3[0]*S, vp3[1]*S, vp3[2]*S,
        );
        this.uvs.push(
            uv0[0], uv0[1], vuv1[0], vuv1[1],
            uv2[0], uv2[1], vuv3[0], vuv3[1],
        );

        // Auto-compute normal from winding (cross product of first triangle edges)
        const e1x = vp1[0] - p0[0], e1y = vp1[1] - p0[1], e1z = vp1[2] - p0[2];
        const e2x = p2[0] - p0[0], e2y = p2[1] - p0[1], e2z = p2[2] - p0[2];
        let nx = e1y * e2z - e1z * e2y;
        let ny = e1z * e2x - e1x * e2z;
        let nz = e1x * e2y - e1y * e2x;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len > 0) { nx /= len; ny /= len; nz /= len; }
        for (let i = 0; i < 4; i++) this.normals.push(nx, ny, nz);

        const r = highlight ? 0.4 : 1.0;
        const g = highlight ? 1.0 : 1.0;
        const b = highlight ? 0.4 : 1.0;
        for (let i = 0; i < 4; i++) this.colors.push(r, g, b);

        this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        this.faceIds.push(faceId, faceId);
        this.zones.push(zone);
        this.vertexCount += 4;
        this.quadCount++;
    }

    build() {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
        geo.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));

        // Check if we need material groups (multiple zones)
        const uniqueZones = new Set(this.zones);
        if (uniqueZones.size <= 1) {
            // Single zone — no reordering needed
            geo.setIndex(this.indices);
            if (uniqueZones.size === 1) {
                const z = this.zones[0];
                geo.addGroup(0, this.indices.length, z);
            }
            return geo;
        }

        // Multiple zones — reorder indices by zone and emit groups
        // Build array of { quadIndex, zone } then sort by zone
        const quads = this.zones.map((z, i) => ({ idx: i, zone: z }));
        quads.sort((a, b) => a.zone - b.zone);

        const newIndices = [];
        const newFaceIds = [];

        for (const q of quads) {
            const srcIdx = q.idx * 6;
            for (let j = 0; j < 6; j++) newIndices.push(this.indices[srcIdx + j]);
            const srcFace = q.idx * 2;
            newFaceIds.push(this.faceIds[srcFace], this.faceIds[srcFace + 1]);
        }

        geo.setIndex(newIndices);

        // Emit groups per zone
        let groupStart = 0;
        let currentZone = quads[0].zone;
        let groupCount = 0;

        for (const q of quads) {
            if (q.zone !== currentZone) {
                geo.addGroup(groupStart, groupCount, currentZone);
                groupStart += groupCount;
                groupCount = 0;
                currentZone = q.zone;
            }
            groupCount += 6; // 6 indices per quad (2 triangles)
        }
        geo.addGroup(groupStart, groupCount, currentZone);

        // Replace faceIds with reordered version
        this.faceIds = newFaceIds;

        return geo;
    }
}

// ============================================================
// WINDING HELPERS
// ============================================================

// The default vertex patterns produce these cross-product directions:
//   x-axis → -x,   y-axis → -y,   z-axis → +z
//
// For inward-facing walls, the sides where the natural cross product
// disagrees with the inward normal need a winding correction (flip).
function wallNeedsWindingFix(axis, side) {
    return (axis === 'x' && side === 'min') ||
           (axis === 'y' && side === 'min') ||
           (axis === 'z' && side === 'max');
}

// ============================================================
// VOLUME GEOMETRY GENERATION
// ============================================================

// Build geometry for a single volume.
// faceConnections: array of connections affecting this volume's faces
// options: { viewMode: 'grid'|'textured', wallSplitV: number }
export function buildVolumeGeometry(vol, faceConnections, selectedFace, options = {}) {
    const builder = new GeometryBuilder();

    const faces = [
        { axis: 'x', side: 'min' }, { axis: 'x', side: 'max' },
        { axis: 'y', side: 'min' }, { axis: 'y', side: 'max' },
        { axis: 'z', side: 'min' }, { axis: 'z', side: 'max' },
    ];

    const flip = !!vol.invertNormals;

    for (const face of faces) {
        // Find connections on this face
        const conns = faceConnections.filter(c => {
            if (c.volAId === vol.id && c.axis === face.axis && c.sideOnA === face.side) return true;
            if (c.volBId === vol.id && c.axis === face.axis) {
                const oppSide = c.sideOnA === 'min' ? 'max' : 'min';
                if (oppSide === face.side) return true;
            }
            return false;
        });
        buildFace(builder, vol, face.axis, face.side, conns, selectedFace, flip, options);
    }

    return { geometry: builder.build(), faceIds: builder.faceIds };
}

// ============================================================
// ZONE HELPERS
// ============================================================

function getFaceZone(axis, side, options) {
    if (options.viewMode !== 'textured') return 0;
    if (axis === 'y' && side === 'min') return 0;  // floor
    if (axis === 'y' && side === 'max') return 1;   // ceiling
    return 2; // walls default to lower wall zone (split handles upper)
}

// ============================================================
// FACE BUILDERS
// ============================================================

function buildFace(builder, vol, axis, side, connections, selectedFace, flip, options) {
    if (connections.length === 0) {
        buildSolidFace(builder, vol, axis, side, selectedFace, flip, options);
    } else {
        buildFaceWithConnections(builder, vol, axis, side, connections, selectedFace, flip, options);
    }
}

function buildSolidFace(builder, vol, axis, side, selectedFace, flip = false, options = {}) {
    const pos = getFacePosition(vol, axis, side);
    const bounds = getVolumeFaceBounds(vol, axis);
    const faceId = { volumeId: vol.id, axis, side, position: pos, bounds };
    const hl = facesMatch(selectedFace, faceId);

    const { u0, u1, v0, v1 } = bounds;

    // XOR: correct natural winding, then apply protrusion flip
    const effectiveFlip = wallNeedsWindingFix(axis, side) !== flip;

    // For wall faces in textured mode, split at the wall split height
    const isWall = axis === 'x' || axis === 'z';
    const textured = options.viewMode === 'textured';
    const splitV = options.wallSplitV;

    if (isWall && textured && splitV !== undefined && v0 < splitV && splitV < v1) {
        // Split into lower and upper quads
        // UVs use absolute V from wall bottom so textures stay seamless when both zones use the same texture
        const lowerH = splitV - v0;
        const totalH = v1 - v0;
        const uW = u1 - u0;

        if (axis === 'x') {
            builder.addQuad(
                [pos, v0, u0], [pos, v0, u1], [pos, splitV, u1], [pos, splitV, u0],
                [0, 0], [uW, 0], [uW, lowerH], [0, lowerH], faceId, hl, effectiveFlip, 2
            );
            builder.addQuad(
                [pos, splitV, u0], [pos, splitV, u1], [pos, v1, u1], [pos, v1, u0],
                [0, lowerH], [uW, lowerH], [uW, totalH], [0, totalH], faceId, hl, effectiveFlip, 3
            );
        } else { // z
            builder.addQuad(
                [u0, v0, pos], [u1, v0, pos], [u1, splitV, pos], [u0, splitV, pos],
                [0, 0], [uW, 0], [uW, lowerH], [0, lowerH], faceId, hl, effectiveFlip, 2
            );
            builder.addQuad(
                [u0, splitV, pos], [u1, splitV, pos], [u1, v1, pos], [u0, v1, pos],
                [0, lowerH], [uW, lowerH], [uW, totalH], [0, totalH], faceId, hl, effectiveFlip, 3
            );
        }
        return;
    }

    // Single quad — determine zone
    const zone = isWall && textured
        ? (splitV !== undefined && v1 <= splitV ? 2 : splitV !== undefined && v0 >= splitV ? 3 : 2)
        : getFaceZone(axis, side, options);

    const uW = u1 - u0, vH = v1 - v0;

    if (axis === 'x') {
        builder.addQuad(
            [pos, v0, u0], [pos, v0, u1], [pos, v1, u1], [pos, v1, u0],
            [0, 0], [uW, 0], [uW, vH], [0, vH], faceId, hl, effectiveFlip, zone
        );
    } else if (axis === 'y') {
        builder.addQuad(
            [u0, pos, v0], [u1, pos, v0], [u1, pos, v1], [u0, pos, v1],
            [0, 0], [uW, 0], [uW, vH], [0, vH], faceId, hl, effectiveFlip, zone
        );
    } else {
        builder.addQuad(
            [u0, v0, pos], [u1, v0, pos], [u1, v1, pos], [u0, v1, pos],
            [0, 0], [uW, 0], [uW, vH], [0, vH], faceId, hl, effectiveFlip, zone
        );
    }
}

// ============================================================
// FACE WITH CONNECTION OPENINGS
// ============================================================

function buildFaceWithConnections(builder, vol, axis, side, connections, selectedFace, flip = false, options = {}) {
    const innerPos = getFacePosition(vol, axis, side);
    const t = WALL_THICKNESS;
    const outerPos = side === 'min' ? innerPos - t : innerPos + t;
    const volBounds = getVolumeFaceBounds(vol, axis);
    const { u0: ru0, u1: ru1, v0: rv0, v1: rv1 } = volBounds;

    const wallFaceId = { volumeId: vol.id, axis, side, position: innerPos, bounds: volBounds };
    const wallHl = facesMatch(selectedFace, wallFaceId);
    const tunnelFaceId = { volumeId: vol.id, axis, side, position: innerPos, bounds: { u0: 0, u1: 0, v0: 0, v1: 0 } };

    // Collect all holes on this face
    const holes = connections.map(c => ({
        u0: c.bounds.u0, u1: c.bounds.u1,
        v0: c.bounds.v0, v1: c.bounds.v1,
    }));

    // --- Generate wall fill quads ONCE for all holes ---
    buildWallWithMultipleHoles(builder, axis, innerPos, side, ru0, ru1, rv0, rv1, holes, wallFaceId, wallHl, flip, options);

    // --- Per-connection: tunnel + exit cap ---
    const tunnelWallZone = options.viewMode === 'textured' ? 5 : 0;
    const tunnelFloorZone = options.viewMode === 'textured' ? 6 : 0;
    for (const conn of connections) {
        const { u0: du0, u1: du1, v0: dv0, v1: dv1 } = conn.bounds;
        const isASide = conn.volAId === vol.id;

        if (isASide) {
            buildTunnelQuads(builder, axis, side, innerPos, outerPos, du0, du1, dv0, dv1, t, tunnelFaceId, tunnelWallZone, tunnelFloorZone);

            if (conn.volBId === null) {
                const exitBounds = { u0: du0, u1: du1, v0: dv0, v1: dv1 };
                const exitFaceId = { volumeId: vol.id, axis, side, position: outerPos, bounds: exitBounds };
                const exitHl = facesMatch(selectedFace, exitFaceId);
                const exitZone = options.viewMode === 'textured' ? 3 : 0;
                buildExitCap(builder, axis, side, outerPos, du0, du1, dv0, dv1, exitFaceId, exitHl, exitZone);
            }
        }
    }
}

// Generate wall quads for a face with multiple rectangular holes cut out.
// Uses column-based subdivision: sort holes by U, create vertical strips between them,
// then fill above/below each hole in its column.
function buildWallWithMultipleHoles(builder, axis, pos, side, ru0, ru1, rv0, rv1, holes, faceId, hl, flip = false, options = {}) {
    // XOR: correct natural winding, then apply protrusion flip
    const effectiveFlip = wallNeedsWindingFix(axis, side) !== flip;

    const textured = options.viewMode === 'textured';
    const splitV = options.wallSplitV;

    // Helper to emit a wall quad, splitting at splitV if needed
    const addQ = (u0, u1, v0, v1) => {
        const uW = u1 - u0, vH = v1 - v0;
        if (uW <= 0 || vH <= 0) return;

        // Check if we need to split this quad at splitV
        if (textured && splitV !== undefined && v0 < splitV && splitV < v1) {
            // Lower portion
            addSingleQ(u0, u1, v0, splitV, 2);
            // Upper portion
            addSingleQ(u0, u1, splitV, v1, 3);
            return;
        }

        // Single quad with appropriate zone
        let zone = 0;
        if (textured) {
            if (splitV !== undefined && v1 <= splitV) zone = 2;       // below split
            else if (splitV !== undefined && v0 >= splitV) zone = 3;  // above split
            else zone = 2; // default to lower wall
        }
        addSingleQ(u0, u1, v0, v1, zone);
    };

    const addSingleQ = (u0, u1, v0, v1, zone) => {
        const uW = u1 - u0, vH = v1 - v0;
        if (uW <= 0 || vH <= 0) return;
        // Use absolute V offset from wall bottom so split textures stay seamless
        const vOff = v0 - rv0;
        if (axis === 'x') {
            builder.addQuad(
                [pos, v0, u0], [pos, v0, u1], [pos, v1, u1], [pos, v1, u0],
                [0, vOff], [uW, vOff], [uW, vOff + vH], [0, vOff + vH], faceId, hl, effectiveFlip, zone
            );
        } else {
            builder.addQuad(
                [u0, v0, pos], [u1, v0, pos], [u1, v1, pos], [u0, v1, pos],
                [0, vOff], [uW, vOff], [uW, vOff + vH], [0, vOff + vH], faceId, hl, effectiveFlip, zone
            );
        }
    };

    if (holes.length === 0) {
        addQ(ru0, ru1, rv0, rv1);
        return;
    }

    // Sort holes by U position
    const sorted = [...holes].sort((a, b) => a.u0 - b.u0);

    // Collect all unique U boundaries (wall edges + hole edges)
    const uEdges = [ru0];
    for (const h of sorted) {
        if (h.u0 > uEdges[uEdges.length - 1]) uEdges.push(h.u0);
        if (h.u1 > uEdges[uEdges.length - 1]) uEdges.push(h.u1);
    }
    if (ru1 > uEdges[uEdges.length - 1]) uEdges.push(ru1);

    // For each vertical strip between consecutive U edges
    for (let i = 0; i < uEdges.length - 1; i++) {
        const su0 = uEdges[i], su1 = uEdges[i + 1];
        if (su1 <= su0) continue;

        // Find holes that overlap this strip
        const stripHoles = sorted.filter(h => h.u0 < su1 && h.u1 > su0);

        if (stripHoles.length === 0) {
            // No holes in this strip — fill entire height
            addQ(su0, su1, rv0, rv1);
        } else {
            // Sort holes in this strip by V and fill gaps
            const vHoles = [...stripHoles].sort((a, b) => a.v0 - b.v0);
            let currentV = rv0;
            for (const h of vHoles) {
                if (h.v0 > currentV) {
                    addQ(su0, su1, currentV, h.v0);
                }
                currentV = Math.max(currentV, h.v1);
            }
            if (currentV < rv1) {
                addQ(su0, su1, currentV, rv1);
            }
        }
    }
}

function buildTunnelQuads(builder, axis, side, innerPos, outerPos, du0, du1, dv0, dv1, t, tunnelFaceId, wallZone = 0, floorZone = 0) {
    const dw = du1 - du0, dh = dv1 - dv0;

    // Tunnel faces always face inward to the passage, independent of volume invertNormals.
    // The sign of (outerPos - innerPos) flips with side, breaking the natural winding
    // for x-min and z-max tunnels.
    const tunnelFlip = (axis === 'x' && side === 'min') || (axis === 'z' && side === 'max');

    // Gradient UVs: stretch texture across full door dimension, keep square aspect.
    // Sides: V spans 0→1 over door height, U keeps square proportions (t/dh).
    // Top: V spans 0→1 over door width, U keeps square proportions (t/dw).
    // Floor: rotated 90° (swap U/V axes).
    const sideU = t / dh;  // square aspect for side depth
    const topU = t / dw;   // square aspect for lintel depth

    if (axis === 'x') {
        const ix = innerPos, ox = outerPos;
        // Left side (at du0 = z) — gradient rotated 180°
        builder.addQuad(
            [ix, dv0, du0], [ox, dv0, du0], [ox, dv1, du0], [ix, dv1, du0],
            [sideU, 1], [0, 1], [0, 0], [sideU, 0], tunnelFaceId, false, tunnelFlip, wallZone
        );
        // Right side (at du1 = z) — gradient rotated 180°
        builder.addQuad(
            [ox, dv0, du1], [ix, dv0, du1], [ix, dv1, du1], [ox, dv1, du1],
            [sideU, 1], [0, 1], [0, 0], [sideU, 0], tunnelFaceId, false, tunnelFlip, wallZone
        );
        // Top (lintel)
        builder.addQuad(
            [ix, dv1, du0], [ox, dv1, du0], [ox, dv1, du1], [ix, dv1, du1],
            [0, 0], [topU, 0], [topU, 1], [0, 1], tunnelFaceId, false, tunnelFlip, wallZone
        );
        // Floor (rotated 90°, tiled 3x)
        builder.addQuad(
            [ix, dv0, du1], [ox, dv0, du1], [ox, dv0, du0], [ix, dv0, du0],
            [0, 0], [0, t*3], [dw*3, t*3], [dw*3, 0], tunnelFaceId, false, tunnelFlip, floorZone
        );
    } else { // z
        const iz = innerPos, oz = outerPos;
        // Left side (at du0 = x) — gradient rotated 180°
        builder.addQuad(
            [du0, dv0, iz], [du0, dv0, oz], [du0, dv1, oz], [du0, dv1, iz],
            [sideU, 1], [0, 1], [0, 0], [sideU, 0], tunnelFaceId, false, tunnelFlip, wallZone
        );
        // Right side (at du1 = x) — gradient rotated 180°
        builder.addQuad(
            [du1, dv0, oz], [du1, dv0, iz], [du1, dv1, iz], [du1, dv1, oz],
            [sideU, 1], [0, 1], [0, 0], [sideU, 0], tunnelFaceId, false, tunnelFlip, wallZone
        );
        // Top (lintel)
        builder.addQuad(
            [du0, dv1, iz], [du0, dv1, oz], [du1, dv1, oz], [du1, dv1, iz],
            [0, 0], [topU, 0], [topU, 1], [0, 1], tunnelFaceId, false, tunnelFlip, wallZone
        );
        // Floor (rotated 90°, tiled 3x)
        builder.addQuad(
            [du0, dv0, oz], [du0, dv0, iz], [du1, dv0, iz], [du1, dv0, oz],
            [0, 0], [0, t*3], [dw*3, t*3], [dw*3, 0], tunnelFaceId, false, tunnelFlip, floorZone
        );
    }
}

function buildExitCap(builder, axis, side, outerPos, du0, du1, dv0, dv1, faceId, hl, zone = 0) {
    const dw = du1 - du0, dh = dv1 - dv0;

    // Exit cap faces outward from tunnel, independent of volume invertNormals.
    // Opposite winding correction pattern from wall faces.
    const exitFlip = (axis === 'x' && side === 'min') || (axis === 'z' && side === 'max');

    if (axis === 'x') {
        builder.addQuad(
            [outerPos, dv0, du0], [outerPos, dv0, du1], [outerPos, dv1, du1], [outerPos, dv1, du0],
            [0, 0], [dw, 0], [dw, dh], [0, dh], faceId, hl, exitFlip, zone
        );
    } else {
        builder.addQuad(
            [du0, dv0, outerPos], [du1, dv0, outerPos], [du1, dv1, outerPos], [du0, dv1, outerPos],
            [0, 0], [dw, 0], [dw, dh], [0, dh], faceId, hl, exitFlip, zone
        );
    }
}
