// Main entry point — wires all modules together

import * as THREE from 'three';
import { initScene, scene, renderer, camera } from './scene.js';
import { initInput, initKeyActions, onKeyDown, isPointerLocked } from './input.js';
import { updateCamera } from './camera.js';
import { Volume, WORLD_SCALE } from './volume.js';
import { state, deserializeLevel } from './state.js';
import { initMaterials, getWallMaterial } from './materials.js';
import { buildVolumeGeometry } from './geometry.js';
import { getConnectionsForFace, computeDoorPlacement } from './connection.js';
import { pickFace } from './raycaster.js';
import { showMessage, updateHUD, initHUD } from './hud.js';
import {
    pushSelectedFace, pullSelectedFace,
    deleteSelectedVolume, placeDoorOnFace, undoAction,
    saveLevel, loadLevel,
} from './actions.js';

// ============================================================
// INIT
// ============================================================
initScene();
initMaterials();
initInput(renderer.domElement);
initKeyActions();
initHUD();

// Volume mesh storage: Map<volumeId, { mesh, faceIds }>
const volumeMeshes = new Map();

// Door preview wireframe
let doorPreviewMesh = null;
const doorPreviewMat = new THREE.LineBasicMaterial({ color: 0x00ff00, linewidth: 2 });

// ============================================================
// MESH MANAGEMENT
// ============================================================
function getVolumeConnections(volId) {
    return state.connections.filter(c => c.volAId === volId || c.volBId === volId);
}

function rebuildVolume(vol) {
    const old = volumeMeshes.get(vol.id);
    if (old) {
        scene.remove(old.mesh);
        old.mesh.geometry.dispose();
    }

    const conns = getVolumeConnections(vol.id);
    const { geometry, faceIds } = buildVolumeGeometry(vol, conns, state.selectedFace);

    const material = getWallMaterial();
    material.vertexColors = true;
    material.map.repeat.set(1, 1);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData = { volumeId: vol.id };

    const edges = new THREE.EdgesGeometry(geometry);
    const wireframe = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x333333 }));
    mesh.add(wireframe);

    volumeMeshes.set(vol.id, { mesh, faceIds });
    scene.add(mesh);
}

function rebuildAllVolumes() {
    for (const [id, data] of volumeMeshes) {
        scene.remove(data.mesh);
        data.mesh.geometry.dispose();
    }
    volumeMeshes.clear();

    for (const vol of state.volumes) {
        rebuildVolume(vol);
    }
}

function removeVolumeMesh(volId) {
    const data = volumeMeshes.get(volId);
    if (data) {
        scene.remove(data.mesh);
        data.mesh.geometry.dispose();
        volumeMeshes.delete(volId);
    }
}

// ============================================================
// MOUSE CLICK — FACE SELECTION / DOOR PLACEMENT
// ============================================================
document.addEventListener('mousedown', (e) => {
    if (!isPointerLocked() || e.button !== 0) return;

    const hit = pickFace(camera, volumeMeshes);

    if (!hit) {
        state.selectedFace = null;
        rebuildAllVolumes();
        return;
    }

    if (state.tool === 'door' && hit.bounds.u0 !== 0 && hit.bounds.u1 !== 0) {
        // Door tool — place door on the face
        placeDoorOnFace(hit.volumeId, hit.axis, hit.side, hit.point, showMessage, rebuildVolume);
    } else {
        // Select the face
        state.selectedFace = hit;
        rebuildAllVolumes();
    }
});

// ============================================================
// KEY ACTIONS
// ============================================================
onKeyDown((e) => {
    if ((e.key === '=' || e.key === '+') && state.selectedFace) {
        e.preventDefault();
        pushSelectedFace(showMessage, rebuildVolume, rebuildAllVolumes);
        return;
    }

    if (e.key === '-' && state.selectedFace) {
        e.preventDefault();
        pullSelectedFace(showMessage, rebuildVolume);
        return;
    }

    if (e.code === 'KeyT' && isPointerLocked()) {
        e.preventDefault();
        state.tool = state.tool === 'push_pull' ? 'door' : 'push_pull';
        showMessage('Tool: ' + (state.tool === 'push_pull' ? 'Push/Pull' : 'Door'));
        return;
    }

    if ((e.code === 'KeyX' || e.key === 'Delete') && state.selectedFace && isPointerLocked()) {
        e.preventDefault();
        const deletedId = deleteSelectedVolume(showMessage, rebuildAllVolumes);
        if (deletedId) removeVolumeMesh(deletedId);
        return;
    }

    if (e.ctrlKey && e.code === 'KeyZ') {
        e.preventDefault();
        undoAction(showMessage, rebuildAllVolumes);
        return;
    }

    if (e.ctrlKey && e.code === 'KeyS') {
        e.preventDefault();
        saveLevel(showMessage);
        return;
    }

    if (e.ctrlKey && e.code === 'KeyO') {
        e.preventDefault();
        loadLevel(showMessage, rebuildAllVolumes);
        return;
    }

    if (e.code === 'Escape') {
        state.selectedFace = null;
        rebuildAllVolumes();
    }
});

// ============================================================
// INIT — start with one volume
// ============================================================
const firstVolume = new Volume(state.nextVolumeId++, 0, 0, 0, 16, 12, 16);
state.volumes.push(firstVolume);
rebuildVolume(firstVolume);

// Try loading saved level
try {
    const saved = localStorage.getItem('goldeneye-level');
    if (saved) {
        const data = JSON.parse(saved);
        if (data.volumes && data.volumes.length > 0) {
            deserializeLevel(saved);
            rebuildAllVolumes();
        }
    }
} catch (e) { /* ignore */ }

// ============================================================
// DOOR PREVIEW
// ============================================================
function updateDoorPreview() {
    // Remove old preview
    if (doorPreviewMesh) {
        scene.remove(doorPreviewMesh);
        doorPreviewMesh.geometry.dispose();
        doorPreviewMesh = null;
    }

    if (state.tool !== 'door' || !isPointerLocked()) return;

    const hit = pickFace(camera, volumeMeshes);
    if (!hit || !hit.volumeId || hit.axis === 'y') return;
    // Don't preview on tunnel faces (zero-size bounds)
    if (hit.bounds.u0 === 0 && hit.bounds.u1 === 0) return;

    const vol = state.volumes.find(v => v.id === hit.volumeId);
    if (!vol) return;

    const doorBounds = computeDoorPlacement(vol, hit.axis, hit.side, hit.point);
    if (!doorBounds) return;

    const { u0, u1, v0, v1 } = doorBounds;
    const pos = hit.position;
    const offset = 0.01; // slight offset to avoid z-fighting with wall
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
    } else { // z
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

// ============================================================
// RENDER LOOP
// ============================================================
const clock = new THREE.Clock();

function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();
    updateCamera(camera, dt);
    updateDoorPreview();
    updateHUD(camera);
    renderer.render(scene, camera);
}

animate();
