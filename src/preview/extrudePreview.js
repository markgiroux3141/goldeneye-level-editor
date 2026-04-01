// Extrude tool preview — selection rectangles and hover preview

import * as THREE from 'three';
import { WORLD_SCALE } from '../core/Volume.js';
import { state } from '../state.js';
import { computeExtrudePlacement } from '../actions.js';
import { pickFace } from '../raycaster.js';
import { isPointerLocked } from '../input/input.js';
import { volumeMeshes } from '../mesh/MeshManager.js';
import { scene } from '../scene/setup.js';

const extrudePreviewGroup = new THREE.Group();
let _added = false;
const extrudeSelectionMat = new THREE.LineBasicMaterial({ color: 0x00ff00, linewidth: 2 });
const extrudeHoverMat = new THREE.LineBasicMaterial({ color: 0xffff00, linewidth: 2 });

function makeRectPoints(axis, side, position, bounds) {
    const { u0, u1, v0, v1 } = bounds;
    const W = WORLD_SCALE;
    const offset = 0.02;

    if (axis === 'x') {
        const px = position * W + (side === 'min' ? offset : -offset);
        return [
            new THREE.Vector3(px, v0*W, u0*W),
            new THREE.Vector3(px, v0*W, u1*W),
            new THREE.Vector3(px, v1*W, u1*W),
            new THREE.Vector3(px, v1*W, u0*W),
            new THREE.Vector3(px, v0*W, u0*W),
        ];
    } else if (axis === 'y') {
        const py = position * W + (side === 'min' ? offset : -offset);
        return [
            new THREE.Vector3(u0*W, py, v0*W),
            new THREE.Vector3(u1*W, py, v0*W),
            new THREE.Vector3(u1*W, py, v1*W),
            new THREE.Vector3(u0*W, py, v1*W),
            new THREE.Vector3(u0*W, py, v0*W),
        ];
    } else {
        const pz = position * W + (side === 'min' ? offset : -offset);
        return [
            new THREE.Vector3(u0*W, v0*W, pz),
            new THREE.Vector3(u1*W, v0*W, pz),
            new THREE.Vector3(u1*W, v1*W, pz),
            new THREE.Vector3(u0*W, v1*W, pz),
            new THREE.Vector3(u0*W, v0*W, pz),
        ];
    }
}

export function updateExtrudePreview(camera) {
    if (!_added) { scene.add(extrudePreviewGroup); _added = true; }
    while (extrudePreviewGroup.children.length > 0) {
        const child = extrudePreviewGroup.children[0];
        extrudePreviewGroup.remove(child);
        if (child.geometry) child.geometry.dispose();
    }

    if (state.tool !== 'extrude' || !isPointerLocked()) return;

    for (const sel of state.extrudeSelections) {
        const points = makeRectPoints(sel.axis, sel.side, sel.position, sel.bounds);
        const geo = new THREE.BufferGeometry().setFromPoints(points);
        extrudePreviewGroup.add(new THREE.Line(geo, extrudeSelectionMat));
    }

    if (state.extrudePhase === 'idle' || state.extrudePhase === 'selecting') {
        const hit = pickFace(camera, volumeMeshes);
        if (hit && hit.volumeId && !(hit.bounds.u0 === 0 && hit.bounds.u1 === 0)) {
            const vol = state.volumes.find(v => v.id === hit.volumeId);
            if (vol) {
                const hoverBounds = computeExtrudePlacement(vol, hit.axis, hit.side, hit.point, state.extrudeWidth, state.extrudeHeight);
                if (hoverBounds) {
                    const points = makeRectPoints(hit.axis, hit.side, hit.position, hoverBounds);
                    const geo = new THREE.BufferGeometry().setFromPoints(points);
                    extrudePreviewGroup.add(new THREE.Line(geo, extrudeHoverMat));
                }
            }
        }
    }
}
