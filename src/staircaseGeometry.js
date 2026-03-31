// Staircase geometry builder — generates solid stepped geometry
// Supports multi-segment staircases with landings at waypoints.

import * as THREE from 'three';
import { WORLD_SCALE } from './core/Volume.js';
import { getSegmentInfo, getSegmentWidthExtent } from './core/Staircase.js';

const S = WORLD_SCALE;

// ============================================================
// GEOMETRY BUILDER
// ============================================================
class StairGeometryBuilder {
    constructor() {
        this.positions = [];
        this.normals = [];
        this.uvs = [];
        this.colors = [];
        this.indices = [];
        this.vertexCount = 0;
    }

    addQuad(p0, p1, p2, p3, flip = false) {
        const base = this.vertexCount;
        const [vp1, vp3] = flip ? [p3, p1] : [p1, p3];

        this.positions.push(
            p0[0]*S, p0[1]*S, p0[2]*S, vp1[0]*S, vp1[1]*S, vp1[2]*S,
            p2[0]*S, p2[1]*S, p2[2]*S, vp3[0]*S, vp3[1]*S, vp3[2]*S,
        );
        this.uvs.push(0, 0, 1, 0, 1, 1, 0, 1);

        const e1x = vp1[0] - p0[0], e1y = vp1[1] - p0[1], e1z = vp1[2] - p0[2];
        const e2x = p2[0] - p0[0], e2y = p2[1] - p0[1], e2z = p2[2] - p0[2];
        let nx = e1y * e2z - e1z * e2y;
        let ny = e1z * e2x - e1x * e2z;
        let nz = e1x * e2y - e1y * e2x;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len > 0) { nx /= len; ny /= len; nz /= len; }
        for (let i = 0; i < 4; i++) this.normals.push(nx, ny, nz);
        for (let i = 0; i < 4; i++) this.colors.push(1.0, 1.0, 1.0);

        this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        this.vertexCount += 4;
    }

    build() {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
        geo.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
        geo.setIndex(this.indices);
        return geo;
    }
}

// ============================================================
// HELPERS
// ============================================================

function toWorld(runAxis, runPos, y, perpPos) {
    if (runAxis === 'x') return [runPos, y, perpPos];
    return [perpPos, y, runPos];
}

// ============================================================
// SINGLE STAIR RUN (between two points)
// ============================================================
function buildStairRun(builder, topPt, bottomPt, steps, runAxis, runSign, width, side, floorY) {
    if (steps === 0) return;

    const topRun = runAxis === 'x' ? topPt.x : topPt.z;
    const bottomRun = runAxis === 'x' ? bottomPt.x : bottomPt.z;
    const totalRun = bottomRun - topRun;
    const totalRise = topPt.y - bottomPt.y;
    const stepRise = totalRise / steps;
    const stepRun = totalRun / steps;
    const segBottomY = bottomPt.y; // where steps start (segment's own bottom)
    const N = steps;

    const { perpMin, perpMax } = getSegmentWidthExtent(topPt, runAxis, runSign, width, side);

    const xorFlip = (runAxis === 'x') !== (stepRun < 0);

    for (let i = 0; i < N; i++) {
        const rFront = topRun + (N - i) * stepRun;
        const rBack = topRun + (N - i - 1) * stepRun;
        const stepTopY = segBottomY + (i + 1) * stepRise;
        const stepBotY = segBottomY + i * stepRise;

        // Tread (+Y)
        builder.addQuad(
            toWorld(runAxis, rBack, stepTopY, perpMin),
            toWorld(runAxis, rFront, stepTopY, perpMin),
            toWorld(runAxis, rFront, stepTopY, perpMax),
            toWorld(runAxis, rBack, stepTopY, perpMax),
            xorFlip,
        );

        // Riser (faces toward bottom end)
        builder.addQuad(
            toWorld(runAxis, rFront, stepBotY, perpMin),
            toWorld(runAxis, rFront, stepBotY, perpMax),
            toWorld(runAxis, rFront, stepTopY, perpMax),
            toWorld(runAxis, rFront, stepTopY, perpMin),
            xorFlip,
        );

        // Left side (perpMin, faces -perp)
        builder.addQuad(
            toWorld(runAxis, rFront, floorY, perpMin),
            toWorld(runAxis, rBack, floorY, perpMin),
            toWorld(runAxis, rBack, stepTopY, perpMin),
            toWorld(runAxis, rFront, stepTopY, perpMin),
            !xorFlip,
        );

        // Right side (perpMax, faces +perp)
        builder.addQuad(
            toWorld(runAxis, rBack, floorY, perpMax),
            toWorld(runAxis, rFront, floorY, perpMax),
            toWorld(runAxis, rFront, stepTopY, perpMax),
            toWorld(runAxis, rBack, stepTopY, perpMax),
            !xorFlip,
        );
    }

    // Bottom face (-Y)
    const runMin = Math.min(topRun, topRun + N * stepRun);
    const runMax = Math.max(topRun, topRun + N * stepRun);
    builder.addQuad(
        toWorld(runAxis, runMin, floorY, perpMin),
        toWorld(runAxis, runMax, floorY, perpMin),
        toWorld(runAxis, runMax, floorY, perpMax),
        toWorld(runAxis, runMin, floorY, perpMax),
        runAxis === 'z',
    );

    // Back face (at topRun, faces toward top end)
    builder.addQuad(
        toWorld(runAxis, topRun, floorY, perpMin),
        toWorld(runAxis, topRun, floorY, perpMax),
        toWorld(runAxis, topRun, topPt.y, perpMax),
        toWorld(runAxis, topRun, topPt.y, perpMin),
        !xorFlip,
    );

    // Front face (at bottomRun, faces toward bottom end)
    if (floorY < segBottomY) {
        const frontRun = topRun + N * stepRun;
        builder.addQuad(
            toWorld(runAxis, frontRun, floorY, perpMax),
            toWorld(runAxis, frontRun, floorY, perpMin),
            toWorld(runAxis, frontRun, segBottomY, perpMin),
            toWorld(runAxis, frontRun, segBottomY, perpMax),
            !xorFlip,
        );
    }
}

