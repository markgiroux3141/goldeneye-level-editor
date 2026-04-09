// CSG selection + hole/door preview rendering.
// Ported from spike/csg/main.js (updateSelectionPreview, updateHolePreview).
//
// Both previews are rebuilt every frame in the animate loop. They sit slightly
// in front of the selected face (polygonOffset) so they don't z-fight.

import * as THREE from 'three';
import { state } from '../state.js';
import { scene } from '../scene/setup.js';
import { isPointerLocked } from '../input/input.js';
import { csgRegionMeshes } from '../mesh/csgMesh.js';
import { pickCSGFace } from '../raycaster.js';
import {
    facesMatch, getSelectedFaceInfo, worldToFaceUV, computeHolePreview, computeBracePreview, computePillarPreview,
} from '../csg/csgActions.js';
import { WORLD_SCALE } from '../core/constants.js';

const SEL_OFFSET = 0.002;
const HOLE_OFFSET = 0.003;
const BRACE_OFFSET = 0.003;

let selectionMesh = null;
const selectionMat = new THREE.MeshBasicMaterial({
    color: 0xff6644, transparent: true, opacity: 0.35,
    side: THREE.DoubleSide, depthTest: true,
    polygonOffset: true, polygonOffsetFactor: -2,
});

let holeMesh = null;
const holeMat = new THREE.MeshBasicMaterial({
    color: 0xffcc00, transparent: true, opacity: 0.4,
    side: THREE.DoubleSide, depthTest: true,
    polygonOffset: true, polygonOffsetFactor: -2,
});

let braceMeshes = [];
const braceMat = new THREE.MeshBasicMaterial({
    color: 0xffcc00, transparent: true, opacity: 0.5,
    side: THREE.DoubleSide, depthTest: true,
    polygonOffset: true, polygonOffsetFactor: -2,
});

let pillarMesh = null;

function disposeMesh(mesh) {
    if (!mesh) return;
    scene.remove(mesh);
    if (mesh.geometry) mesh.geometry.dispose();
}

// Build a flat quad on the given face plane spanning u0..u1, v0..v1 (WT units).
// `offset` pushes it slightly off the surface to avoid z-fighting.
function buildFaceQuad(face, u0, u1, v0, v1, offset) {
    const { axis, side, position } = face;
    const pos = position * WORLD_SCALE;
    const o = side === 'min' ? offset : -offset;

    let x0, x1, y0, y1, z0, z1;
    if (axis === 'x') {
        x0 = x1 = pos + o;
        z0 = u0 * WORLD_SCALE; z1 = u1 * WORLD_SCALE;
        y0 = v0 * WORLD_SCALE; y1 = v1 * WORLD_SCALE;
    } else if (axis === 'y') {
        y0 = y1 = pos + o;
        x0 = u0 * WORLD_SCALE; x1 = u1 * WORLD_SCALE;
        z0 = v0 * WORLD_SCALE; z1 = v1 * WORLD_SCALE;
    } else {
        z0 = z1 = pos + o;
        x0 = u0 * WORLD_SCALE; x1 = u1 * WORLD_SCALE;
        y0 = v0 * WORLD_SCALE; y1 = v1 * WORLD_SCALE;
    }

    const positions = new Float32Array(axis === 'x' ? [
        x0, y0, z0,  x0, y1, z0,  x0, y1, z1,
        x0, y0, z0,  x0, y1, z1,  x0, y0, z1,
    ] : axis === 'y' ? [
        x0, y0, z0,  x0, y0, z1,  x1, y0, z1,
        x0, y0, z0,  x1, y0, z1,  x1, y0, z0,
    ] : [
        x0, y0, z0,  x0, y1, z0,  x1, y1, z0,
        x0, y0, z0,  x1, y1, z0,  x1, y0, z0,
    ]);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    return geo;
}

