// Main entry point — wires all modules together

import * as THREE from 'three';
import { initScene, scene, renderer, camera } from './scene.js';
import { initInput, initKeyActions, onKeyDown, isPointerLocked, consumeMouseDelta } from './input.js';
import { updateCamera } from './camera.js';
import { Volume, WORLD_SCALE } from './core/Volume.js';
import { state, deserializeLevel, saveUndoState } from './state.js';
import { initMaterials, getWallMaterial, getTexturedMaterialArray, getTexturedMaterialArrayForScheme } from './materials.js';
import { TEXTURE_SCHEMES, getSchemeByKey, loadTextureSchemes } from './textureSchemes.js';
import { buildVolumeGeometry } from './geometry.js';
import { getConnectionsForFace, computeDoorPlacement } from './core/Connection.js';
import { pickFace, pickPlatform, pickAny, pickGroundOnly } from './raycaster.js';
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
import { Platform } from './core/Platform.js';
import { buildPlatformGeometry, buildPlatformPreviewLines, buildEdgeHighlightLines, buildEdgeSlotLines, buildStairRunGeometry, buildStairRunPreviewLines } from './platformGeometry.js';
import { StairRun } from './core/StairRun.js';
import { PlatformGizmo } from './gizmo.js';

// ============================================================
// INIT
// ============================================================
initScene();
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

// Platform mesh storage: Map<platformId, THREE.Mesh>
const platformMeshes = new Map();

// Platform preview group
const platformPreviewGroup = new THREE.Group();
scene.add(platformPreviewGroup);
const platformPreviewMat = new THREE.LineBasicMaterial({ color: 0xffff00, linewidth: 2 });
const platformSelectionMat = new THREE.LineBasicMaterial({ color: 0x00ff00, linewidth: 2 });
const platformEdgeHighlightMat = new THREE.LineBasicMaterial({ color: 0x00ffff, linewidth: 3 });

// Platform gizmo (move arrows + scale handles)
const gizmo = new PlatformGizmo(scene);

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
    const options = {};
    if (state.viewMode === 'textured') {
        options.viewMode = 'textured';
        options.wallSplitV = vol.y + Math.floor(state.doorHeight * 0.75);
    }
    const { geometry, faceIds } = buildVolumeGeometry(vol, conns, state.selectedFace, options);

    let material;
    if (state.viewMode === 'textured') {
        material = getTexturedMaterialArrayForScheme(vol.textureScheme);
    } else {
        material = getWallMaterial();
        material.vertexColors = true;
        material.map.repeat.set(1, 1);
    }
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

    const options = {};
    if (state.viewMode === 'textured') {
        options.viewMode = 'textured';
    }
    const geometry = buildStaircaseGeometry(stair, options);

    let material;
    if (state.viewMode === 'textured') {
        material = getTexturedMaterialArray();
    } else {
        material = getWallMaterial();
        material.vertexColors = true;
        material.map.repeat.set(1, 1);
    }
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

// ============================================================
// PLATFORM MESH MANAGEMENT
// ============================================================
function rebuildPlatform(plat) {
    const old = platformMeshes.get(plat.id);
    if (old) {
        scene.remove(old);
        old.geometry.dispose();
    }

    const options = {};
    if (state.viewMode === 'textured') {
        options.viewMode = 'textured';
    }
    const geometry = buildPlatformGeometry(plat, options);

    let material;
    if (state.viewMode === 'textured') {
        material = getTexturedMaterialArray();
    } else {
        material = getWallMaterial();
        material.vertexColors = true;
        material.map.repeat.set(1, 1);
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData = { platformId: plat.id };

    const edges = new THREE.EdgesGeometry(geometry);
    const wireframe = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x333333 }));
    mesh.add(wireframe);

    platformMeshes.set(plat.id, mesh);
    scene.add(mesh);
}

function rebuildAllPlatforms() {
    for (const [id, mesh] of platformMeshes) {
        scene.remove(mesh);
        mesh.geometry.dispose();
    }
    platformMeshes.clear();
    for (const plat of state.platforms) {
        rebuildPlatform(plat);
    }
}

function removePlatformMesh(platId) {
    const data = platformMeshes.get(platId);
    if (data) {
        scene.remove(data);
        data.geometry.dispose();
        platformMeshes.delete(platId);
    }
}

