// Main entry point — wires all modules together

import * as THREE from 'three';
import { initScene, scene, renderer, camera } from './scene.js';
import { initInput, initKeyActions, onKeyDown, isPointerLocked } from './input.js';
import { updateCamera } from './camera.js';
import { Volume, WORLD_SCALE } from './core/Volume.js';
import { state, deserializeLevel } from './state.js';
import { initMaterials, getWallMaterial } from './materials.js';
import { buildVolumeGeometry } from './geometry.js';
import { getConnectionsForFace, computeDoorPlacement } from './core/Connection.js';
import { pickFace } from './raycaster.js';
import { showMessage, updateHUD, initHUD } from './hud.js';
import { loadFromLocalStorage } from './io/LevelStorage.js';
import {
    pushSelectedFace, pullSelectedFace,
    deleteSelectedVolume, placeDoorOnFace, undoAction,
    saveLevel, loadLevel,
    addExtrudeSelection, executeExtrude, reExtrudeVolumes,
    extrudeUntilBlocked, clearExtrudeState, computeExtrudePlacement,
    snapToWTGrid, placeStaircase, clearStairState,
} from './actions.js';
import { buildStaircaseGeometry, buildStaircasePreviewLines } from './staircaseGeometry.js';

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

// Extrude preview group
const extrudePreviewGroup = new THREE.Group();
scene.add(extrudePreviewGroup);
const extrudeSelectionMat = new THREE.LineBasicMaterial({ color: 0x00ff00, linewidth: 2 });
const extrudeHoverMat = new THREE.LineBasicMaterial({ color: 0xffff00, linewidth: 2 });

// Staircase mesh storage: Map<staircaseId, THREE.Mesh>
const staircaseMeshes = new Map();

// Stair preview group
const stairPreviewGroup = new THREE.Group();
scene.add(stairPreviewGroup);
const stairPreviewMat = new THREE.LineBasicMaterial({ color: 0x00ff00, linewidth: 2 });
const stairMarkerMat = new THREE.LineBasicMaterial({ color: 0xffff00, linewidth: 2 });

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
// STAIRCASE MESH MANAGEMENT
// ============================================================
function rebuildStaircase(stair) {
    const old = staircaseMeshes.get(stair.id);
    if (old) {
        scene.remove(old);
        old.geometry.dispose();
    }

    const geometry = buildStaircaseGeometry(stair);
    const material = getWallMaterial();
    material.vertexColors = true;
    material.map.repeat.set(1, 1);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData = { staircaseId: stair.id };

    const edges = new THREE.EdgesGeometry(geometry);
    const wireframe = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x333333 }));
    mesh.add(wireframe);

    staircaseMeshes.set(stair.id, mesh);
    scene.add(mesh);
}

function rebuildAllStaircases() {
    for (const [id, mesh] of staircaseMeshes) {
        scene.remove(mesh);
        mesh.geometry.dispose();
    }
    staircaseMeshes.clear();
    for (const stair of state.staircases) {
        rebuildStaircase(stair);
    }
}

// Rebuild everything (volumes + staircases) — used for undo/load
function rebuildAll() {
    rebuildAllVolumes();
    rebuildAllStaircases();
}

// ============================================================
// TOOL CYCLING
// ============================================================
const TOOL_CYCLE = ['push_pull', 'door', 'extrude', 'stair'];
const TOOL_NAMES = { push_pull: 'Push/Pull', door: 'Door', extrude: 'Extrude', stair: 'Stair' };

function cycleToolForward() {
    const idx = TOOL_CYCLE.indexOf(state.tool);
    state.tool = TOOL_CYCLE[(idx + 1) % TOOL_CYCLE.length];
    if (state.tool !== 'extrude') clearExtrudeState();
    if (state.tool !== 'stair') clearStairState();
    showMessage('Tool: ' + TOOL_NAMES[state.tool]);
}

