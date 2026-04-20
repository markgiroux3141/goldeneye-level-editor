// Geometry builders for hub + walkway.
// Hub: axis-aligned box (top + 4 skirt quads). Each skirt can have
// "cutouts" where walkways attach — we emit multiple quads for each side.
// Walkway: oriented rectangle between two anchor world-xz points. Flat if
// both ends at same y; stepped treads + sloped stringers if different.

import * as THREE from 'three';
import { resolveAnchor, edgeNormal, hubEdgeLine } from './model.js';

const WORLD_SCALE = 0.25;
const ZONE_FLOOR = 0;
const ZONE_SIDE = 1;

export class GeoBuilder {
    constructor() {
        this.positions = [];
        this.normals = [];
        this.uvs = [];
        this.indices = [];
        this.groups = [];
        this.vertexCount = 0;
    }
    _startGroup(zone) {
        const last = this.groups[this.groups.length - 1];
        if (last && last.zone === zone && last.start + last.count === this.indices.length) return last;
        const g = { start: this.indices.length, count: 0, zone };
        this.groups.push(g);
        return g;
    }
    addQuad(p0, p1, p2, p3, zone, uv0, uv1, uv2, uv3) {
        const base = this.vertexCount;
        const S = WORLD_SCALE;
        this.positions.push(
            p0[0]*S, p0[1]*S, p0[2]*S,
            p1[0]*S, p1[1]*S, p1[2]*S,
            p2[0]*S, p2[1]*S, p2[2]*S,
            p3[0]*S, p3[1]*S, p3[2]*S,
        );
        if (uv0) this.uvs.push(uv0[0], uv0[1], uv1[0], uv1[1], uv2[0], uv2[1], uv3[0], uv3[1]);
        else this.uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
        const e1x = p1[0]-p0[0], e1y = p1[1]-p0[1], e1z = p1[2]-p0[2];
        const e2x = p2[0]-p0[0], e2y = p2[1]-p0[1], e2z = p2[2]-p0[2];
        let nx = e1y*e2z - e1z*e2y, ny = e1z*e2x - e1x*e2z, nz = e1x*e2y - e1y*e2x;
        const len = Math.hypot(nx, ny, nz);
        if (len > 0) { nx/=len; ny/=len; nz/=len; }
        for (let i=0; i<4; i++) this.normals.push(nx, ny, nz);
        const g = this._startGroup(zone);
        this.indices.push(base, base+1, base+2, base, base+2, base+3);
        g.count += 6;
        this.vertexCount += 4;
    }
    build() {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
        geo.setIndex(this.indices);
        for (const g of this.groups) geo.addGroup(g.start, g.count, g.zone);
        return geo;
    }
}

// ─── HUB ────────────────────────────────────────────────────────
// Build top + 4 skirt walls. For each edge, compute the t-ranges of any
// walkway attachments and cut those gaps out of the skirt.
// (For the spike we just punch a fixed-size gap per attachment — enough to
// show the concept, not visually perfect for oblique walkways.)
//
// attachments: { xMin: [...], xMax: [...], zMin: [...], zMax: [...] } where
// each entry is { t, gapHalfWidthAlongEdge } — the gap width in WT measured
// ALONG the edge (so oblique walkways produce a wider gap).

