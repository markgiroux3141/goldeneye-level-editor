// Shared geometry builder + stair segment builder.
// Flat segments are now rendered via the unified polygon-union path
// (see polygonMesh.js), so there's no standalone flat builder here.
// Stairs still render per-segment because they cross height bands.

import * as THREE from 'three';

const WORLD_SCALE = 0.25; // 1 WT = 0.25 Three.js meters
const ZONE_FLOOR = 0;
const ZONE_SIDE = 1;

export class GeoBuilder {
    constructor() {
        this.positions = [];
        this.normals = [];
        this.uvs = [];
        this.indices = [];
        this.groups = [];   // { start, count, zone }
        this.vertexCount = 0;
    }
    _startGroup(zone) {
        const last = this.groups[this.groups.length - 1];
        if (last && last.zone === zone && last.start + last.count === this.indices.length) {
            return last;
        }
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
        if (uv0) {
            this.uvs.push(uv0[0], uv0[1], uv1[0], uv1[1], uv2[0], uv2[1], uv3[0], uv3[1]);
        } else {
            this.uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
        }
        const e1x = p1[0]-p0[0], e1y = p1[1]-p0[1], e1z = p1[2]-p0[2];
        const e2x = p2[0]-p0[0], e2y = p2[1]-p0[1], e2z = p2[2]-p0[2];
        let nx = e1y*e2z - e1z*e2y;
        let ny = e1z*e2x - e1x*e2z;
        let nz = e1x*e2y - e1y*e2x;
        const len = Math.hypot(nx, ny, nz);
        if (len > 0) { nx/=len; ny/=len; nz/=len; }
        for (let i=0; i<4; i++) this.normals.push(nx, ny, nz);
        const g = this._startGroup(zone);
        this.indices.push(base, base+1, base+2, base, base+2, base+3);
        g.count += 6;
        this.vertexCount += 4;
    }
    addTri(p0, p1, p2, normal, zone, uv0, uv1, uv2) {
        const base = this.vertexCount;
        const S = WORLD_SCALE;
        this.positions.push(
            p0[0]*S, p0[1]*S, p0[2]*S,
            p1[0]*S, p1[1]*S, p1[2]*S,
            p2[0]*S, p2[1]*S, p2[2]*S,
        );
        if (uv0) {
            this.uvs.push(uv0[0], uv0[1], uv1[0], uv1[1], uv2[0], uv2[1]);
        } else {
            this.uvs.push(0, 0, 1, 0, 0.5, 1);
        }
        for (let i=0; i<3; i++) this.normals.push(normal[0], normal[1], normal[2]);
        const g = this._startGroup(zone);
        this.indices.push(base, base+1, base+2);
        g.count += 3;
        this.vertexCount += 3;
    }
    build() {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
        geo.setIndex(this.indices);
        for (const g of this.groups) {
            geo.addGroup(g.start, g.count, g.zone);
        }
        return geo;
    }
}

// ============================================================
// STAIR SEGMENT — one mesh per stair, perpendicular endcaps.
// ============================================================
//
// Top end sits on topNode (higher y), bottom on botNode. The flat-union
// polygon at each end extends up to (but not through) the node, so the
// stair's top-tread back edge at fraction 0 coincides with that boundary —
// no top-bridge slab needed. Bottom likewise meets the lower flat at
// fraction 1 with a full-height riser down to botNode.y.