// ============================================================
// FLAT WALKWAY (between two points at same Y)
// ============================================================
function buildFlatWalkway(builder, ptA, ptB, runAxis, runSign, width, side, floorY) {
    const y = ptA.y;
    const { perpMin, perpMax } = getSegmentWidthExtent(ptA, runAxis, runSign, width, side);

    const aRun = runAxis === 'x' ? ptA.x : ptA.z;
    const bRun = runAxis === 'x' ? ptB.x : ptB.z;
    const runMin = Math.min(aRun, bRun);
    const runMax = Math.max(aRun, bRun);

    if (runMin === runMax) return;

    // Top face (+Y)
    builder.addQuad(
        toWorld(runAxis, runMin, y, perpMin),
        toWorld(runAxis, runMin, y, perpMax),
        toWorld(runAxis, runMax, y, perpMax),
        toWorld(runAxis, runMax, y, perpMin),
        runAxis === 'z',
    );

    // Bottom face (-Y)
    builder.addQuad(
        toWorld(runAxis, runMin, floorY, perpMin),
        toWorld(runAxis, runMax, floorY, perpMin),
        toWorld(runAxis, runMax, floorY, perpMax),
        toWorld(runAxis, runMin, floorY, perpMax),
        runAxis === 'z',
    );

    // Front side (runMin end)
    builder.addQuad(
        toWorld(runAxis, runMin, floorY, perpMin),
        toWorld(runAxis, runMin, floorY, perpMax),
        toWorld(runAxis, runMin, y, perpMax),
        toWorld(runAxis, runMin, y, perpMin),
        runAxis === 'z',
    );

    // Back side (runMax end)
    builder.addQuad(
        toWorld(runAxis, runMax, floorY, perpMax),
        toWorld(runAxis, runMax, floorY, perpMin),
        toWorld(runAxis, runMax, y, perpMin),
        toWorld(runAxis, runMax, y, perpMax),
        runAxis === 'z',
    );

    // Left side (perpMin)
    builder.addQuad(
        toWorld(runAxis, runMax, floorY, perpMin),
        toWorld(runAxis, runMin, floorY, perpMin),
        toWorld(runAxis, runMin, y, perpMin),
        toWorld(runAxis, runMax, y, perpMin),
        runAxis === 'z',
    );

    // Right side (perpMax)
    builder.addQuad(
        toWorld(runAxis, runMin, floorY, perpMax),
        toWorld(runAxis, runMax, floorY, perpMax),
        toWorld(runAxis, runMax, y, perpMax),
        toWorld(runAxis, runMin, y, perpMax),
        runAxis === 'z',
    );
}

