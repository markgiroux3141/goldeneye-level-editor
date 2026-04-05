// Door placement preview — wireframe rectangle on hovered wall face

import * as THREE from 'three';
import { WORLD_SCALE } from '../core/Volume.js';
import { state } from '../state.js';
import { computeDoorPlacement } from '../core/Connection.js';
import { pickFace } from '../raycaster.js';
import { isPointerLocked } from '../input/input.js';
import { volumeMeshes } from '../mesh/MeshManager.js';
import { scene } from '../scene/setup.js';
import { PREVIEW_OFFSET_DOOR } from '../core/constants.js';

let doorPreviewMesh = null;
const doorPreviewMat = new THREE.LineBasicMaterial({ color: 0x00ff00, linewidth: 2 });

export function updateDoorPreview(camera) {
    if (doorPreviewMesh) {
        scene.remove(doorPreviewMesh);
        doorPreviewMesh.geometry.dispose();
        doorPreviewMesh = null;
    }

    if (state.tool !== 'door' || !isPointerLocked()) return;

    const hit = pickFace(camera, volumeMeshes);
    if (!hit || !hit.volumeId || hit.axis === 'y') return;
    if (hit.bounds.u0 === 0 && hit.bounds.u1 === 0) return;

    const vol = state.volumes.find(v => v.id === hit.volumeId);
    if (!vol) return;

    const doorBounds = computeDoorPlacement(vol, hit.axis, hit.side, hit.point, state.doorWidth, state.doorHeight);
    if (!doorBounds) return;

    const { u0, u1, v0, v1 } = doorBounds;
    const pos = hit.position;
    const offset = PREVIEW_OFFSET_DOOR;
    const W = WORLD_SCALE;

    let points;
    if (hit.axis === 'x') {
        const px = pos * W + (hit.side === 'min' ? offset : -offset);
        points = [
            new THREE.Vector3(px, v0*W, u0*W),
            new THREE.Vector3(px, v0*W, u1*W),
            new THREE.Vector3(px, v1*W, u1*W),
            new THREE.Vector3(px, v1*W, u0*W),
            new THREE.Vector3(px, v0*W, u0*W),
        ];
    } else {
        const pz = pos * W + (hit.side === 'min' ? offset : -offset);
        points = [
            new THREE.Vector3(u0*W, v0*W, pz),
            new THREE.Vector3(u1*W, v0*W, pz),
            new THREE.Vector3(u1*W, v1*W, pz),
            new THREE.Vector3(u0*W, v1*W, pz),
            new THREE.Vector3(u0*W, v0*W, pz),
        ];
    }

    const geo = new THREE.BufferGeometry().setFromPoints(points);
    doorPreviewMesh = new THREE.Line(geo, doorPreviewMat);
    scene.add(doorPreviewMesh);
}