// ============================================================
// MOUSE CLICK — FACE SELECTION / DOOR PLACEMENT / EXTRUDE SELECT
// ============================================================
document.addEventListener('mousedown', (e) => {
    if (!isPointerLocked() || e.button !== 0) return;

    const hit = pickFace(camera, volumeMeshes);

    if (state.tool === 'stair') {
        if (!hit) return; // need a surface to click on
        const snapped = snapToWTGrid(hit.point);
        if (state.stairPhase === 'idle') {
            // First click — set top point
            state.stairTopPoint = snapped;
            state.stairPhase = 'top_set';
            showMessage(`Top set at (${snapped.x}, ${snapped.y}, ${snapped.z})`);
        } else if (state.stairPhase === 'top_set') {
            // Second click — place staircase
            placeStaircase(state.stairTopPoint, snapped, showMessage, rebuildStaircase);
            clearStairState();
        }
        return;
    }

    if (!hit) {
        if (state.tool === 'extrude') {
            clearExtrudeState();
        }
        state.selectedFace = null;
        rebuildAllVolumes();
        return;
    }

    if (state.tool === 'extrude') {
        // Don't select tunnel faces
        if (hit.bounds.u0 === 0 && hit.bounds.u1 === 0) return;

        if (!e.shiftKey) {
            clearExtrudeState();
        }
        addExtrudeSelection(hit.volumeId, hit.axis, hit.side, hit.point, showMessage);
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
    // Extrude tool: +/- for extrude/shrink, Shift++ for extrude until blocked
    if (state.tool === 'extrude') {
        if (e.key === '=' || e.key === '+') {
            e.preventDefault();
            if (e.shiftKey && state.extrudePhase === 'extruded') {
                extrudeUntilBlocked(showMessage, rebuildAllVolumes);
            } else if (state.extrudePhase === 'selecting') {
                executeExtrude(showMessage, rebuildAllVolumes);
            } else if (state.extrudePhase === 'extruded') {
                reExtrudeVolumes('push', showMessage, rebuildAllVolumes);
            }
            return;
        }
        if (e.key === '-') {
            e.preventDefault();
            if (state.extrudePhase === 'extruded') {
                reExtrudeVolumes('pull', showMessage, rebuildAllVolumes);
            }
            return;
        }
    }

    // Push/Pull tool: +/- for push/pull
    if ((e.key === '=' || e.key === '+') && state.selectedFace && state.tool === 'push_pull') {
        e.preventDefault();
        pushSelectedFace(showMessage, rebuildVolume, rebuildAllVolumes);
        return;
    }

    if (e.key === '-' && state.selectedFace && state.tool === 'push_pull') {
        e.preventDefault();
        pullSelectedFace(showMessage, rebuildVolume);
        return;
    }

    // Stair tool: R to toggle side
    if (e.code === 'KeyR' && state.tool === 'stair' && isPointerLocked()) {
        e.preventDefault();
        state.stairSide = state.stairSide === 'right' ? 'left' : 'right';
        showMessage('Stair side: ' + state.stairSide.toUpperCase());
        return;
    }

    if (e.code === 'KeyT' && isPointerLocked()) {
        e.preventDefault();
        cycleToolForward();
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
        clearExtrudeState();
        clearStairState();
        undoAction(showMessage, rebuildAll);
        return;
    }

    if (e.ctrlKey && e.code === 'KeyS') {
        e.preventDefault();
        saveLevel(showMessage);
        return;
    }

    if (e.ctrlKey && e.code === 'KeyO') {
        e.preventDefault();
        loadLevel(showMessage, rebuildAll);
        return;
    }

    if (e.code === 'Escape') {
        if (state.tool === 'extrude') {
            clearExtrudeState();
        }
        if (state.tool === 'stair') {
            clearStairState();
            showMessage('Stair placement cancelled');
        }
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
    const saved = loadFromLocalStorage();
    if (saved) {
        const data = JSON.parse(saved);
        if (data.volumes && data.volumes.length > 0) {
            deserializeLevel(saved);
            rebuildAll();
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

    const doorBounds = computeDoorPlacement(vol, hit.axis, hit.side, hit.point, state.doorWidth, state.doorHeight);
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
// EXTRUDE PREVIEW
// ============================================================
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
    } else { // z
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

function updateExtrudePreview() {
    // Clear previous preview objects
    while (extrudePreviewGroup.children.length > 0) {
        const child = extrudePreviewGroup.children[0];
        extrudePreviewGroup.remove(child);
        if (child.geometry) child.geometry.dispose();
    }

    if (state.tool !== 'extrude' || !isPointerLocked()) return;

    // Draw committed selections as green rectangles
    for (const sel of state.extrudeSelections) {
        const points = makeRectPoints(sel.axis, sel.side, sel.position, sel.bounds);
        const geo = new THREE.BufferGeometry().setFromPoints(points);
        extrudePreviewGroup.add(new THREE.Line(geo, extrudeSelectionMat));
    }

    // Draw hover preview as yellow rectangle (only in idle or selecting phase)
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

// ============================================================
// STAIR PREVIEW
// ============================================================
function updateStairPreview() {
    // Clear previous preview
    while (stairPreviewGroup.children.length > 0) {
        const child = stairPreviewGroup.children[0];
        stairPreviewGroup.remove(child);
        if (child.geometry) child.geometry.dispose();
    }

    if (state.tool !== 'stair' || !isPointerLocked()) return;

    const hit = pickFace(camera, volumeMeshes);
    if (!hit) return;

    const snapped = snapToWTGrid(hit.point);
    const W = WORLD_SCALE;

    if (state.stairPhase === 'idle') {
        // Yellow marker at snapped position
        const s = 0.5; // half-size of marker cube in WT
        const cx = snapped.x, cy = snapped.y, cz = snapped.z;
        const pts = [
            new THREE.Vector3((cx-s)*W, (cy-s)*W, (cz-s)*W),
            new THREE.Vector3((cx+s)*W, (cy-s)*W, (cz-s)*W),
            new THREE.Vector3((cx+s)*W, (cy+s)*W, (cz-s)*W),
            new THREE.Vector3((cx-s)*W, (cy+s)*W, (cz-s)*W),
            new THREE.Vector3((cx-s)*W, (cy-s)*W, (cz-s)*W),
            new THREE.Vector3((cx-s)*W, (cy-s)*W, (cz+s)*W),
            new THREE.Vector3((cx+s)*W, (cy-s)*W, (cz+s)*W),
            new THREE.Vector3((cx+s)*W, (cy+s)*W, (cz+s)*W),
            new THREE.Vector3((cx-s)*W, (cy+s)*W, (cz+s)*W),
            new THREE.Vector3((cx-s)*W, (cy-s)*W, (cz+s)*W),
        ];
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        stairPreviewGroup.add(new THREE.Line(geo, stairMarkerMat));
    } else if (state.stairPhase === 'top_set') {
        // Green wireframe staircase preview from stored top to current hover
        const topPt = state.stairTopPoint;
        const bottomPt = snapped;

        // Validate: need height difference and horizontal distance
        if (topPt.y > bottomPt.y) {
            const dx = Math.abs(topPt.x - bottomPt.x);
            const dz = Math.abs(topPt.z - bottomPt.z);
            if (dx > 0 || dz > 0) {
                const previewSteps = Math.max(1, Math.round((topPt.y - bottomPt.y) / state.stairStepHeight));
                const pts = buildStaircasePreviewLines(
                    topPt, bottomPt, state.stairWidth, previewSteps, state.stairSide
                );
                const geo = new THREE.BufferGeometry().setFromPoints(pts);
                stairPreviewGroup.add(new THREE.LineSegments(geo, stairPreviewMat));
            }
        }

        // Also draw a yellow marker at the stored top point
        const s = 0.5;
        const cx = topPt.x, cy = topPt.y, cz = topPt.z;
        const markerPts = [
            new THREE.Vector3((cx-s)*W, (cy-s)*W, (cz-s)*W),
            new THREE.Vector3((cx+s)*W, (cy-s)*W, (cz-s)*W),
            new THREE.Vector3((cx+s)*W, (cy+s)*W, (cz-s)*W),
            new THREE.Vector3((cx-s)*W, (cy+s)*W, (cz-s)*W),
            new THREE.Vector3((cx-s)*W, (cy-s)*W, (cz-s)*W),
            new THREE.Vector3((cx-s)*W, (cy-s)*W, (cz+s)*W),
            new THREE.Vector3((cx+s)*W, (cy-s)*W, (cz+s)*W),
            new THREE.Vector3((cx+s)*W, (cy+s)*W, (cz+s)*W),
            new THREE.Vector3((cx-s)*W, (cy+s)*W, (cz+s)*W),
            new THREE.Vector3((cx-s)*W, (cy-s)*W, (cz+s)*W),
        ];
        const markerGeo = new THREE.BufferGeometry().setFromPoints(markerPts);
        stairPreviewGroup.add(new THREE.Line(markerGeo, stairMarkerMat));
    }
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
    updateExtrudePreview();
    updateStairPreview();
    updateHUD(camera);
    renderer.render(scene, camera);
}

animate();