// Update the orange selection preview (rectangle on the selected face).
// Called every frame from the indoor animate loop.
export function updateCSGSelectionPreview(camera) {
    disposeMesh(selectionMesh);
    selectionMesh = null;

    const sel = state.csg.selectedFace;
    if (!sel || !isPointerLocked()) return;
    if (state.csg.holeMode) return; // hole preview takes over while in hole mode

    const faceInfo = getSelectedFaceInfo();
    if (!faceInfo) return;

    // Only show preview if the user is currently looking at the selected face
    const hit = pickCSGFace(camera, csgRegionMeshes);
    if (!hit || !facesMatch(hit, sel)) return;

    const { axis } = sel;
    const uv = worldToFaceUV(hit.point, axis);

    const sU = state.csg.selSizeU <= 0 ? faceInfo.uSize : Math.min(state.csg.selSizeU, faceInfo.uSize);
    const sV = state.csg.selSizeV <= 0 ? faceInfo.vSize : Math.min(state.csg.selSizeV, faceInfo.vSize);

    let u0 = Math.round(uv.u - sU / 2);
    let v0 = Math.round(uv.v - sV / 2);
    u0 = Math.max(faceInfo.uMin, Math.min(u0, faceInfo.uMax - sU));
    v0 = Math.max(faceInfo.vMin, Math.min(v0, faceInfo.vMax - sV));
    const u1 = u0 + sU;
    const v1 = v0 + sV;

    state.csg.selU0 = u0; state.csg.selU1 = u1;
    state.csg.selV0 = v0; state.csg.selV1 = v1;

    const geo = buildFaceQuad(sel, u0, u1, v0, v1, SEL_OFFSET);
    selectionMesh = new THREE.Mesh(geo, selectionMat);
    scene.add(selectionMesh);
}

// Update the yellow hole/door preview while in hole mode.
export function updateCSGHolePreview(camera) {
    disposeMesh(holeMesh);
    holeMesh = null;

    if (!state.csg.holeMode || !isPointerLocked()) return;

    const hit = pickCSGFace(camera, csgRegionMeshes);
    if (!hit) {
        state.csg.doorPreview = null;
        return;
    }

    const preview = computeHolePreview(hit, hit.point);
    if (!preview) return;

    const geo = buildFaceQuad(preview.face, preview.u0, preview.u1, preview.v0, preview.v1, HOLE_OFFSET);
    holeMesh = new THREE.Mesh(geo, holeMat);
    scene.add(holeMesh);
}

// Build a translucent box for an arch segment given WT-space {x,y,z,w,h,d}.
// `inset` shrinks the box slightly inside its bounds so it doesn't z-fight
// with whatever wall/ceiling face it sits flush against.
function buildBraceBox(r, inset) {
    const sx = r.w * WORLD_SCALE - 2 * inset;
    const sy = r.h * WORLD_SCALE - 2 * inset;
    const sz = r.d * WORLD_SCALE - 2 * inset;
    const geo = new THREE.BoxGeometry(sx, sy, sz);
    const cx = (r.x + r.w / 2) * WORLD_SCALE;
    const cy = (r.y + r.h / 2) * WORLD_SCALE;
    const cz = (r.z + r.d / 2) * WORLD_SCALE;
    geo.translate(cx, cy, cz);
    return geo;
}

// Update the yellow brace arch preview while in brace mode.
export function updateCSGBracePreview(camera) {
    for (const m of braceMeshes) disposeMesh(m);
    braceMeshes = [];

    if (!state.csg.braceMode || !isPointerLocked()) {
        state.csg.bracePreview = null;
        return;
    }

    const hit = pickCSGFace(camera, csgRegionMeshes);
    if (!hit) {
        state.csg.bracePreview = null;
        return;
    }

    const preview = computeBracePreview(hit, hit.point);
    if (!preview) return;

    for (const r of [preview.wall1, preview.ceiling, preview.wall2]) {
        const geo = buildBraceBox(r, BRACE_OFFSET);
        const mesh = new THREE.Mesh(geo, braceMat);
        scene.add(mesh);
        braceMeshes.push(mesh);
    }
}

// Update the yellow pillar preview while in pillar mode.
export function updateCSGPillarPreview(camera) {
    disposeMesh(pillarMesh);
    pillarMesh = null;

    if (!state.csg.pillarMode || !isPointerLocked()) {
        state.csg.pillarPreview = null;
        return;
    }

    const hit = pickCSGFace(camera, csgRegionMeshes);
    if (!hit) {
        state.csg.pillarPreview = null;
        return;
    }

    const preview = computePillarPreview(hit, hit.point);
    if (!preview) return;

    const geo = buildBraceBox(preview.box, BRACE_OFFSET);
    pillarMesh = new THREE.Mesh(geo, braceMat);
    scene.add(pillarMesh);
}
