// Staircase geometry builder — generates solid stepped geometry
// Supports multi-segment staircases with landings at waypoints.

import * as THREE from 'three';
import { WORLD_SCALE } from './core/Volume.js';
import { getSegmentInfo, getSegmentWidthExtent, splitSegment } from './core/Staircase.js';

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
        this.zones = [];
        this.vertexCount = 0;
        this.quadCount = 0;
    }

    addQuad(p0, p1, p2, p3, flip = false, zone = 0, uv0, uv1, uv2, uv3) {
        const base = this.vertexCount;
        const [vp1, vp3] = flip ? [p3, p1] : [p1, p3];

        this.positions.push(
            p0[0]*S, p0[1]*S, p0[2]*S, vp1[0]*S, vp1[1]*S, vp1[2]*S,
            p2[0]*S, p2[1]*S, p2[2]*S, vp3[0]*S, vp3[1]*S, vp3[2]*S,
        );

        // UVs: use provided or default [0,0],[1,0],[1,1],[0,1]
        if (uv0 !== undefined) {
            const [vuv1, vuv3] = flip ? [uv3, uv1] : [uv1, uv3];
            this.uvs.push(uv0[0], uv0[1], vuv1[0], vuv1[1], uv2[0], uv2[1], vuv3[0], vuv3[1]);
        } else {
            if (flip) {
                this.uvs.push(0, 0, 0, 1, 1, 1, 1, 0);
            } else {
                this.uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
            }
        }

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

        const uniqueZones = new Set(this.zones);
        if (uniqueZones.size <= 1) {
            geo.setIndex(this.indices);
            if (uniqueZones.size === 1) {
                geo.addGroup(0, this.indices.length, this.zones[0]);
            }
            return geo;
        }

        // Multiple zones — reorder indices by zone and emit groups
        const quads = this.zones.map((z, i) => ({ idx: i, zone: z }));
        quads.sort((a, b) => a.zone - b.zone);

        const newIndices = [];
        for (const q of quads) {
            const srcIdx = q.idx * 6;
            for (let j = 0; j < 6; j++) newIndices.push(this.indices[srcIdx + j]);
        }

        geo.setIndex(newIndices);

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
            groupCount += 6;
        }
        geo.addGroup(groupStart, groupCount, currentZone);

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

// Stair texture zones (matching volume material array indices):
//   0 = grey_tile_floor (treads)
//   3 = brown_wall (sides, bottom, back, front)
//   5 = stair_gradient (risers) — dark at top