// ============================================================
// LANDING PLATFORM (at an intermediate waypoint)
// ============================================================
function buildLanding(builder, wp, inRunAxis, inRunSign, outRunAxis, outRunSign, width, side, floorY) {
    const y = wp.y;

    const inExt = getSegmentWidthExtent(wp, inRunAxis, inRunSign, width, side);
    const outExt = getSegmentWidthExtent(wp, outRunAxis, outRunSign, width, side);

    let xMin, xMax, zMin, zMax;

    if (inRunAxis === 'x') {
        zMin = inExt.perpMin; zMax = inExt.perpMax;
    } else {
        xMin = inExt.perpMin; xMax = inExt.perpMax;
    }

    if (outRunAxis === 'x') {
        zMin = Math.min(zMin ?? outExt.perpMin, outExt.perpMin);
        zMax = Math.max(zMax ?? outExt.perpMax, outExt.perpMax);
    } else {
        xMin = Math.min(xMin ?? outExt.perpMin, outExt.perpMin);
        xMax = Math.max(xMax ?? outExt.perpMax, outExt.perpMax);
    }

    if (xMin === undefined) { xMin = wp.x; xMax = wp.x + width; }
    if (zMin === undefined) { zMin = wp.z; zMax = wp.z + width; }

    const yBot = floorY;

    // Top face (+Y)
    builder.addQuad(
        [xMin, y, zMin], [xMin, y, zMax],
        [xMax, y, zMax], [xMax, y, zMin],
    );

    // Bottom face (-Y)
    builder.addQuad(
        [xMin, yBot, zMin], [xMax, yBot, zMin],
        [xMax, yBot, zMax], [xMin, yBot, zMax],
    );

    // Front (-Z)
    builder.addQuad(
        [xMin, yBot, zMin], [xMax, yBot, zMin],
        [xMax, y, zMin], [xMin, y, zMin],
        true,
    );

    // Back (+Z)
    builder.addQuad(
        [xMax, yBot, zMax], [xMin, yBot, zMax],
        [xMin, y, zMax], [xMax, y, zMax],
        true,
    );

    // Left (-X)
    builder.addQuad(
        [xMin, yBot, zMax], [xMin, yBot, zMin],
        [xMin, y, zMin], [xMin, y, zMax],
        true,
    );

    // Right (+X)
    builder.addQuad(
        [xMax, yBot, zMin], [xMax, yBot, zMax],
        [xMax, y, zMax], [xMax, y, zMin],
        true,
    );
}

// ============================================================
// FULL STAIRCASE (all segments + landings)
// ============================================================
export function buildStaircaseGeometry(stair) {
    const builder = new StairGeometryBuilder();
    const wps = stair.waypoints;

    // Global floor: all solid fill extends down to the lowest waypoint Y
    const floorY = Math.min(...wps.map(wp => wp.y));

    for (let s = 0; s < wps.length - 1; s++) {
        const seg = getSegmentInfo(wps[s], wps[s + 1], stair.stepHeight);

        // At a turn landing, extend the outgoing stair run to start from
        // the far edge of the landing so it connects flush
        let adjustedTopPt = seg.topPt;
        if (s > 0 && !seg.isFlat) {
            const prevSeg = getSegmentInfo(wps[s - 1], wps[s], stair.stepHeight);
            if (prevSeg.runAxis !== seg.runAxis) {
                const inExt = getSegmentWidthExtent(wps[s], prevSeg.runAxis, prevSeg.runSign, stair.width, stair.side);

                const topRun = seg.runAxis === 'x' ? seg.topPt.x : seg.topPt.z;
                const bottomRun = seg.runAxis === 'x' ? seg.bottomPt.x : seg.bottomPt.z;
                const goingPositive = bottomRun > topRun;

                const newTopRun = goingPositive ? inExt.perpMax : inExt.perpMin;

                adjustedTopPt = { ...seg.topPt };
                if (seg.runAxis === 'x') adjustedTopPt.x = newTopRun;
                else adjustedTopPt.z = newTopRun;
            }
        }

        // At a turn landing at the end of this segment, pull back so steps
        // don't overlap the landing platform
        let adjustedBottomPt = seg.bottomPt;
        if (s < wps.length - 2 && !seg.isFlat) {
            const nextSeg = getSegmentInfo(wps[s + 1], wps[s + 2], stair.stepHeight);
            if (seg.runAxis !== nextSeg.runAxis) {
                const outExt = getSegmentWidthExtent(wps[s + 1], nextSeg.runAxis, nextSeg.runSign, stair.width, stair.side);

                const topRun = seg.runAxis === 'x' ? seg.topPt.x : seg.topPt.z;
                const bottomRun = seg.runAxis === 'x' ? seg.bottomPt.x : seg.bottomPt.z;
                const goingPositive = bottomRun > topRun;

                const newBottomRun = goingPositive ? outExt.perpMin : outExt.perpMax;

                adjustedBottomPt = { ...seg.bottomPt };
                if (seg.runAxis === 'x') adjustedBottomPt.x = newBottomRun;
                else adjustedBottomPt.z = newBottomRun;
            }
        }

        if (seg.isFlat) {
            buildFlatWalkway(builder, wps[s], wps[s + 1], seg.runAxis, seg.runSign, stair.width, stair.side, floorY);
        } else {
            buildStairRun(builder, adjustedTopPt, adjustedBottomPt, seg.steps, seg.runAxis, seg.runSign, stair.width, stair.side, floorY);
        }
    }

    // Landings at intermediate waypoints where direction changes
    for (let i = 1; i < wps.length - 1; i++) {
        const segBefore = getSegmentInfo(wps[i - 1], wps[i], stair.stepHeight);
        const segAfter = getSegmentInfo(wps[i], wps[i + 1], stair.stepHeight);

        buildLanding(builder, wps[i],
            segBefore.runAxis, segBefore.runSign,
            segAfter.runAxis, segAfter.runSign,
            stair.width, stair.side, floorY);
    }

    return builder.build();
}

