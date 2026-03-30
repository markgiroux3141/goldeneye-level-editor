// Staircase geometry builder — generates solid stepped geometry
// Uses the same GeometryBuilder pattern as geometry.js

import * as THREE from 'three';
import { WORLD_SCALE } from './core/Volume.js';

const S = WORLD_SCALE;

// ============================================================
// GEOMETRY BUILDER (local copy — same as geometry.js)
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

    // p0..p3 are [x,y,z] in WT units. Winding: normal = (p1-p0)×(p2-p0)
    addQuad(p0, p1, p2, p3, flip = false) {
        const base = this.vertexCount;

        const [vp1, vp3] = flip ? [p3, p1] : [p1, p3];

        this.positions.push(
            p0[0]*S, p0[1]*S, p0[2]*S, vp1[0]*S, vp1[1]*S, vp1[2]*S,
            p2[0]*S, p2[1]*S, p2[2]*S, vp3[0]*S, vp3[1]*S, vp3[2]*S,
        );

        // Simple UVs based on quad dimensions
        this.uvs.push(0, 0, 1, 0, 1, 1, 0, 1);

        // Auto-compute normal from winding
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
// STAIRCASE GEOMETRY
// ============================================================

/**
 * Compute the staircase corner positions for a given step.
 * Returns { runPos, nextRunPos, stepTopY } for step i.
 */
function getStepParams(stair) {
    const totalRise = stair.topY - stair.bottomY;
    const runAxis = stair.runAxis;
    const topRun = runAxis === 'x' ? stair.topX : stair.topZ;
    const bottomRun = runAxis === 'x' ? stair.bottomX : stair.bottomZ;
    const totalRun = bottomRun - topRun; // signed: positive if bottom is further along axis

    const stepRise = totalRise / stair.steps;
    const stepRun = totalRun / stair.steps;

    // Perpendicular axis
    const topPerp = runAxis === 'x' ? stair.topZ : stair.topX;
    let perpMin, perpMax;
    if (stair.side === 'right') {
        perpMin = topPerp;
        perpMax = topPerp + stair.width;
    } else {
        perpMin = topPerp - stair.width;
        perpMax = topPerp;
    }

    return { totalRise, totalRun, stepRise, stepRun, topRun, bottomRun, perpMin, perpMax, runAxis };
}

/**
 * Convert (runPos, y, perpPos) back to world [x, y, z] based on runAxis.
 */
function toWorld(runAxis, runPos, y, perpPos) {
    if (runAxis === 'x') return [runPos, y, perpPos];
    return [perpPos, y, runPos]; // runAxis === 'z'
}

/**
 * Build the full solid staircase geometry.
 * Returns a THREE.BufferGeometry.
 */
export function buildStaircaseGeometry(stair) {
    const builder = new StairGeometryBuilder();
    const { stepRise, stepRun, topRun, perpMin, perpMax, runAxis } = getStepParams(stair);
    const bY = stair.bottomY;
    const N = stair.steps;

    for (let i = 0; i < N; i++) {
        // Step i: i=0 is at the bottom (closest to bottomY)
        // Run position goes from bottom toward top
        const rFront = topRun + (N - i) * stepRun;     // front of step (lower side)
        const rBack = topRun + (N - i - 1) * stepRun;  // back of step (upper side)
        const stepTopY = bY + (i + 1) * stepRise;
        const stepBotY = bY + i * stepRise;

        // --- Tread (top face, normal +Y) ---
        // Winding for +Y: p0→p1 along perp, p0→p2 diagonal gives +Y cross product
        // p0=(perpMin, y, rBack), p1=(perpMin, y, rFront), p2=(perpMax, y, rFront), p3=(perpMax, y, rBack)
        // with runAxis mapping
        builder.addQuad(
            toWorld(runAxis, rBack, stepTopY, perpMin),
            toWorld(runAxis, rFront, stepTopY, perpMin),
            toWorld(runAxis, rFront, stepTopY, perpMax),
            toWorld(runAxis, rBack, stepTopY, perpMax),
        );

        // --- Riser (front face) ---
        // Normal should point toward the bottom end of the staircase (outward from the step front)
        // The riser is at rFront, spanning perpMin..perpMax, stepBotY..stepTopY
        const riserNormalSign = (topRun > topRun + (N) * stepRun) ? -1 : 1; // direction from top to bottom
        // We need the normal to point away from the step, toward the "down" end
        // If stepRun > 0, bottom is at higher run values, riser faces +run direction
        // If stepRun < 0, bottom is at lower run values, riser faces -run direction
        const riserFlip = stepRun < 0;
        builder.addQuad(
            toWorld(runAxis, rFront, stepBotY, perpMin),
            toWorld(runAxis, rFront, stepBotY, perpMax),
            toWorld(runAxis, rFront, stepTopY, perpMax),
            toWorld(runAxis, rFront, stepTopY, perpMin),
            riserFlip,
        );

        // --- Left side (at perpMin, normal points -perp) ---
        // Solid fill: rectangle from bottomY to stepTopY across the step run depth
        builder.addQuad(
            toWorld(runAxis, rFront, bY, perpMin),
            toWorld(runAxis, rBack, bY, perpMin),
            toWorld(runAxis, rBack, stepTopY, perpMin),
            toWorld(runAxis, rFront, stepTopY, perpMin),
            runAxis === 'z', // flip for z-axis to get correct outward normal
        );

        // --- Right side (at perpMax, normal points +perp) ---
        builder.addQuad(
            toWorld(runAxis, rBack, bY, perpMax),
            toWorld(runAxis, rFront, bY, perpMax),
            toWorld(runAxis, rFront, stepTopY, perpMax),
            toWorld(runAxis, rBack, stepTopY, perpMax),
            runAxis === 'z',
        );
    }

    // --- Bottom face (Y = bottomY, normal -Y, faces down) ---
    const runMin = Math.min(topRun, topRun + N * stepRun);
    const runMax = Math.max(topRun, topRun + N * stepRun);
    builder.addQuad(
        toWorld(runAxis, runMin, bY, perpMin),
        toWorld(runAxis, runMax, bY, perpMin),
        toWorld(runAxis, runMax, bY, perpMax),
        toWorld(runAxis, runMin, bY, perpMax),
        true,
    );

    // --- Back face (at topRun, full height, normal faces toward top end) ---
    const backFlip = stepRun > 0;
    builder.addQuad(
        toWorld(runAxis, topRun, bY, perpMin),
        toWorld(runAxis, topRun, bY, perpMax),
        toWorld(runAxis, topRun, stair.topY, perpMax),
        toWorld(runAxis, topRun, stair.topY, perpMin),
        backFlip,
    );

    return builder.build();
}

// ============================================================
// PREVIEW LINES — wireframe outline for the staircase
// ============================================================

/**
 * Build preview line segment pairs for a staircase (green wireframe).
 * Returns an array of THREE.Vector3 where each consecutive pair forms a line segment.
 * Compatible with THREE.LineSegments.
 */
export function buildStaircasePreviewLines(topPoint, bottomPoint, width, steps, side) {
    const topX = topPoint.x, topY = topPoint.y, topZ = topPoint.z;
    const bottomX = bottomPoint.x, bottomY = bottomPoint.y, bottomZ = bottomPoint.z;

    const dx = Math.abs(topX - bottomX);
    const dz = Math.abs(topZ - bottomZ);
    const runAxis = dx >= dz ? 'x' : 'z';

    const topRun = runAxis === 'x' ? topX : topZ;
    const bottomRun = runAxis === 'x' ? bottomX : bottomZ;
    const totalRun = bottomRun - topRun;
    const totalRise = topY - bottomY;
    const stepRise = totalRise / steps;
    const stepRun = totalRun / steps;

    const topPerp = runAxis === 'x' ? topZ : topX;
    let perpMin, perpMax;
    if (side === 'right') {
        perpMin = topPerp;
        perpMax = topPerp + width;
    } else {
        perpMin = topPerp - width;
        perpMax = topPerp;
    }

    const toV3 = (r, y, p) => {
        if (runAxis === 'x') return new THREE.Vector3(r * S, y * S, p * S);
        return new THREE.Vector3(p * S, y * S, r * S);
    };

    // Helper: add a line segment (pair of points)
    const segs = [];
    const addSeg = (a, b) => { segs.push(a, b); };

    // Draw stepped profile on both sides (perpMin and perpMax)
    for (const perp of [perpMin, perpMax]) {
        let prevPt = toV3(topRun + steps * stepRun, bottomY, perp); // bottom-front

        for (let i = 0; i < steps; i++) {
            const rFront = topRun + (steps - i) * stepRun;
            const rBack = topRun + (steps - i - 1) * stepRun;
            const stepTop = bottomY + (i + 1) * stepRise;

            // Vertical riser
            const riserTop = toV3(rFront, stepTop, perp);
            addSeg(prevPt, riserTop);
            // Horizontal tread
            const treadEnd = toV3(rBack, stepTop, perp);
            addSeg(riserTop, treadEnd);
            prevPt = treadEnd;
        }

        // Down the back to bottom
        const backBottom = toV3(topRun, bottomY, perp);
        addSeg(prevPt, backBottom);
        // Bottom edge back to start
        const frontBottom = toV3(topRun + steps * stepRun, bottomY, perp);
        addSeg(backBottom, frontBottom);
    }

    // Connect the two sides at key corners
    addSeg(toV3(topRun, topY, perpMin), toV3(topRun, topY, perpMax));
    addSeg(toV3(bottomRun, bottomY, perpMin), toV3(bottomRun, bottomY, perpMax));
    addSeg(toV3(topRun, bottomY, perpMin), toV3(topRun, bottomY, perpMax));

    return segs;
}
