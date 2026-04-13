// lightBaker.js — Per-vertex baked lighting with shadow rays.
// Supports four modes: no subdivision, uniform, gradient-adaptive, and stencil+adaptive.

import * as THREE from 'three';
import { subdivideGeometry, trianglesToGeometry } from './subdivide.js';
import { computeShadowCuts, applyShadowCuts, quadToTris, getQuadFaceInfo } from './shadowStencil.js';

const _raycaster = new THREE.Raycaster();
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _lightPos = new THREE.Vector3();
const _vertPos = new THREE.Vector3();
const _normal = new THREE.Vector3();

const SHADOW_BIAS = 0.05;
const AMBIENT = 0.08;

function isOccluded(vertPos, vertNormal, lightPos, occluders) {
    _origin.copy(vertPos).addScaledVector(vertNormal, SHADOW_BIAS);
    _dir.copy(lightPos).sub(_origin);
    const dist = _dir.length();
    if (dist < 0.01) return false;
    _dir.divideScalar(dist);

    _raycaster.set(_origin, _dir);
    _raycaster.near = SHADOW_BIAS;
    _raycaster.far = dist - SHADOW_BIAS;

    const hits = _raycaster.intersectObjects(occluders, false);
    return hits.length > 0;
}

// Bake vertex colors onto a geometry
function bakeVertexColors(geometry, lights, occluders) {
    const positions = geometry.getAttribute('position');
    const normals = geometry.getAttribute('normal');
    const colors = geometry.getAttribute('color');
    if (!positions || !normals || !colors) return;

    const vertCount = positions.count;

    for (let i = 0; i < vertCount; i++) {
        _vertPos.set(positions.getX(i), positions.getY(i), positions.getZ(i));
        _normal.set(normals.getX(i), normals.getY(i), normals.getZ(i)).normalize();

        let totalR = AMBIENT, totalG = AMBIENT, totalB = AMBIENT;

        for (const light of lights) {
            if (!light.enabled) continue;

            _lightPos.set(light.x, light.y, light.z);
            _dir.copy(_lightPos).sub(_vertPos);
            const dist = _dir.length();

            if (dist > light.range) continue;

            _dir.divideScalar(dist);
            const NdotL = Math.max(0, _normal.dot(_dir));
            if (NdotL <= 0) continue;

            const t = 1 - (dist / light.range);
            const attenuation = t * t;

            if (isOccluded(_vertPos, _normal, _lightPos, occluders)) continue;

            totalR += light.color.r * light.intensity * NdotL * attenuation;
            totalG += light.color.g * light.intensity * NdotL * attenuation;
            totalB += light.color.b * light.intensity * NdotL * attenuation;
        }

        colors.setXYZ(i, Math.min(1, totalR), Math.min(1, totalG), Math.min(1, totalB));
    }

    colors.needsUpdate = true;
}

// Compute per-quad gradient (max luminance difference across 4 vertices)
function computeQuadGradients(geometry) {
    const colors = geometry.getAttribute('color');
    const numVerts = colors.count;
    const numQuads = numVerts / 4;
    const gradients = new Float32Array(numQuads);

    for (let q = 0; q < numQuads; q++) {
        const base = q * 4;
        const lums = [];
        for (let k = 0; k < 4; k++) {
            const r = colors.getX(base + k);
            const g = colors.getY(base + k);
            const b = colors.getZ(base + k);
            lums.push(0.299 * r + 0.587 * g + 0.114 * b);
        }
        let maxDiff = 0;
        for (let a = 0; a < 4; a++) {
            for (let b = a + 1; b < 4; b++) {
                maxDiff = Math.max(maxDiff, Math.abs(lums[a] - lums[b]));
            }
        }
        gradients[q] = maxDiff;
    }
    return gradients;
}

// Select per-quad subdivision levels based on gradients
function selectLevels(gradients) {
    const levels = new Array(gradients.length);
    for (let i = 0; i < gradients.length; i++) {
        const g = gradients[i];
        if (g > 0.3) levels[i] = 4;
        else if (g > 0.12) levels[i] = 2;
        else levels[i] = 1;
    }
    return levels;
}