// ============================================================
// STAIR RUN MESH MANAGEMENT
// ============================================================
const stairRunMeshes = new Map();

function rebuildStairRun(run) {
    const old = stairRunMeshes.get(run.id);
    if (old) {
        scene.remove(old);
        old.geometry.dispose();
    }

    const fromPlat = run.fromPlatformId != null ? state.platforms.find(p => p.id === run.fromPlatformId) : null;
    const toPlat = run.toPlatformId != null ? state.platforms.find(p => p.id === run.toPlatformId) : null;

    const options = {};
    if (state.viewMode === 'textured') {
        options.viewMode = 'textured';
    }
    const geometry = buildStairRunGeometry(run, fromPlat, toPlat, options);

    let material;
    if (state.viewMode === 'textured') {
        material = getTexturedMaterialArray();
    } else {
        material = getWallMaterial();
        material.vertexColors = true;
        material.map.repeat.set(1, 1);
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData = { stairRunId: run.id };

    const edges = new THREE.EdgesGeometry(geometry);
    const wireframe = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x333333 }));
    mesh.add(wireframe);

    stairRunMeshes.set(run.id, mesh);
    scene.add(mesh);
}

function rebuildAllStairRuns() {
    for (const [id, mesh] of stairRunMeshes) {
        scene.remove(mesh);
        mesh.geometry.dispose();
    }
    stairRunMeshes.clear();
    for (const run of state.stairRuns) {
        rebuildStairRun(run);
    }
}

// Rebuild all stair runs connected to a specific platform
function rebuildConnectedStairRuns(platformId) {
    for (const run of state.stairRuns) {
        if (run.fromPlatformId === platformId || run.toPlatformId === platformId) {
            rebuildStairRun(run);
        }
    }
}

// Rebuild everything (volumes + staircases + platforms + stair runs) — used for undo/load
function rebuildAll() {
    rebuildAllVolumes();
    rebuildAllStaircases();
    rebuildAllPlatforms();
    rebuildAllStairRuns();
}

// ============================================================
// TOOL CYCLING
// ============================================================
const TOOL_CYCLE = ['push_pull', 'door', 'extrude', 'stair', 'platform'];
const TOOL_NAMES = { push_pull: 'Push/Pull', door: 'Door', extrude: 'Extrude', stair: 'Stair', platform: 'Platform' };

function clearPlatformToolState() {
    if (gizmo.isDragging()) gizmo.cancelDrag();
    state.platformPhase = 'idle';
    state.selectedPlatformId = null;
    state.selectedStairRunId = null;
    state.platformMoveAxis = null;
    state.platformScaleAxis = null;
    state.platformConnectFrom = null;
    state.platformConnectTo = null;
    gizmo.update(null, camera);
}

function cycleToolForward() {
    const idx = TOOL_CYCLE.indexOf(state.tool);
    state.tool = TOOL_CYCLE[(idx + 1) % TOOL_CYCLE.length];
    if (state.tool !== 'extrude') clearExtrudeState();
    if (state.tool !== 'stair') clearStairState();
    if (state.tool !== 'platform') clearPlatformToolState();
    showMessage('Tool: ' + TOOL_NAMES[state.tool]);
}