// ============================================================
// SINGLE STAIR RUN (between two points)
// ============================================================
function buildStairRun(builder, topPt, bottomPt, steps, runAxis, runSign, width, side, floorY, options) {
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

    const textured = options.viewMode === 'textured';
    const treadZone = textured ? 0 : 0;
    const riserZone = textured ? 5 : 0;
    const sideZone = textured ? 3 : 0;
    const stepWidth = perpMax - perpMin;

    for (let i = 0; i < N; i++) {
        const rFront = topRun + (N - i) * stepRun;
        const rBack = topRun + (N - i - 1) * stepRun;
        const stepTopY = segBottomY + (i + 1) * stepRise;
        const stepBotY = segBottomY + i * stepRise;
        const absStepRun = Math.abs(stepRun);
        const sideH = stepTopY - floorY;

        // Tread (+Y) — grey tile floor (UVs = WT dimensions, material repeat handles scale)
        builder.addQuad(
            toWorld(runAxis, rBack, stepTopY, perpMin),
            toWorld(runAxis, rFront, stepTopY, perpMin),
            toWorld(runAxis, rFront, stepTopY, perpMax),
            toWorld(runAxis, rBack, stepTopY, perpMax),
            xorFlip, treadZone,
            ...(textured ? [[0, 0], [absStepRun, 0], [absStepRun, stepWidth], [0, stepWidth]] : []),
        );

        // Riser (faces toward bottom end) — gradient, dark at top
        // UV: V=0 at bottom (stepBotY), V=1 at top (stepTopY) — flipped
        const riserU = stepWidth / stepRise; // keep square aspect
        builder.addQuad(
            toWorld(runAxis, rFront, stepBotY, perpMin),
            toWorld(runAxis, rFront, stepBotY, perpMax),
            toWorld(runAxis, rFront, stepTopY, perpMax),
            toWorld(runAxis, rFront, stepTopY, perpMin),
            xorFlip, riserZone,
            ...(textured ? [[0, 0], [riserU, 0], [riserU, 1], [0, 1]] : []),
        );

        // Left side (perpMin, faces -perp) — brown wall (UVs = WT dimensions)
        builder.addQuad(
            toWorld(runAxis, rFront, floorY, perpMin),
            toWorld(runAxis, rBack, floorY, perpMin),
            toWorld(runAxis, rBack, stepTopY, perpMin),
            toWorld(runAxis, rFront, stepTopY, perpMin),
            !xorFlip, sideZone,
            ...(textured ? [[0, 0], [absStepRun, 0], [absStepRun, sideH], [0, sideH]] : []),
        );

        // Right side (perpMax, faces +perp) — brown wall (UVs = WT dimensions)
        builder.addQuad(
            toWorld(runAxis, rBack, floorY, perpMax),
            toWorld(runAxis, rFront, floorY, perpMax),
            toWorld(runAxis, rFront, stepTopY, perpMax),
            toWorld(runAxis, rBack, stepTopY, perpMax),
            !xorFlip, sideZone,
            ...(textured ? [[0, 0], [absStepRun, 0], [absStepRun, sideH], [0, sideH]] : []),
        );
    }

    // Bottom face (-Y) — brown wall (UVs = WT dimensions)
    const runMin = Math.min(topRun, topRun + N * stepRun);
    const runMax = Math.max(topRun, topRun + N * stepRun);
    const runLen = runMax - runMin;
    builder.addQuad(
        toWorld(runAxis, runMin, floorY, perpMin),
        toWorld(runAxis, runMax, floorY, perpMin),
        toWorld(runAxis, runMax, floorY, perpMax),
        toWorld(runAxis, runMin, floorY, perpMax),
        runAxis === 'z', sideZone,
        ...(textured ? [[0, 0], [runLen, 0], [runLen, stepWidth], [0, stepWidth]] : []),
    );

    // Back face (at topRun, faces toward top end) — brown wall (UVs = WT dimensions)
    const backH = topPt.y - floorY;
    builder.addQuad(
        toWorld(runAxis, topRun, floorY, perpMin),
        toWorld(runAxis, topRun, floorY, perpMax),
        toWorld(runAxis, topRun, topPt.y, perpMax),
        toWorld(runAxis, topRun, topPt.y, perpMin),
        !xorFlip, sideZone,
        ...(textured ? [[0, 0], [stepWidth, 0], [stepWidth, backH], [0, backH]] : []),
    );

    // Front face (at bottomRun, faces toward bottom end) — brown wall (UVs = WT dimensions)
    if (floorY < segBottomY) {
        const frontRun = topRun + N * stepRun;
        const frontH = segBottomY - floorY;
        builder.addQuad(
            toWorld(runAxis, frontRun, floorY, perpMax),
            toWorld(runAxis, frontRun, floorY, perpMin),
            toWorld(runAxis, frontRun, segBottomY, perpMin),
            toWorld(runAxis, frontRun, segBottomY, perpMax),
            !xorFlip, sideZone,
            ...(textured ? [[0, 0], [stepWidth, 0], [stepWidth, frontH], [0, frontH]] : []),
        );
    }
}