export function buildStairSegment(aNode, bNode, width, stepHeight) {
    const builder = new GeoBuilder();

    const dx = bNode.x - aNode.x;
    const dz = bNode.z - aNode.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return builder.build();
    const ax = dx / len, az = dz / len;
    const lx = -az, lz = ax;     // CCW 90° (left)
    const hw = width / 2;

    const aLeft  = { x: aNode.x + hw * lx, z: aNode.z + hw * lz };
    const aRight = { x: aNode.x - hw * lx, z: aNode.z - hw * lz };
    const bLeft  = { x: bNode.x + hw * lx, z: bNode.z + hw * lz };
    const bRight = { x: bNode.x - hw * lx, z: bNode.z - hw * lz };

    // Re-express corners in TOP → BOTTOM frame. If A is the top end, the
    // A→B direction already points down the stair. If B is the top end,
    // flipping the direction swaps left ↔ right on both nodes.
    const aIsTop = aNode.y > bNode.y;
    const topNode = aIsTop ? aNode : bNode;
    const botNode = aIsTop ? bNode : aNode;
    const topLeft  = aIsTop ? aLeft  : bRight;
    const topRight = aIsTop ? aRight : bLeft;
    const botLeft  = aIsTop ? bLeft  : aRight;
    const botRight = aIsTop ? bRight : aLeft;

    const rise = topNode.y - botNode.y;
    if (rise <= 0) return builder.build();
    const steps = Math.max(1, Math.round(rise / stepHeight));
    const stepRise = rise / steps;
    const BOARD_DEPTH = stepRise;

    const lerpXZ = (p, q, f) => ({ x: p.x + (q.x - p.x) * f, z: p.z + (q.z - p.z) * f });
    const avgWidth = width;

    // Steps: i=0 = bottom-most tread, i=steps-1 = top-most.
    // fFront = (steps-i)/steps → closer to bottom. fBack = (steps-i-1)/steps.
    for (let i = 0; i < steps; i++) {
        const fFront = (steps - i) / steps;
        const fBack  = (steps - i - 1) / steps;
        const frontLeft  = lerpXZ(topLeft,  botLeft,  fFront);
        const frontRight = lerpXZ(topRight, botRight, fFront);
        const backLeft   = lerpXZ(topLeft,  botLeft,  fBack);
        const backRight  = lerpXZ(topRight, botRight, fBack);
        const stepTopY   = botNode.y + (i + 1) * stepRise;

        // Tread — world-xz UVs match the flat polygon's tile flow.
        builder.addQuad(
            [backLeft.x,  stepTopY, backLeft.z],
            [frontLeft.x, stepTopY, frontLeft.z],
            [frontRight.x, stepTopY, frontRight.z],
            [backRight.x, stepTopY, backRight.z],
            ZONE_FLOOR,
            [backLeft.x, backLeft.z], [frontLeft.x, frontLeft.z],
            [frontRight.x, frontRight.z], [backRight.x, backRight.z],
        );

        // Full-height riser at the front edge — seals to the step below, or
        // to the lower flat polygon at the bottommost step.
        const riserBotY = stepTopY - stepRise;
        builder.addQuad(
            [frontLeft.x,  riserBotY, frontLeft.z],
            [frontRight.x, riserBotY, frontRight.z],
            [frontRight.x, stepTopY,  frontRight.z],
            [frontLeft.x,  stepTopY,  frontLeft.z],
            ZONE_SIDE,
            [0, 0], [avgWidth, 0], [avgWidth, 1], [0, 1],
        );
    }

    // Stringers — sloped parallelogram planes from the TOP node (fraction 0)
    // to just short of the bottom (fraction 1 at y=botNode.y + stepRise),
    // BOARD_DEPTH thick downward.
    const fStringerBack  = 0;
    const fStringerFront = 1;
    const stringerBackLeft   = lerpXZ(topLeft,  botLeft,  fStringerBack);
    const stringerBackRight  = lerpXZ(topRight, botRight, fStringerBack);
    const stringerFrontLeft  = lerpXZ(topLeft,  botLeft,  fStringerFront);
    const stringerFrontRight = lerpXZ(topRight, botRight, fStringerFront);
    const stringerBackTopY   = topNode.y;
    const stringerFrontTopY  = botNode.y + stepRise;
    const stringerBackBotY   = stringerBackTopY  - BOARD_DEPTH;
    const stringerFrontBotY  = stringerFrontTopY - BOARD_DEPTH;
    const horizRun = Math.hypot(
        stringerFrontLeft.x - stringerBackLeft.x,
        stringerFrontLeft.z - stringerBackLeft.z,
    );
    const slopeLen = Math.hypot(horizRun, stringerFrontTopY - stringerBackTopY);

    builder.addQuad(
        [stringerFrontLeft.x, stringerFrontBotY, stringerFrontLeft.z],
        [stringerBackLeft.x,  stringerBackBotY,  stringerBackLeft.z],
        [stringerBackLeft.x,  stringerBackTopY,  stringerBackLeft.z],
        [stringerFrontLeft.x, stringerFrontTopY, stringerFrontLeft.z],
        ZONE_SIDE,
        [0, 0], [slopeLen, 0], [slopeLen, 1], [0, 1],
    );
    builder.addQuad(
        [stringerBackRight.x,  stringerBackBotY,  stringerBackRight.z],
        [stringerFrontRight.x, stringerFrontBotY, stringerFrontRight.z],
        [stringerFrontRight.x, stringerFrontTopY, stringerFrontRight.z],
        [stringerBackRight.x,  stringerBackTopY,  stringerBackRight.z],
        ZONE_SIDE,
        [0, 0], [slopeLen, 0], [slopeLen, 1], [0, 1],
    );

    return builder.build();
}