// ============================================================
// MOUSE CLICK — FACE SELECTION / DOOR PLACEMENT / EXTRUDE SELECT
// ============================================================
document.addEventListener('mousedown', (e) => {
    if (!isPointerLocked() || e.button !== 0) return;

    const hit = pickFace(camera, volumeMeshes);

    // Platform tool click handling
    if (state.tool === 'platform') {
        console.log('[platform click] phase:', state.platformPhase, 'connectFrom:', state.platformConnectFrom);
        // If gizmo is being dragged, click confirms the drag
        if (gizmo.isDragging()) {
            gizmo.endDrag();
            rebuildPlatform(state.platforms.find(p => p.id === state.selectedPlatformId));
            rebuildConnectedStairRuns(state.selectedPlatformId);
            showMessage('Confirmed');
            return;
        }

        if (state.platformPhase === 'idle' || state.platformPhase === 'selected') {
            // Check if clicking a gizmo handle (only when a platform is selected)
            if (state.selectedPlatformId != null) {
                const gizmoHit = gizmo.pick(camera);
                if (gizmoHit) {
                    const plat = state.platforms.find(p => p.id === state.selectedPlatformId);
                    saveUndoState();
                    gizmo.startDrag(gizmoHit.type, gizmoHit.axis, plat);
                    const label = gizmoHit.type === 'move' ? `Moving ${gizmoHit.axis.toUpperCase()}` : `Scaling ${gizmoHit.axis}`;
                    showMessage(`${label} — move mouse to drag, click to confirm, Esc to cancel`);
                    return;
                }
            }

            // Try to select an existing platform
            const platHit = pickPlatform(camera, platformMeshes);
            if (platHit) {
                state.selectedPlatformId = platHit.platformId;
                state.platformPhase = 'selected';
                const plat = state.platforms.find(p => p.id === platHit.platformId);
                showMessage(`Selected platform ${platHit.platformId} (${plat.sizeX}x${plat.sizeZ} at Y=${plat.y})`);
                return;
            }

            // If already selected and clicked empty, deselect
            if (state.platformPhase === 'selected') {
                clearPlatformToolState();
                gizmo.update(null, camera);
                return;
            }

            // Place new platform at the hit surface
            const anyHit = pickAny(camera, volumeMeshes, platformMeshes);
            if (!anyHit) return;
            const snapped = snapToWTGrid(anyHit.point);

            // Offset placement so platform edge touches wall instead of centering on click
            let px = snapped.x - Math.floor(state.platformSizeX / 2);
            let py = snapped.y;
            let pz = snapped.z - Math.floor(state.platformSizeZ / 2);

            if (anyHit.type === 'volume' && anyHit.axis !== 'y') {
                // Place platform flush against the wall, extending toward the camera
                const camPos = camera.position;
                if (anyHit.axis === 'x') {
                    const wallX = snapped.x;
                    if (camPos.x / WORLD_SCALE > wallX) {
                        px = wallX; // platform extends in +X (toward camera)
                    } else {
                        px = wallX - state.platformSizeX; // extends in -X
                    }
                } else { // z
                    const wallZ = snapped.z;
                    if (camPos.z / WORLD_SCALE > wallZ) {
                        pz = wallZ;
                    } else {
                        pz = wallZ - state.platformSizeZ;
                    }
                }
            }

            saveUndoState();
            const plat = new Platform(
                state.nextPlatformId++,
                px, py, pz,
                state.platformSizeX, state.platformSizeZ, state.platformThickness,
            );
            state.platforms.push(plat);
            rebuildPlatform(plat);
            state.selectedPlatformId = plat.id;
            state.platformPhase = 'selected';
            showMessage(`Placed platform ${plat.id} at (${plat.x}, ${plat.y}, ${plat.z})`);
            return;
        }
        // Phase 1: click to pick destination (floor or another platform)
        if (state.platformPhase === 'connecting_dst' && state.platformConnectFrom) {
            const from = state.platformConnectFrom;
            const fromPlat = state.platforms.find(p => p.id === from.platformId);
            const anyHit = pickAny(camera, volumeMeshes, platformMeshes);
            console.log('[connect-dst] pickAny result:', anyHit ? { type: anyHit.type, platformId: anyHit.platformId, point: anyHit.point } : null);
            if (!anyHit) { showMessage('Click a platform or the floor'); return; }

            if (anyHit.type === 'platform' && anyHit.platformId !== from.platformId) {
                // Destination is another platform
                const toPlat = state.platforms.find(p => p.id === anyHit.platformId);
                const edge = closestPlatformEdge(toPlat, anyHit.point);
                state.platformConnectTo = { type: 'platform', platformId: toPlat.id, edge };
                // Auto-select source edge facing toward destination platform
                const dir = { x: toPlat.centerX - fromPlat.centerX, z: toPlat.centerZ - fromPlat.centerZ };
                state.platformConnectFrom.edge = bestEdgeForDirection(fromPlat, dir);
            } else if (anyHit.type === 'ground' || anyHit.type === 'volume') {
                // Destination is the floor (ground plane or volume surface)
                state.platformConnectTo = { type: 'ground' };
                const gp = snapToWTGrid(anyHit.point);
                state.platformConnectTo.y = gp.y;
                const dir = { x: gp.x - fromPlat.centerX, z: gp.z - fromPlat.centerZ };
                state.platformConnectFrom.edge = bestEdgeForDirection(fromPlat, dir);
            } else {
                showMessage('Click a platform or the floor');
                return;
            }

            state.platformConnectFrom.offset = 0.5;
            state.platformPhase = 'connecting_src';
            showMessage('Slide along edge — click to place stairs, Esc to cancel');
            return;
        }

        // Phase 2: click to lock source position and create stairs
        if (state.platformPhase === 'connecting_src' && state.platformConnectFrom && state.platformConnectTo) {
            const from = state.platformConnectFrom;
            const to = state.platformConnectTo;
            const fromPlat = state.platforms.find(p => p.id === from.platformId);
            const offset = projectCrosshairOntoEdge(fromPlat, from.edge, camera);

            let toPlatformId = null;
            let anchorTo = null;

            // Resolve source point
            const fromPt = fromPlat.getEdgePointAtOffset(from.edge, offset);
            fromPt.y = fromPlat.y;

            let toPt;
            if (to.type === 'platform') {
                const toPlat = state.platforms.find(p => p.id === to.platformId);
                // Compute destination offset as closest point on dest edge to source point
                const destOffset = closestOffsetOnEdge(toPlat, to.edge, fromPt);
                toPlatformId = toPlat.id;
                anchorTo = { edge: to.edge, offset: destOffset };
                toPt = { ...toPlat.getEdgePointAtOffset(to.edge, destOffset), y: toPlat.y };
            } else {
                // Ground/volume surface: project from source along edge normal
                const normal = Platform.edgeNormal(from.edge);
                const destY = to.y ?? 0;
                const rise = fromPlat.y - destY;
                const run = rise / state.stairRiseOverRun;
                const gx = fromPt.x + normal.x * run;
                const gz = fromPt.z + normal.z * run;
                const snappedX = Math.round(gx);
                const snappedZ = Math.round(gz);
                anchorTo = { x: snappedX, y: destY, z: snappedZ };
                toPt = { x: snappedX, y: destY, z: snappedZ };
            }

            const ddx = Math.abs(toPt.x - fromPt.x);
            const ddz = Math.abs(toPt.z - fromPt.z);
            if (ddx < 1 && ddz < 1) {
                showMessage('Need horizontal distance between endpoints');
                return;
            }

            const rise = Math.abs(toPt.y - fromPt.y);
            if (rise === 0) {
                showMessage('Platforms are at the same height — no stairs needed');
                return;
            }

            saveUndoState();
            const run = new StairRun(
                state.nextStairRunId++,
                from.platformId,
                toPlatformId,
                { edge: from.edge, offset },
                anchorTo,
                state.stairWidth,
                state.stairStepHeight,
                state.stairRiseOverRun,
            );
            state.stairRuns.push(run);
            rebuildStairRun(run);

            const steps = Math.max(1, Math.round(rise / state.stairStepHeight));
            showMessage(`Stair run created: ${steps} steps`);

            state.platformPhase = 'selected';
            state.platformConnectFrom = null;
            state.platformConnectTo = null;
            return;
        }
        return;
    }

    if (state.tool === 'stair') {
        if (!hit) return; // need a surface to click on
        const snapped = snapToWTGrid(hit.point);
        state.stairWaypoints.push(snapped);
        state.stairPhase = 'placing';
        showMessage(`Waypoint ${state.stairWaypoints.length} at (${snapped.x}, ${snapped.y}, ${snapped.z})`);
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
        if (hit.bounds.u0 === 0 && hit.bounds.u1 === 0 && hit.bounds.v0 === 0 && hit.bounds.v1 === 0) return;

        if (!e.shiftKey) {
            clearExtrudeState();
        }
        addExtrudeSelection(hit.volumeId, hit.axis, hit.side, hit.point, showMessage);
        return;
    }

    if (state.tool === 'door' && !(hit.bounds.u0 === 0 && hit.bounds.u1 === 0 && hit.bounds.v0 === 0 && hit.bounds.v1 === 0)) {
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

    // Platform tool keys
    if (state.tool === 'platform' && isPointerLocked()) {
        const selectedPlat = state.selectedPlatformId != null
            ? state.platforms.find(p => p.id === state.selectedPlatformId)
            : null;

        // Escape = cancel gizmo drag, cancel connect, or deselect
        if (e.code === 'Escape') {
            e.preventDefault();
            if (gizmo.isDragging()) {
                gizmo.cancelDrag();
                rebuildPlatform(selectedPlat);
                rebuildConnectedStairRuns(selectedPlat.id);
                showMessage('Cancelled');
            } else if (state.platformPhase === 'connecting_src' || state.platformPhase === 'connecting_dst') {
                state.platformPhase = 'selected';
                state.platformConnectFrom = null;
                state.platformConnectTo = null;
                showMessage('Cancelled');
            } else {
                clearPlatformToolState();
                gizmo.update(null, camera);
                showMessage('Platform deselected');
            }
            return;
        }

        // C = connect mode — pick destination first, then source position
        if (e.code === 'KeyC' && selectedPlat && state.platformPhase === 'selected') {
            e.preventDefault();
            state.platformConnectFrom = { platformId: selectedPlat.id, edge: null, offset: 0.5 };
            state.platformConnectTo = null;
            state.platformPhase = 'connecting_dst';
            showMessage(`Click destination platform or floor — Esc to cancel`);
            return;
        }

        // F = toggle grounded (extend to floor) on platform + connected stairs
        if (e.code === 'KeyF' && selectedPlat && state.platformPhase === 'selected') {
            e.preventDefault();
            saveUndoState();
            const newGrounded = !selectedPlat.grounded;
            selectedPlat.grounded = newGrounded;
            rebuildPlatform(selectedPlat);
            // Also toggle all connected stair runs
            const connectedRuns = state.stairRuns.filter(
                r => r.fromPlatformId === selectedPlat.id || r.toPlatformId === selectedPlat.id
            );
            for (const run of connectedRuns) {
                run.grounded = newGrounded;
                rebuildStairRun(run);
            }
            const count = connectedRuns.length;
            const label = newGrounded ? 'grounded' : 'floating';
            showMessage(count > 0
                ? `Platform + ${count} stair run${count > 1 ? 's' : ''} ${label}`
                : `Platform ${label}`);
            return;
        }

        // X/Delete = delete selected platform
        if ((e.code === 'KeyX' || e.key === 'Delete') && selectedPlat && state.platformPhase === 'selected') {
            e.preventDefault();
            saveUndoState();
            // Remove connected stair runs
            const connectedRuns = state.stairRuns.filter(r => r.fromPlatformId === selectedPlat.id || r.toPlatformId === selectedPlat.id);
            for (const run of connectedRuns) {
                const mesh = stairRunMeshes.get(run.id);
                if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); stairRunMeshes.delete(run.id); }
            }
            state.stairRuns = state.stairRuns.filter(r => r.fromPlatformId !== selectedPlat.id && r.toPlatformId !== selectedPlat.id);
            state.platforms = state.platforms.filter(p => p.id !== selectedPlat.id);
            removePlatformMesh(selectedPlat.id);
            clearPlatformToolState();
            showMessage('Platform deleted');
            return;
        }
    }

    // Stair tool keys
    if (state.tool === 'stair' && isPointerLocked()) {
        if (e.code === 'KeyR') {
            e.preventDefault();
            state.stairSide = state.stairSide === 'right' ? 'left' : 'right';
            showMessage('Stair side: ' + state.stairSide.toUpperCase());
            return;
        }
        if (e.code === 'Enter' && state.stairPhase === 'placing') {
            e.preventDefault();
            if (state.stairWaypoints.length >= 2) {
                placeStaircase(state.stairWaypoints, showMessage, rebuildStaircase);
                clearStairState();
            } else {
                showMessage('Need at least 2 waypoints');
            }
            return;
        }
        if (e.code === 'Backspace' && state.stairPhase === 'placing') {
            e.preventDefault();
            state.stairWaypoints.pop();
            if (state.stairWaypoints.length === 0) {
                state.stairPhase = 'idle';
                showMessage('All waypoints removed');
            } else {
                showMessage(`Waypoint removed (${state.stairWaypoints.length} remaining)`);
            }
            return;
        }
    }

    if (e.code === 'KeyV' && isPointerLocked()) {
        e.preventDefault();
        state.viewMode = state.viewMode === 'grid' ? 'textured' : 'grid';
        showMessage('View: ' + (state.viewMode === 'grid' ? 'Grid' : 'Textured'));
        rebuildAllVolumes();
        rebuildAllStaircases();
        rebuildAllPlatforms();
        rebuildAllStairRuns();
        return;
    }

    // Number keys: set texture scheme on selected volume
    if (e.key >= '1' && e.key <= '9' && isPointerLocked() && state.selectedFace) {
        const schemeName = getSchemeByKey(e.key);
        if (schemeName) {
            e.preventDefault();
            const vol = state.volumes.find(v => v.id === state.selectedFace.volumeId);
            if (vol) {
                vol.textureScheme = schemeName;
                rebuildVolume(vol);
                showMessage('Scheme: ' + TEXTURE_SCHEMES[schemeName].label);
            }
            return;
        }
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
        clearPlatformToolState();
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

    if (e.code === 'Escape' && state.tool !== 'platform') {
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
// INIT — load schemes, then start
// ============================================================
(async () => {
    await loadTextureSchemes();
    initMaterials();

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

    animate();
})();

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
function drawMarkerCube(cx, cy, cz, material) {
    const s = 0.5;
    const W = WORLD_SCALE;
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
    stairPreviewGroup.add(new THREE.Line(geo, material));
}

function updateStairPreview() {
    while (stairPreviewGroup.children.length > 0) {
        const child = stairPreviewGroup.children[0];
        stairPreviewGroup.remove(child);
        if (child.geometry) child.geometry.dispose();
    }

    if (state.tool !== 'stair' || !isPointerLocked()) return;

    const hit = pickFace(camera, volumeMeshes);
    if (!hit) return;

    const snapped = snapToWTGrid(hit.point);

    if (state.stairPhase === 'idle') {
        // Yellow marker at hover position
        drawMarkerCube(snapped.x, snapped.y, snapped.z, stairMarkerMat);
    } else if (state.stairPhase === 'placing') {
        // Draw yellow markers at all committed waypoints
        for (const wp of state.stairWaypoints) {
            drawMarkerCube(wp.x, wp.y, wp.z, stairMarkerMat);
        }

        // Build preview of committed segments + current hover as next waypoint
        const previewWps = [...state.stairWaypoints, snapped];

        if (previewWps.length >= 2) {
            const pts = buildStaircasePreviewLines(
                previewWps, state.stairWidth, state.stairStepHeight, state.stairSide, state.stairRiseOverRun
            );
            if (pts.length >= 2) {
                const geo = new THREE.BufferGeometry().setFromPoints(pts);
                stairPreviewGroup.add(new THREE.LineSegments(geo, stairPreviewMat));
            }
        }
    }
}

// ============================================================
// EDGE DETECTION — find closest platform edge to a world point
// ============================================================
function closestPlatformEdge(platform, worldPoint) {
    const W = WORLD_SCALE;
    const px = worldPoint.x / W;
    const pz = worldPoint.z / W;

    const edges = ['xMin', 'xMax', 'zMin', 'zMax'];
    let bestEdge = null;
    let bestDist = Infinity;

    for (const edge of edges) {
        const line = platform.getEdgeLine(edge);
        // Distance from point to line segment (in XZ plane)
        const dist = distToSegment2D(px, pz, line.start.x, line.start.z, line.end.x, line.end.z);
        if (dist < bestDist) {
            bestDist = dist;
            bestEdge = edge;
        }
    }
    return bestEdge;
}

function distToSegment2D(px, pz, ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az;
    const lenSq = dx * dx + dz * dz;
    if (lenSq === 0) return Math.hypot(px - ax, pz - az);
    let t = ((px - ax) * dx + (pz - az) * dz) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

// Find the offset (0..1) on a platform edge closest to a world-space point (in WT coords)
function closestOffsetOnEdge(platform, edge, wtPoint) {
    const line = platform.getEdgeLine(edge);
    const ex = line.end.x - line.start.x;
    const ez = line.end.z - line.start.z;
    const lenSq = ex * ex + ez * ez;
    if (lenSq === 0) return 0.5;
    const t = ((wtPoint.x - line.start.x) * ex + (wtPoint.z - line.start.z) * ez) / lenSq;
    const edgeLen = platform.getEdgeLength(edge);
    const wtPos = Math.round(Math.max(0, Math.min(1, t)) * edgeLen);
    return Math.max(0, Math.min(edgeLen, wtPos)) / edgeLen;
}

// Project the crosshair ray onto a platform edge, returning offset 0..1
// Uses a ground-plane intersection at the platform's Y level, then projects onto the edge line
function projectCrosshairOntoEdge(platform, edge, camera) {
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -platform.y * WORLD_SCALE);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const intersect = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, intersect)) return 0.5; // fallback to center

    // Convert to WT
    const px = intersect.x / WORLD_SCALE;
    const pz = intersect.z / WORLD_SCALE;

    // Project onto edge line
    const line = platform.getEdgeLine(edge);
    const ex = line.end.x - line.start.x;
    const ez = line.end.z - line.start.z;
    const lenSq = ex * ex + ez * ez;
    if (lenSq === 0) return 0.5;
    const t = ((px - line.start.x) * ex + (pz - line.start.z) * ez) / lenSq;
    // Quantize to 1 WT increments along the edge
    const edgeLen = platform.getEdgeLength(edge);
    const wtPos = Math.round(Math.max(0, Math.min(1, t)) * edgeLen);
    return Math.max(0, Math.min(edgeLen, wtPos)) / edgeLen;
}

// Pick the source edge whose outward normal best aligns with a direction (XZ plane)
function bestEdgeForDirection(platform, direction) {
    const edges = ['xMin', 'xMax', 'zMin', 'zMax'];
    let best = null, bestDot = -Infinity;
    for (const edge of edges) {
        const normal = Platform.edgeNormal(edge);
        const dot = normal.x * direction.x + normal.z * direction.z;
        if (dot > bestDot) { bestDot = dot; best = edge; }
    }
    return best;
}

// ============================================================
// PLATFORM PREVIEW
// ============================================================
function updatePlatformPreview() {
    while (platformPreviewGroup.children.length > 0) {
        const child = platformPreviewGroup.children[0];
        platformPreviewGroup.remove(child);
        if (child.geometry) child.geometry.dispose();
    }

    if (state.tool !== 'platform' || !isPointerLocked()) return;

    // Show green wireframe on selected platform
    if (state.selectedPlatformId != null) {
        const plat = state.platforms.find(p => p.id === state.selectedPlatformId);
        if (plat) {
            const pts = buildPlatformPreviewLines(plat.x, plat.y, plat.z, plat.sizeX, plat.sizeZ, plat.thickness);
            const positions = new Float32Array(pts);
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            platformPreviewGroup.add(new THREE.LineSegments(geo, platformSelectionMat));
        }
    }

    // Show connect mode visuals — phase 1: choosing destination (hover highlight)
    if (state.platformPhase === 'connecting_dst' && state.platformConnectFrom) {
        const fromPlat = state.platforms.find(p => p.id === state.platformConnectFrom.platformId);
        if (fromPlat) {
            const anyHit = pickAny(camera, volumeMeshes, platformMeshes);
            if (anyHit) {
                if (anyHit.type === 'platform' && anyHit.platformId !== fromPlat.id) {
                    // Highlight closest edge of hovered platform in cyan
                    const toPlat = state.platforms.find(p => p.id === anyHit.platformId);
                    if (toPlat) {
                        const edge = closestPlatformEdge(toPlat, anyHit.point);
                        const edgePts = buildEdgeHighlightLines(toPlat, edge);
                        const edgeGeo = new THREE.BufferGeometry();
                        edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(edgePts), 3));
                        platformPreviewGroup.add(new THREE.LineSegments(edgeGeo, platformEdgeHighlightMat));
                    }
                }
                // Ground hover doesn't need special visuals — the crosshair is enough
            }
        }
    }

    // Show connect mode visuals — phase 2: sliding source slot + stair preview
    if (state.platformPhase === 'connecting_src' && state.platformConnectFrom && state.platformConnectTo) {
        const from = state.platformConnectFrom;
        const to = state.platformConnectTo;
        const fromPlat = state.platforms.find(p => p.id === from.platformId);
        if (fromPlat) {
            // Show the full source edge as a dim cyan line
            const edgePts = buildEdgeHighlightLines(fromPlat, from.edge);
            const edgeGeo = new THREE.BufferGeometry();
            edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(edgePts), 3));
            platformPreviewGroup.add(new THREE.LineSegments(edgeGeo, platformEdgeHighlightMat));

            // Show sliding green slot at crosshair position
            const offset = projectCrosshairOntoEdge(fromPlat, from.edge, camera);
            const slotPts = buildEdgeSlotLines(fromPlat, from.edge, offset, state.stairWidth);
            const slotGeo = new THREE.BufferGeometry();
            slotGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(slotPts), 3));
            platformPreviewGroup.add(new THREE.LineSegments(slotGeo, platformSelectionMat));

            // Compute destination point based on locked destination type
            const fromPt = { ...fromPlat.getEdgePointAtOffset(from.edge, offset), y: fromPlat.y };
            let destPt = null;

            if (to.type === 'platform') {
                const toPlat = state.platforms.find(p => p.id === to.platformId);
                if (toPlat) {
                    const destOffset = closestOffsetOnEdge(toPlat, to.edge, fromPt);
                    destPt = { ...toPlat.getEdgePointAtOffset(to.edge, destOffset), y: toPlat.y };

                    // Show destination slot in cyan
                    const destSlotPts = buildEdgeSlotLines(toPlat, to.edge, destOffset, state.stairWidth);
                    const destGeo = new THREE.BufferGeometry();
                    destGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(destSlotPts), 3));
                    platformPreviewGroup.add(new THREE.LineSegments(destGeo, platformEdgeHighlightMat));
                }
            } else {
                // Ground/volume surface: project from source along edge normal
                const normal = Platform.edgeNormal(from.edge);
                const destY = to.y ?? 0;
                const rise = fromPlat.y - destY;
                const run = rise / state.stairRiseOverRun;
                const gx = fromPt.x + normal.x * run;
                const gz = fromPt.z + normal.z * run;
                destPt = { x: Math.round(gx), y: destY, z: Math.round(gz) };
            }

            // Show ghost stair wireframe
            if (destPt) {
                const ddx = Math.abs(destPt.x - fromPt.x);
                const ddz = Math.abs(destPt.z - fromPt.z);
                if ((ddx >= 1 || ddz >= 1) && fromPt.y !== destPt.y) {
                    const stairPts = buildStairRunPreviewLines(
                        fromPt, destPt, state.stairWidth, state.stairStepHeight, state.stairRiseOverRun,
                    );
                    if (stairPts.length > 0) {
                        const stairGeo = new THREE.BufferGeometry();
                        stairGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(stairPts), 3));
                        platformPreviewGroup.add(new THREE.LineSegments(stairGeo, platformSelectionMat));
                    }
                }
            }
        }
    }

    // Show hover preview when idle (no platform selected)
    if (state.platformPhase === 'idle') {
        const anyHit = pickAny(camera, volumeMeshes, platformMeshes);
        if (anyHit) {
            const snapped = snapToWTGrid(anyHit.point);
            const halfX = Math.floor(state.platformSizeX / 2);
            const halfZ = Math.floor(state.platformSizeZ / 2);
            const pts = buildPlatformPreviewLines(
                snapped.x - halfX, snapped.y, snapped.z - halfZ,
                state.platformSizeX, state.platformSizeZ, state.platformThickness,
            );
            const positions = new Float32Array(pts);
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            platformPreviewGroup.add(new THREE.LineSegments(geo, platformPreviewMat));
        }
    }
}

// ============================================================
// RENDER LOOP
// ============================================================
const clock = new THREE.Clock();

function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();

    // If gizmo is being dragged, consume mouse delta for the gizmo instead of camera
    if (gizmo.isDragging()) {
        const { dx, dy } = consumeMouseDelta();
        const changed = gizmo.processDrag(dx, dy, camera);
        if (changed) {
            const plat = state.platforms.find(p => p.id === state.selectedPlatformId);
            if (plat) {
                rebuildPlatform(plat);
                rebuildConnectedStairRuns(plat.id);
            }
        }
    }

    updateCamera(camera, dt);

    // Update gizmo position and hover state
    const selectedPlat = (state.tool === 'platform' && state.selectedPlatformId != null)
        ? state.platforms.find(p => p.id === state.selectedPlatformId)
        : null;
    gizmo.update(selectedPlat, camera);

    updateDoorPreview();
    updateExtrudePreview();
    updateStairPreview();
    updatePlatformPreview();
    updateHUD(camera);
    renderer.render(scene, camera);
}