// ============================================================
// FLAT WALKWAY (between two points at same Y)
// ============================================================
function buildFlatWalkway(builder, ptA, ptB, runAxis, runSign, width, side, floorY, options) {
    const y = ptA.y;
    const { perpMin, perpMax } = getSegmentWidthExtent(ptA, runAxis, runSign, width, side);

    const aRun = runAxis === 'x' ? ptA.x : ptA.z;
    const bRun = runAxis === 'x' ? ptB.x : ptB.z;
    const runMin = Math.min(aRun, bRun);
    const runMax = Math.max(aRun, bRun);

    if (runMin === runMax) return;

    const textured = options.viewMode === 'textured';
    const treadZone = textured ? 0 : 0;
    const sideZone = textured ? 3 : 0;
    const runLen = runMax - runMin;
    const ww = perpMax - perpMin;
    const h = y - floorY;

    // Top face (+Y) — grey tile floor (UVs = WT dimensions)
    builder.addQuad(
        toWorld(runAxis, runMin, y, perpMin),
        toWorld(runAxis, runMin, y, perpMax),
        toWorld(runAxis, runMax, y, perpMax),
        toWorld(runAxis, runMax, y, perpMin),
        runAxis === 'z', treadZone,
        ...(textured ? [[0, 0], [0, ww], [runLen, ww], [runLen, 0]] : []),
    );

    // Bottom face (-Y) — brown wall (UVs = WT dimensions)
    builder.addQuad(
        toWorld(runAxis, runMin, floorY, perpMin),
        toWorld(runAxis, runMax, floorY, perpMin),
        toWorld(runAxis, runMax, floorY, perpMax),
        toWorld(runAxis, runMin, floorY, perpMax),
        runAxis === 'z', sideZone,
        ...(textured ? [[0, 0], [runLen, 0], [runLen, ww], [0, ww]] : []),
    );

    // Front side (runMin end) — brown wall (UVs = WT dimensions)
    builder.addQuad(
        toWorld(runAxis, runMin, floorY, perpMin),
        toWorld(runAxis, runMin, floorY, perpMax),
        toWorld(runAxis, runMin, y, perpMax),
        toWorld(runAxis, runMin, y, perpMin),
        runAxis === 'z', sideZone,
        ...(textured ? [[0, 0], [ww, 0], [ww, h], [0, h]] : []),
    );

    // Back side (runMax end) — brown wall (UVs = WT dimensions)
    builder.addQuad(
        toWorld(runAxis, runMax, floorY, perpMax),
        toWorld(runAxis, runMax, floorY, perpMin),
        toWorld(runAxis, runMax, y, perpMin),
        toWorld(runAxis, runMax, y, perpMax),
        runAxis === 'z', sideZone,
        ...(textured ? [[0, 0], [ww, 0], [ww, h], [0, h]] : []),
    );

    // Left side (perpMin) — brown wall (UVs = WT dimensions)
    builder.addQuad(
        toWorld(runAxis, runMax, floorY, perpMin),
        toWorld(runAxis, runMin, floorY, perpMin),
        toWorld(runAxis, runMin, y, perpMin),
        toWorld(runAxis, runMax, y, perpMin),
        runAxis === 'z', sideZone,
        ...(textured ? [[0, 0], [runLen, 0], [runLen, h], [0, h]] : []),
    );

    // Right side (perpMax) — brown wall (UVs = WT dimensions)
    builder.addQuad(
        toWorld(runAxis, runMin, floorY, perpMax),
        toWorld(runAxis, runMax, floorY, perpMax),
        toWorld(runAxis, runMax, y, perpMax),
        toWorld(runAxis, runMin, y, perpMax),
        runAxis === 'z', sideZone,
        ...(textured ? [[0, 0], [runLen, 0], [runLen, h], [0, h]] : []),
    );
}