/**
 * Mode: No subdivision — bake directly on base geometry.
 */
export function bakeNone(geometry, lights, occluders) {
    // Reset colors to white
    const colors = geometry.getAttribute('color');
    for (let i = 0; i < colors.count; i++) colors.setXYZ(i, 1, 1, 1);
    colors.needsUpdate = true;

    bakeVertexColors(geometry, lights, occluders);
    return geometry;
}

/**
 * Mode: Uniform subdivision — subdivide all quads to NxN, then bake.
 */
export function bakeUniform(srcGeo, lights, occluders, N = 2) {
    const geo = subdivideGeometry(srcGeo, N);
    bakeVertexColors(geo, lights, occluders);
    return geo;
}

/**
 * Mode: Gradient-adaptive — coarse bake, measure gradient, selective subdivision, re-bake.
 */
export function bakeAdaptive(srcGeo, lights, occluders) {
    // Pass 1: coarse bake at base resolution
    const colors = srcGeo.getAttribute('color');
    for (let i = 0; i < colors.count; i++) colors.setXYZ(i, 1, 1, 1);
    colors.needsUpdate = true;
    bakeVertexColors(srcGeo, lights, occluders);

    // Measure gradients
    const gradients = computeQuadGradients(srcGeo);
    const levels = selectLevels(gradients);

    // Pass 2: selective subdivision + re-bake
    const geo = subdivideGeometry(srcGeo, levels);
    bakeVertexColors(geo, lights, occluders);
    return geo;
}

/**
 * Mode: Shadow stencil + adaptive — cut mesh at shadow edges, then bake.
 */
export function bakeStencilAdaptive(srcGeo, lights, occluderAABBs, occluderMeshes, penumbraWidth = 0.25) {
    const pos = srcGeo.getAttribute('position');
    const nor = srcGeo.getAttribute('normal');
    const numQuads = pos.count / 4;

    // Collect all triangles with their face normals
    const allPos = [];  // flat array of [x,y,z, x,y,z, x,y,z, ...]
    const allNor = [];  // flat array of [nx,ny,nz, ...] per vertex
    let triCount = 0;

    for (let q = 0; q < numQuads; q++) {
        const faceInfo = getQuadFaceInfo(srcGeo, q);
        const cuts = computeShadowCuts(lights, occluderAABBs, faceInfo, penumbraWidth);

        // Convert quad to triangles
        let tris = quadToTris(srcGeo, q);

        // Apply shadow cuts
        if (cuts.length > 0) {
            tris = applyShadowCuts(tris, cuts);
        }

        // Get the face normal from the original quad
        const base = q * 4;
        const fnx = nor.getX(base), fny = nor.getY(base), fnz = nor.getZ(base);

        // Add each triangle's vertices and normals
        for (const tri of tris) {
            allPos.push(
                tri.a.x, tri.a.y, tri.a.z,
                tri.b.x, tri.b.y, tri.b.z,
                tri.c.x, tri.c.y, tri.c.z,
            );
            // All vertices of this triangle get the original quad's normal
            allNor.push(fnx, fny, fnz, fnx, fny, fnz, fnx, fny, fnz);
            triCount++;
        }
    }

    // Build geometry directly (bypass trianglesToGeometry to avoid normal issues)
    const vertCount = triCount * 3;
    const posArr = new Float32Array(allPos);
    const norArr = new Float32Array(allNor);
    const colArr = new Float32Array(vertCount * 3);
    colArr.fill(1); // white
    const idxArr = new Uint32Array(vertCount);
    for (let i = 0; i < vertCount; i++) idxArr[i] = i;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(norArr, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colArr, 3));
    geo.setIndex(new THREE.BufferAttribute(idxArr, 1));

    // Bake lighting on the stenciled geometry
    bakeVertexColors(geo, lights, occluderMeshes);
    return geo;
}

// Count triangles in a geometry
export function countTriangles(geo) {
    const idx = geo.getIndex();
    return idx ? idx.count / 3 : geo.getAttribute('position').count / 3;
}