export function buildHub(hub, attachmentsByEdge = { xMin: [], xMax: [], zMin: [], zMax: [] }) {
    const builder = new GeoBuilder();
    const { x, z, sizeX, sizeZ, y, thickness } = hub;
    const yBot = y - thickness;
    const xMax = x + sizeX, zMax = z + sizeZ;

    // Top (+Y) — CCW viewed from above: (x, zMin)→(x, zMax)→(xMax, zMax)→(xMax, z).
    // Wait: aLeft=(x, z), bLeft=(x, zMax), bRight=(xMax, zMax), aRight=(xMax, z).
    // CCW from above gives +Y normal via right-handed cross.
    builder.addQuad(
        [x, y, z],
        [x, y, zMax],
        [xMax, y, zMax],
        [xMax, y, z],
        ZONE_FLOOR,
        [x, z], [x, zMax], [xMax, zMax], [xMax, z],
    );

    // Skirt for each edge: emit one quad per contiguous "closed" t-range.
    const edges = [
        { name: 'xMin', line: { a: { x: x,    z: z    }, b: { x: x,    z: zMax } } },
        { name: 'xMax', line: { a: { x: xMax, z: z    }, b: { x: xMax, z: zMax } } },
        { name: 'zMin', line: { a: { x: x,    z: z    }, b: { x: xMax, z: z    } } },
        { name: 'zMax', line: { a: { x: x,    z: zMax }, b: { x: xMax, z: zMax } } },
    ];
    for (const e of edges) {
        const dx = e.line.b.x - e.line.a.x;
        const dz = e.line.b.z - e.line.a.z;
        const len = Math.hypot(dx, dz);
        if (len < 1e-6) continue;
        const ax = dx / len, az = dz / len;

        const atts = (attachmentsByEdge[e.name] || []).slice().sort((p, q) => p.t - q.t);
        // Build list of gap t-ranges [tMin, tMax], clamped to [0, 1].
        const gaps = atts.map(({ t, gapHalfWidthAlongEdge }) => {
            const half = gapHalfWidthAlongEdge / len;
            return [Math.max(0, t - half), Math.min(1, t + half)];
        });
        // Invert: closed ranges = [0,1] minus gaps.
        const closed = [];
        let cursor = 0;
        for (const [g0, g1] of gaps) {
            if (g0 > cursor) closed.push([cursor, g0]);
            cursor = Math.max(cursor, g1);
        }
        if (cursor < 1) closed.push([cursor, 1]);

        for (const [t0, t1] of closed) {
            if (t1 - t0 < 1e-4) continue;
            const p0 = { x: e.line.a.x + t0 * dx, z: e.line.a.z + t0 * dz };
            const p1 = { x: e.line.a.x + t1 * dx, z: e.line.a.z + t1 * dz };
            const skirtLen = (t1 - t0) * len;
            // Vertical quad from yBot to y, along p0→p1.
            builder.addQuad(
                [p0.x, yBot, p0.z],
                [p0.x, y,    p0.z],
                [p1.x, y,    p1.z],
                [p1.x, yBot, p1.z],
                ZONE_SIDE,
                [0, 0], [0, 1], [skirtLen, 1], [skirtLen, 0],
            );
        }
    }

    return builder.build();
}

// ─── WALKWAY ────────────────────────────────────────────────────
// Walkway endpoints are points on hub edges. The endcap line is the chord
// where the walkway axis crosses the hub edge — measured so the walkway's
// PERPENDICULAR width is preserved. This means when the walkway is at an
// angle to the hub edge, its endcap slants along the hub edge.
//
// Build:
//   ptA, ptB: world { x, y, z } where walkway centerline meets hub edge
//   (y = top surface at each end).
//   The walkway's axis is the xz direction from ptA to ptB.
//   The hub edge's direction at A is edgeDirA; at B, edgeDirB.
//   The endcap line at A: centered at ptA, lying along the hub edge, length
//   = walkway.width / sin(angle between edge and walkway-perp) — this keeps
//   the walkway's perpendicular width at `width`.
//   Simpler approximation for the spike: endcap is perpendicular to walkway
//   axis, length = walkway.width. This produces a small visible misalignment
//   for oblique meetings but is geometrically watertight with the hub's own
//   edge cut-out.

function walkwayCorners(ptA, ptB, width) {
    const dx = ptB.x - ptA.x, dz = ptB.z - ptA.z;
    const len = Math.hypot(dx, dz);
    const ax = dx / len, az = dz / len;
    const nx = -az, nz = ax;  // left normal
    const hw = width / 2;
    return {
        aLeft: { x: ptA.x + hw * nx, z: ptA.z + hw * nz },
        aRight: { x: ptA.x - hw * nx, z: ptA.z - hw * nz },
        bLeft: { x: ptB.x + hw * nx, z: ptB.z + hw * nz },
        bRight: { x: ptB.x - hw * nx, z: ptB.z - hw * nz },
        axisLen: len,
        axis: { x: ax, z: az },
        perp: { x: nx, z: nz },
    };
}

// Gap width ALONG hub edge that the walkway consumes (for hub skirt cut-out).
// If walkway axis makes angle θ with edge normal, gap = width / cos(θ).
export function walkwayGapWidthAlongEdge(ptA, ptB, edgeAnchor, width) {
    const dxAx = ptB.x - ptA.x, dzAx = ptB.z - ptA.z;
    const len = Math.hypot(dxAx, dzAx);
    if (len < 1e-6) return width;
    const ax = dxAx / len, az = dzAx / len;
    const n = edgeNormal(edgeAnchor.edge);
    // cos(angle between walkway axis and edge normal)
    const cosTheta = Math.abs(ax * n.x + az * n.z);
    if (cosTheta < 0.1) return width * 10; // near-parallel — clamp
    return width / cosTheta;
}