// ============================================================
// LANDING PLATFORM (at an intermediate waypoint)
// ============================================================
function buildLanding(builder, wp, inRunAxis, inRunSign, outRunAxis, outRunSign, width, side, floorY, options) {
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

    const textured = options.viewMode === 'textured';
    const treadZone = textured ? 0 : 0;
    const sideZone = textured ? 3 : 0;
    const lx = xMax - xMin, lz = zMax - zMin;
    const h = y - yBot;

    // Top face (+Y) — grey tile floor (UVs = WT dimensions)
    builder.addQuad(
        [xMin, y, zMin], [xMin, y, zMax],
        [xMax, y, zMax], [xMax, y, zMin],
        false, treadZone,
        ...(textured ? [[0, 0], [0, lz], [lx, lz], [lx, 0]] : []),
    );

    // Bottom face (-Y) — brown wall (UVs = WT dimensions)
    builder.addQuad(
        [xMin, yBot, zMin], [xMax, yBot, zMin],
        [xMax, yBot, zMax], [xMin, yBot, zMax],
        false, sideZone,
        ...(textured ? [[0, 0], [lx, 0], [lx, lz], [0, lz]] : []),
    );

    // Front (-Z) — brown wall (UVs = WT dimensions)
    builder.addQuad(
        [xMin, yBot, zMin], [xMax, yBot, zMin],
        [xMax, y, zMin], [xMin, y, zMin],
        true, sideZone,
        ...(textured ? [[0, 0], [lx, 0], [lx, h], [0, h]] : []),
    );

    // Back (+Z) — brown wall (UVs = WT dimensions)
    builder.addQuad(
        [xMax, yBot, zMax], [xMin, yBot, zMax],
        [xMin, y, zMax], [xMax, y, zMax],
        true, sideZone,
        ...(textured ? [[0, 0], [lx, 0], [lx, h], [0, h]] : []),
    );

    // Left (-X) — brown wall (UVs = WT dimensions)
    builder.addQuad(
        [xMin, yBot, zMax], [xMin, yBot, zMin],
        [xMin, y, zMin], [xMin, y, zMax],
        true, sideZone,
        ...(textured ? [[0, 0], [lz, 0], [lz, h], [0, h]] : []),
    );

    // Right (+X) — brown wall (UVs = WT dimensions)
    builder.addQuad(
        [xMax, yBot, zMin], [xMax, yBot, zMax],
        [xMax, y, zMax], [xMax, y, zMin],
        true, sideZone,
        ...(textured ? [[0, 0], [lz, 0], [lz, h], [0, h]] : []),
    );
}

// ============================================================
// FULL STAIRCASE (all segments + landings)
// ============================================================
export function buildStaircaseGeometry(stair, options = {}) {
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
            buildFlatWalkway(builder, wps[s], wps[s + 1], seg.runAxis, seg.runSign, stair.width, stair.side, floorY, options);
        } else {
            const split = splitSegment(seg, stair.riseOverRun, adjustedTopPt, adjustedBottomPt);
            if (split.hasFlatPortion) {
                buildFlatWalkway(builder, split.flatTopPt, split.flatBottomPt, seg.runAxis, seg.runSign, stair.width, stair.side, floorY, options);
                buildStairRun(builder, split.stairTopPt, split.stairBottomPt, seg.steps, seg.runAxis, seg.runSign, stair.width, stair.side, floorY, options);
            } else {
                buildStairRun(builder, adjustedTopPt, adjustedBottomPt, seg.steps, seg.runAxis, seg.runSign, stair.width, stair.side, floorY, options);
            }
        }
    }

    // Landings at intermediate waypoints where direction changes
    for (let i = 1; i < wps.length - 1; i++) {
        const segBefore = getSegmentInfo(wps[i - 1], wps[i], stair.stepHeight);
        const segAfter = getSegmentInfo(wps[i], wps[i + 1], stair.stepHeight);

        buildLanding(builder, wps[i],
            segBefore.runAxis, segBefore.runSign,
            segAfter.runAxis, segAfter.runSign,
            stair.width, stair.side, floorY, options);
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
export function buildStaircasePreviewLines(waypoints, width, stepHeight, side, riseOverRun = 1) {
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
            const split = splitSegment(seg, riseOverRun, adjustedTopPt, seg.bottomPt);
            if (split.hasFlatPortion) {
                addFlatPreviewSegs(segs, split.flatTopPt, split.flatBottomPt, seg.runAxis, seg.runSign, width, side);
                addRunPreviewSegs(segs, split.stairTopPt, split.stairBottomPt, seg.steps, seg.runAxis, seg.runSign, width, side);
            } else {
                addRunPreviewSegs(segs, adjustedTopPt, seg.bottomPt, seg.steps, seg.runAxis, seg.runSign, width, side);
            }
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
