// shadowStencil.js — Shadow edge projection and mesh cutting.
//
// Simplified approach: for each point light + occluder box:
//   1. Project the occluder's top-face corners from the light onto each receiver face
//   2. The projected corners' bounding box defines the shadow footprint
//   3. Cut the receiver mesh at the shadow footprint boundaries
//
// This gives axis-aligned cuts at shadow edges without complex silhouette detection.

import * as THREE from 'three';
import { splitTrisAtAxis } from './splitTrisAtAxis.js';

/**
 * Project a 3D point from light through a point onto a plane.
 * Plane: normal · (P - planePoint) = 0
 * Returns null if projection is behind the light, parallel, or too far.
 */
function projectPoint(lightPos, point, planeNormal, planePoint) {
    const dx = point[0] - lightPos[0];
    const dy = point[1] - lightPos[1];
    const dz = point[2] - lightPos[2];
    const denom = planeNormal[0] * dx + planeNormal[1] * dy + planeNormal[2] * dz;
    if (Math.abs(denom) < 1e-8) return null;

    const ex = planePoint[0] - lightPos[0];
    const ey = planePoint[1] - lightPos[1];
    const ez = planePoint[2] - lightPos[2];
    const t = (planeNormal[0] * ex + planeNormal[1] * ey + planeNormal[2] * ez) / denom;
    if (t < 0.5) return null; // behind light or too close

    return [
        lightPos[0] + dx * t,
        lightPos[1] + dy * t,
        lightPos[2] + dz * t,
    ];
}

/**
 * Get the 8 corners of an AABB.
 */
function getBoxCorners(aabb) {
    const { minX, maxX, minY, maxY, minZ, maxZ } = aabb;
    return [
        [minX, minY, minZ], [maxX, minY, minZ], [maxX, minY, maxZ], [minX, minY, maxZ],
        [minX, maxY, minZ], [maxX, maxY, minZ], [maxX, maxY, maxZ], [minX, maxY, maxZ],
    ];
}

/**
 * Compute shadow cuts for a single receiver quad from all lights + occluders.
 *
 * For each light+occluder pair, projects the occluder's corners onto the receiver plane,
 * finds which in-plane axes have shadow boundaries, and returns axis-aligned cut values.
 *
 * @param {Array} lights - { x, y, z, range, enabled }
 * @param {Array} occluderAABBs - { minX, maxX, minY, maxY, minZ, maxZ }
 * @param {Object} face - { normal, point, bounds }
 * @param {number} penumbraWidth
 * @returns {Array<{axis: string, value: number}>}
 */
export function computeShadowCuts(lights, occluderAABBs, face, penumbraWidth = 0.25) {
    const cuts = [];

    // Determine which 2 axes the face spans (not the dominant normal axis)
    const absN = face.normal.map(Math.abs);
    const domAxis = absN[0] > absN[1] && absN[0] > absN[2] ? 0 : absN[1] > absN[2] ? 1 : 2;
    const inPlaneAxes = [0, 1, 2].filter(a => a !== domAxis);
    const axisNames = ['x', 'y', 'z'];

    for (const light of lights) {
        if (!light.enabled) continue;
        const lp = [light.x, light.y, light.z];

        for (const aabb of occluderAABBs) {
            const corners = getBoxCorners(aabb);

            // Project all 8 corners onto the receiver plane
            const projected = [];
            for (const corner of corners) {
                const p = projectPoint(lp, corner, face.normal, face.point);
                if (p) projected.push(p);
            }
            if (projected.length < 2) continue;

            // For each in-plane axis, find the min/max of projected coordinates
            for (const a of inPlaneAxes) {
                const axName = axisNames[a];
                const bMin = face.bounds['min' + axName.toUpperCase()];
                const bMax = face.bounds['max' + axName.toUpperCase()];
                if (bMin === undefined) continue;

                const vals = projected.map(p => p[a]);
                const pMin = Math.min(...vals);
                const pMax = Math.max(...vals);

                // Also get the occluder's own extent on this axis
                const occMin = aabb['min' + axName.toUpperCase()];
                const occMax = aabb['max' + axName.toUpperCase()];

                // Shadow boundaries are where the projected extent differs from the occluder extent.
                // The occluder's own edges and the shadow's outer edges are both cut candidates.
                const candidateValues = [occMin, occMax, pMin, pMax];

                for (const val of candidateValues) {
                    // Must be within the receiver face bounds (with margin)
                    if (val <= bMin + 0.05 || val >= bMax - 0.05) continue;

                    // Don't add cuts too close to existing cuts
                    const exists = cuts.some(c => c.axis === axName && Math.abs(c.value - val) < 0.1);
                    if (exists) continue;

                    cuts.push({ axis: axName, value: val });

                    // Penumbra strips
                    if (penumbraWidth > 0) {
                        if (val - penumbraWidth > bMin + 0.05) {
                            const e = cuts.some(c => c.axis === axName && Math.abs(c.value - (val - penumbraWidth)) < 0.1);
                            if (!e) cuts.push({ axis: axName, value: val - penumbraWidth });
                        }
                        if (val + penumbraWidth < bMax - 0.05) {
                            const e = cuts.some(c => c.axis === axName && Math.abs(c.value - (val + penumbraWidth)) < 0.1);
                            if (!e) cuts.push({ axis: axName, value: val + penumbraWidth });
                        }
                    }
                }
            }
        }
    }

    return cuts;
}

/**
 * Apply shadow stencil cuts to an array of triangles.
 */
export function applyShadowCuts(tris, cuts) {
    let result = tris;
    for (const cut of cuts) {
        result = splitTrisAtAxis(result, cut.axis, cut.value);
    }
    return result;
}

/**
 * Convert a quad (4 vertices from BufferGeometry) to two triangles.
 */
export function quadToTris(geo, quadIndex) {
    const pos = geo.getAttribute('position');
    const base = quadIndex * 4;
    const a = new THREE.Vector3(pos.getX(base), pos.getY(base), pos.getZ(base));
    const b = new THREE.Vector3(pos.getX(base + 1), pos.getY(base + 1), pos.getZ(base + 1));
    const c = new THREE.Vector3(pos.getX(base + 2), pos.getY(base + 2), pos.getZ(base + 2));
    const d = new THREE.Vector3(pos.getX(base + 3), pos.getY(base + 3), pos.getZ(base + 3));
    return [
        { a: a, b: b, c: c },
        { a: a.clone(), b: c.clone(), c: d },
    ];
}

/**
 * Get face info for a quad (normal, point on plane, bounds).
 */
export function getQuadFaceInfo(geo, quadIndex) {
    const pos = geo.getAttribute('position');
    const nor = geo.getAttribute('normal');
    const base = quadIndex * 4;

    const normal = [nor.getX(base), nor.getY(base), nor.getZ(base)];
    const point = [pos.getX(base), pos.getY(base), pos.getZ(base)];

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < 4; i++) {
        const x = pos.getX(base + i), y = pos.getY(base + i), z = pos.getZ(base + i);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }

    return { normal, point, bounds: { minX, maxX, minY, maxY, minZ, maxZ } };
}