export function buildWalkway(world, walkway, stepHeightWT = 1) {
    const builder = new GeoBuilder();
    const ptA = resolveAnchor(world, walkway.anchorA);
    const ptB = resolveAnchor(world, walkway.anchorB);

    const flat = Math.abs(ptA.y - ptB.y) < 1e-4;
    if (flat) {
        const y = ptA.y;
        const yBot = y - 1; // thickness
        const { aLeft, aRight, bLeft, bRight, axisLen } = walkwayCorners(ptA, ptB, walkway.width);
        // Top
        builder.addQuad(
            [aLeft.x, y, aLeft.z],
            [bLeft.x, y, bLeft.z],
            [bRight.x, y, bRight.z],
            [aRight.x, y, aRight.z],
            ZONE_FLOOR,
            [aLeft.x, aLeft.z], [bLeft.x, bLeft.z], [bRight.x, bRight.z], [aRight.x, aRight.z],
        );
        // Left skirt
        builder.addQuad(
            [aLeft.x, yBot, aLeft.z],
            [aLeft.x, y,    aLeft.z],
            [bLeft.x, y,    bLeft.z],
            [bLeft.x, yBot, bLeft.z],
            ZONE_SIDE,
            [0, 0], [0, 1], [axisLen, 1], [axisLen, 0],
        );
        // Right skirt
        builder.addQuad(
            [bRight.x, yBot, bRight.z],
            [bRight.x, y,    bRight.z],
            [aRight.x, y,    aRight.z],
            [aRight.x, yBot, aRight.z],
            ZONE_SIDE,
            [0, 0], [0, 1], [axisLen, 1], [axisLen, 0],
        );
        return builder.build();
    }

    // Stair case — swap so A is the top for clarity, run top→bottom.
    const aIsTop = ptA.y > ptB.y;
    const topPt = aIsTop ? ptA : ptB;
    const botPt = aIsTop ? ptB : ptA;
    const { aLeft: tLeft, aRight: tRight, bLeft: bLeftXZ, bRight: bRightXZ } =
        walkwayCorners(topPt, botPt, walkway.width);
    const rise = topPt.y - botPt.y;
    const steps = Math.max(1, Math.round(rise / stepHeightWT));
    const stepRise = rise / steps;

    const lerpXZ = (p, q, f) => ({ x: p.x + (q.x - p.x) * f, z: p.z + (q.z - p.z) * f });
    const avgWidth = walkway.width;

    for (let i = 0; i < steps; i++) {
        const fFront = (steps - i) / steps;
        const fBack = (steps - i - 1) / steps;
        const frontLeft = lerpXZ(tLeft, bLeftXZ, fFront);
        const frontRight = lerpXZ(tRight, bRightXZ, fFront);
        const backLeft = lerpXZ(tLeft, bLeftXZ, fBack);
        const backRight = lerpXZ(tRight, bRightXZ, fBack);
        const stepTopY = botPt.y + (i + 1) * stepRise;

        builder.addQuad(
            [backLeft.x, stepTopY, backLeft.z],
            [frontLeft.x, stepTopY, frontLeft.z],
            [frontRight.x, stepTopY, frontRight.z],
            [backRight.x, stepTopY, backRight.z],
            ZONE_FLOOR,
            [backLeft.x, backLeft.z], [frontLeft.x, frontLeft.z],
            [frontRight.x, frontRight.z], [backRight.x, backRight.z],
        );
        // Full-height riser sealing the front.
        const riserBotY = stepTopY - stepRise;
        builder.addQuad(
            [frontLeft.x, riserBotY, frontLeft.z],
            [frontRight.x, riserBotY, frontRight.z],
            [frontRight.x, stepTopY, frontRight.z],
            [frontLeft.x, stepTopY, frontLeft.z],
            ZONE_SIDE,
            [0, 0], [avgWidth, 0], [avgWidth, 1], [0, 1],
        );
    }

    // Two outer stringer walls closing the stair's left and right sides all
    // the way down to botPt.y. (No slot stringers in this spike to keep it
    // simpler — just full-height side walls tracing the stair profile.)
    const bottomY = botPt.y - 1;
    builder.addQuad(
        [tLeft.x, bottomY, tLeft.z],
        [tLeft.x, topPt.y, tLeft.z],
        [bLeftXZ.x, botPt.y, bLeftXZ.z],
        [bLeftXZ.x, bottomY, bLeftXZ.z],
        ZONE_SIDE,
        [0, 0], [0, 1], [1, 1], [1, 0],
    );
    builder.addQuad(
        [bRightXZ.x, bottomY, bRightXZ.z],
        [bRightXZ.x, botPt.y, bRightXZ.z],
        [tRight.x, topPt.y, tRight.z],
        [tRight.x, bottomY, tRight.z],
        ZONE_SIDE,
        [0, 0], [0, 1], [1, 1], [1, 0],
    );

    return builder.build();
}