// ============================================================
// PREVIEW LINES
// ============================================================

function addRunPreviewSegs(segs, topPt, bottomPt, steps, runAxis, runSign, width, side) {
    if (steps === 0) return;

    const topRun = runAxis === 'x' ? topPt.x : topPt.z;
    const bottomRun = runAxis === 'x' ? bottomPt.x : bottomPt.z;
    const totalRun = bottomRun - topRun;
    const totalRise = topPt.y - bottomPt.y;
    const stepRise = totalRise / steps;
    const stepRun = totalRun / steps;
    const bY = bottomPt.y;

    const { perpMin, perpMax } = getSegmentWidthExtent(topPt, runAxis, runSign, width, side);

    const toV3 = (r, y, p) => {
        if (runAxis === 'x') return new THREE.Vector3(r * S, y * S, p * S);
        return new THREE.Vector3(p * S, y * S, r * S);
    };
    const addSeg = (a, b) => { segs.push(a, b); };

    for (const perp of [perpMin, perpMax]) {
        let prevPt = toV3(topRun + steps * stepRun, bY, perp);

        for (let i = 0; i < steps; i++) {
            const rFront = topRun + (steps - i) * stepRun;
            const rBack = topRun + (steps - i - 1) * stepRun;
            const stepTop = bY + (i + 1) * stepRise;

            const riserTop = toV3(rFront, stepTop, perp);
            addSeg(prevPt, riserTop);
            const treadEnd = toV3(rBack, stepTop, perp);
            addSeg(riserTop, treadEnd);
            prevPt = treadEnd;
        }

        const backBottom = toV3(topRun, bY, perp);
        addSeg(prevPt, backBottom);
        const frontBottom = toV3(topRun + steps * stepRun, bY, perp);
        addSeg(backBottom, frontBottom);
    }

    addSeg(toV3(topRun, topPt.y, perpMin), toV3(topRun, topPt.y, perpMax));
    addSeg(toV3(bottomRun, bY, perpMin), toV3(bottomRun, bY, perpMax));
    addSeg(toV3(topRun, bY, perpMin), toV3(topRun, bY, perpMax));
}

function addFlatPreviewSegs(segs, ptA, ptB, runAxis, runSign, width, side) {
    const y = ptA.y;
    const { perpMin, perpMax } = getSegmentWidthExtent(ptA, runAxis, runSign, width, side);

    const aRun = runAxis === 'x' ? ptA.x : ptA.z;
    const bRun = runAxis === 'x' ? ptB.x : ptB.z;
    const runMin = Math.min(aRun, bRun);
    const runMax = Math.max(aRun, bRun);

    const toV3 = (r, yy, p) => {
        if (runAxis === 'x') return new THREE.Vector3(r * S, yy * S, p * S);
        return new THREE.Vector3(p * S, yy * S, r * S);
    };
    const addSeg = (a, b) => { segs.push(a, b); };

    addSeg(toV3(runMin, y, perpMin), toV3(runMax, y, perpMin));
    addSeg(toV3(runMax, y, perpMin), toV3(runMax, y, perpMax));
    addSeg(toV3(runMax, y, perpMax), toV3(runMin, y, perpMax));
    addSeg(toV3(runMin, y, perpMax), toV3(runMin, y, perpMin));
}

function addLandingPreviewSegs(segs, wp, inRunAxis, inRunSign, outRunAxis, outRunSign, width, side) {
    const y = wp.y;
    const inExt = getSegmentWidthExtent(wp, inRunAxis, inRunSign, width, side);
    const outExt = getSegmentWidthExtent(wp, outRunAxis, outRunSign, width, side);

    let xMin, xMax, zMin, zMax;
    if (inRunAxis === 'x') { zMin = inExt.perpMin; zMax = inExt.perpMax; }
    else { xMin = inExt.perpMin; xMax = inExt.perpMax; }
    if (outRunAxis === 'x') {
        zMin = Math.min(zMin ?? outExt.perpMin, outExt.perpMin);
        zMax = Math.max(zMax ?? outExt.perpMax, outExt.perpMax);
    } else {
        xMin = Math.min(xMin ?? outExt.perpMin, outExt.perpMin);
        xMax = Math.max(xMax ?? outExt.perpMax, outExt.perpMax);
    }
    if (xMin === undefined) { xMin = wp.x; xMax = wp.x + width; }
    if (zMin === undefined) { zMin = wp.z; zMax = wp.z + width; }

    const addSeg = (a, b) => { segs.push(a, b); };
    const v = (x, yy, z) => new THREE.Vector3(x * S, yy * S, z * S);

    addSeg(v(xMin, y, zMin), v(xMax, y, zMin));
    addSeg(v(xMax, y, zMin), v(xMax, y, zMax));
    addSeg(v(xMax, y, zMax), v(xMin, y, zMax));
    addSeg(v(xMin, y, zMax), v(xMin, y, zMin));
}

/**
 * Build preview for a full staircase (all waypoints).
 */
export function buildStaircasePreviewLines(waypoints, width, stepHeight, side) {
    const segs = [];

    for (let s = 0; s < waypoints.length - 1; s++) {
        const seg = getSegmentInfo(waypoints[s], waypoints[s + 1], stepHeight);

        // Adjust outgoing segments at turns (same logic as geometry)
        let adjustedTopPt = seg.topPt;
        if (s > 0 && !seg.isFlat) {
            const prevSeg = getSegmentInfo(waypoints[s - 1], waypoints[s], stepHeight);
            if (prevSeg.runAxis !== seg.runAxis) {
                const inExt = getSegmentWidthExtent(waypoints[s], prevSeg.runAxis, prevSeg.runSign, width, side);
                const topRun = seg.runAxis === 'x' ? seg.topPt.x : seg.topPt.z;
                const bottomRun = seg.runAxis === 'x' ? seg.bottomPt.x : seg.bottomPt.z;
                const goingPositive = bottomRun > topRun;
                const newTopRun = goingPositive ? inExt.perpMax : inExt.perpMin;
                adjustedTopPt = { ...seg.topPt };
                if (seg.runAxis === 'x') adjustedTopPt.x = newTopRun;
                else adjustedTopPt.z = newTopRun;
            }
        }

        if (seg.isFlat) {
            addFlatPreviewSegs(segs, waypoints[s], waypoints[s + 1], seg.runAxis, seg.runSign, width, side);
        } else {
            addRunPreviewSegs(segs, adjustedTopPt, seg.bottomPt, seg.steps, seg.runAxis, seg.runSign, width, side);
        }
    }

    // Landing previews at intermediate waypoints
    for (let i = 1; i < waypoints.length - 1; i++) {
        const segBefore = getSegmentInfo(waypoints[i - 1], waypoints[i], stepHeight);
        const segAfter = getSegmentInfo(waypoints[i], waypoints[i + 1], stepHeight);
        addLandingPreviewSegs(segs, waypoints[i],
            segBefore.runAxis, segBefore.runSign,
            segAfter.runAxis, segAfter.runSign,
            width, side);
    }

    return segs;
}
