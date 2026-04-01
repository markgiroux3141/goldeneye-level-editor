// Main entry point — wires all modules together

import * as THREE from 'three';
import { initScene, scene, renderer, camera, gridHelper } from './scene.js';
import { initInput, initKeyActions, onKeyDown, isKeyDown, isPointerLocked, consumeMouseDelta, setPointerLockEnabled, onMiddleClick, reacquirePointerLock, releasePointerLock } from './input.js';
import { updateCamera } from './camera.js';
import { Volume, WORLD_SCALE } from './core/Volume.js';
import { state, deserializeLevel, saveUndoState } from './state.js';
import { initMaterials, getWallMaterial, getTexturedMaterialArray, getTexturedMaterialArrayForScheme, getRailingMaterial, getRailingGridMaterial } from './materials.js';
import { TEXTURE_SCHEMES, getSchemeByKey, loadTextureSchemes } from './textureSchemes.js';
import { buildVolumeGeometry } from './geometry.js';
import { getConnectionsForFace, computeDoorPlacement } from './core/Connection.js';
import { pickFace, pickPlatform, pickStairRun, pickAny, pickGroundOnly } from './raycaster.js';
import { showMessage, updateHUD, initHUD } from './hud.js';
import { loadFromLocalStorage } from './io/LevelStorage.js';
import {
    pushSelectedFace, pullSelectedFace,
    deleteSelectedVolume, placeDoorOnFace, undoAction,
    saveLevel, loadLevel,
    addExtrudeSelection, executeExtrude, reExtrudeVolumes,
    extrudeUntilBlocked, clearExtrudeState, computeExtrudePlacement,
    snapToWTGrid,
} from './actions.js';
import { Platform } from './core/Platform.js';
import { buildPlatformGeometry, buildPlatformPreviewLines, buildEdgeHighlightLines, buildEdgeSlotLines, buildStairRunGeometry, buildStairRunPreviewLines, buildPlatformRailingGeometry, buildStairRunRailingGeometry } from './platformGeometry.js';
import { StairRun } from './core/StairRun.js';
import { PlatformGizmo } from './gizmo.js';
import { TerrainMap } from './core/TerrainMap.js';
import { createOrthoCamera, getOrthoCamera, updateOrthoCamera, handleOrthoZoom, handleOrthoMiddleMouseDown, handleOrthoMiddleMouseUp, handleOrthoMiddleMouseMove, handleOrthoResize, screenToWorldXZ, centerOrthoOn } from './terrain/orthographicCamera.js';
import { triangulateTerrain } from './terrain/triangulation.js';
import { buildTerrainGeometry, updateTerrainNormals, buildBoundaryLines, buildVertexMarkers, buildBrushCircle } from './terrain/terrainGeometry.js';
import { applyBrush, snapshotHeights, restoreHeights } from './terrain/terrainBrush.js';
import { buildPlaneWallGeometry, buildRockyWallGeometry } from './terrain/boundaryWalls.js';
import { RadialMenu } from './ui/RadialMenu.js';
import { buildMenuTree } from './ui/menuConfig.js';
import { initMenuActions } from './ui/menuActions.js';
import { hotkeyManager } from './ui/HotkeyManager.js';

// ============================================================
// INIT
// ============================================================
initScene();
initInput(renderer.domElement);
initKeyActions();
initHUD();

// Radial menu setup
const radialMenu = new RadialMenu();

onMiddleClick(() => {
    // Don't open menu in terrain mode (middle-click is pan there)
    if (state.editorMode === 'terrain') return;
    if (radialMenu.isOpen()) {
        radialMenu.close();
        return;
    }
    if (!isPointerLocked()) return;

    state.radialMenuOpen = true;
    releasePointerLock();
    const tree = buildMenuTree();
    radialMenu.open(tree, () => {
        state.radialMenuOpen = false;
        reacquirePointerLock();
    }, buildMenuTree);
});

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
// TERRAIN MESH MANAGEMENT
// ============================================================
const terrainMeshes = new Map();       // terrainId -> THREE.Mesh
const terrainWallMeshes = new Map();   // terrainId -> THREE.Mesh
const terrainPreviewGroup = new THREE.Group();
scene.add(terrainPreviewGroup);
const terrainBoundaryMat = new THREE.LineBasicMaterial({ color: 0x00ff00, linewidth: 2 });
const terrainDrawingMat = new THREE.LineBasicMaterial({ color: 0xffff00, linewidth: 2 });
const terrainVertexMat = new THREE.LineBasicMaterial({ color: 0x00ffff, linewidth: 2 });
const terrainHoleMat = new THREE.LineBasicMaterial({ color: 0xff4444, linewidth: 2 });
const terrainBrushMat = new THREE.LineBasicMaterial({ color: 0xff8800, linewidth: 2, depthTest: false });
let brushHeightSnapshot = null; // for undo during sculpting
let isSculpting = false;

// Create orthographic camera for terrain mode
const orthoCamera = createOrthoCamera();

function rebuildTerrainMesh(terrain) {
    // Remove old mesh
    const old = terrainMeshes.get(terrain.id);
    if (old) { scene.remove(old); old.geometry.dispose(); }

    if (!terrain.hasMesh) { terrainMeshes.delete(terrain.id); return; }

    const geometry = buildTerrainGeometry(terrain);
    const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData = { terrainId: terrain.id };

    const wire = new THREE.WireframeGeometry(geometry);
    const wireframe = new THREE.LineSegments(wire, new THREE.LineBasicMaterial({ color: 0x000000 }));
    wireframe.visible = state.showWireframe;
    mesh.add(wireframe);

    terrainMeshes.set(terrain.id, mesh);
    scene.add(mesh);
}

function rebuildTerrainWalls(terrain) {
    const old = terrainWallMeshes.get(terrain.id);
    if (old) { scene.remove(old); old.geometry.dispose(); }

    if (!terrain.hasMesh) { terrainWallMeshes.delete(terrain.id); return; }

    let geometry;
    if (terrain.wallStyle === 'rocky') {
        geometry = buildRockyWallGeometry(terrain);
    } else {
        geometry = buildPlaneWallGeometry(terrain);
    }

    if (!geometry.getAttribute('position') || geometry.getAttribute('position').count === 0) return;

    const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData = { terrainWallId: terrain.id };

    terrainWallMeshes.set(terrain.id, mesh);
    scene.add(mesh);
}

function rebuildAllTerrain() {
    for (const [id, mesh] of terrainMeshes) { scene.remove(mesh); mesh.geometry.dispose(); }
    terrainMeshes.clear();
    for (const [id, mesh] of terrainWallMeshes) { scene.remove(mesh); mesh.geometry.dispose(); }
    terrainWallMeshes.clear();

    for (const t of state.terrainMaps) {
        rebuildTerrainMesh(t);
        rebuildTerrainWalls(t);
    }
}

function getActiveCamera() {
    if (state.editorMode === 'terrain' && state.terrainCameraMode === 'ortho') {
        return orthoCamera;
    }
    return camera;
}

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

    // Add railings if enabled
    if (plat.railings) {
        const connectedRuns = state.stairRuns.filter(
            r => r.fromPlatformId === plat.id || r.toPlatformId === plat.id
        );
        const railGeo = buildPlatformRailingGeometry(plat, connectedRuns, state.volumes);
        if (railGeo.getAttribute('position') && railGeo.getAttribute('position').count > 0) {
            const railMat = state.viewMode === 'textured' ? getRailingMaterial() : getRailingGridMaterial();
            const railMesh = new THREE.Mesh(railGeo, railMat);
            railMesh.renderOrder = 1;
            mesh.add(railMesh);
        }
    }

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

    // Add railings if enabled
    if (run.railings) {
        const railGeo = buildStairRunRailingGeometry(run, fromPlat, toPlat, state.volumes);
        if (railGeo.getAttribute('position') && railGeo.getAttribute('position').count > 0) {
            const railMat = state.viewMode === 'textured' ? getRailingMaterial() : getRailingGridMaterial();
            const railMesh = new THREE.Mesh(railGeo, railMat);
            railMesh.renderOrder = 1;
            mesh.add(railMesh);
        }
    }

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

// Rebuild everything (volumes + platforms + stair runs + terrain) — used for undo/load
function rebuildAll() {
    rebuildAllVolumes();
    rebuildAllPlatforms();
    rebuildAllStairRuns();
    rebuildAllTerrain();
}

// ============================================================
// TOOL CYCLING
// ============================================================
const TOOL_CYCLE = ['push_pull', 'door', 'extrude', 'platform'];
const TOOL_NAMES = { push_pull: 'Push/Pull', door: 'Door', extrude: 'Extrude', platform: 'Platform' };
const TERRAIN_TOOL_CYCLE = ['boundary', 'hole', 'edit', 'sculpt'];
const TERRAIN_TOOL_NAMES = { boundary: 'Boundary', hole: 'Hole', edit: 'Edit', sculpt: 'Sculpt' };
const BRUSH_CYCLE = ['raise', 'noise', 'smooth', 'flatten'];
const BRUSH_NAMES = { raise: 'Raise/Lower', noise: 'Noise', smooth: 'Smooth', flatten: 'Flatten' };

function clearPlatformToolState() {
    if (gizmo.isDragging()) gizmo.cancelDrag();
    state.platformPhase = 'idle';
    state.selectedPlatformId = null;
    state.selectedStairRunId = null;
    state.platformMoveAxis = null;
    state.platformScaleAxis = null;
    state.platformConnectFrom = null;
    state.platformConnectTo = null;
    state.simpleStairFrom = null;
    gizmo.update(null, camera);
}

function cycleToolForward() {
    if (state.editorMode === 'terrain') {
        const idx = TERRAIN_TOOL_CYCLE.indexOf(state.terrainTool);
        state.terrainTool = TERRAIN_TOOL_CYCLE[(idx + 1) % TERRAIN_TOOL_CYCLE.length];
        showMessage('Terrain Tool: ' + TERRAIN_TOOL_NAMES[state.terrainTool]);
        return;
    }
    const idx = TOOL_CYCLE.indexOf(state.tool);
    state.tool = TOOL_CYCLE[(idx + 1) % TOOL_CYCLE.length];
    if (state.tool !== 'extrude') clearExtrudeState();
    if (state.tool !== 'platform') clearPlatformToolState();
    showMessage('Tool: ' + TOOL_NAMES[state.tool]);
}

function setIndoorMeshesVisible(visible) {
    for (const [, data] of volumeMeshes) data.mesh.visible = visible;
    for (const [, mesh] of platformMeshes) mesh.visible = visible;
    for (const [, mesh] of stairRunMeshes) mesh.visible = visible;
}

function toggleEditorMode() {
    if (state.editorMode === 'indoor') {
        state.editorMode = 'terrain';
        state.terrainCameraMode = 'ortho';
        // Exit pointer lock and disable it for ortho mode
        if (document.pointerLockElement) document.exitPointerLock();
        setPointerLockEnabled(false);
        document.getElementById('lock-prompt').style.display = 'none';
        document.getElementById('crosshair').style.display = 'none';
        // Hide indoor geometry
        setIndoorMeshesVisible(false);
        // Create terrain if none exists
        if (state.terrainMaps.length === 0) {
            const t = new TerrainMap(state.nextTerrainMapId++);
            state.terrainMaps.push(t);
            state.selectedTerrainId = t.id;
        } else {
            state.selectedTerrainId = state.terrainMaps[0].id;
        }
        state.terrainTool = 'boundary';
        state.terrainDrawingPhase = 'idle';
        state.terrainDrawingVertices = [];
        showMessage('TERRAIN MODE — Orthographic top-down view');
    } else {
        state.editorMode = 'indoor';
        state.terrainCameraMode = 'ortho';
        setPointerLockEnabled(true);
        // Show indoor geometry again
        setIndoorMeshesVisible(true);
        showMessage('INDOOR MODE — click to lock cursor');
    }
}

function clearTerrainDrawingState() {
    state.terrainDrawingPhase = 'idle';
    state.terrainDrawingVertices = [];
}

function cycleTerrainBrush() {
    const idx = BRUSH_CYCLE.indexOf(state.brushType);
    state.brushType = BRUSH_CYCLE[(idx + 1) % BRUSH_CYCLE.length];
    showMessage('Brush: ' + BRUSH_NAMES[state.brushType]);
}

function toggleTerrainCamera() {
    if (state.terrainCameraMode === 'ortho') {
        state.terrainCameraMode = 'perspective';
        setPointerLockEnabled(true);
        showMessage('Perspective view — click to lock cursor');
    } else {
        state.terrainCameraMode = 'ortho';
        if (document.pointerLockElement) document.exitPointerLock();
        setPointerLockEnabled(false);
        showMessage('Orthographic top-down view');
    }
}

function getActiveTerrain() {
    if (state.selectedTerrainId == null) return null;
    return state.terrainMaps.find(t => t.id === state.selectedTerrainId) || null;
}

// ============================================================
// MOUSE CLICK — FACE SELECTION / DOOR PLACEMENT / EXTRUDE SELECT
// ============================================================
document.addEventListener('mousedown', (e) => {
    // ---- TERRAIN MODE CLICK HANDLING ----
    if (state.editorMode === 'terrain') {
        if (e.button === 1) {
            // Middle mouse for panning in ortho mode
            if (state.terrainCameraMode === 'ortho') {
                handleOrthoMiddleMouseDown(e.clientX, e.clientY);
            }
            return;
        }
        if (e.button !== 0) return;

        const terrain = getActiveTerrain();
        if (!terrain) return;

        // Ortho mode: boundary/hole drawing
        if (state.terrainCameraMode === 'ortho') {
            const worldPos = screenToWorldXZ(e.clientX, e.clientY);
            // Snap to WT grid
            const snappedX = Math.round(worldPos.x / WORLD_SCALE) ;
            const snappedZ = Math.round(worldPos.z / WORLD_SCALE);

            if (state.terrainTool === 'boundary' || state.terrainTool === 'hole') {
                const verts = state.terrainTool === 'boundary'
                    ? (state.terrainDrawingPhase === 'drawing' ? state.terrainDrawingVertices : [])
                    : state.terrainDrawingVertices;

                // Check if clicking near first vertex to close
                if (verts.length >= 3) {
                    const first = verts[0];
                    const dx = snappedX - first.x, dz = snappedZ - first.z;
                    if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) {
                        // Close the polygon
                        saveUndoState();
                        if (state.terrainTool === 'boundary') {
                            terrain.boundary = [...verts];
                            state.terrainDrawingPhase = 'closed';
                            state.terrainDrawingVertices = [];
                            showMessage(`Boundary closed with ${terrain.boundary.length} vertices — press G to generate mesh`);
                        } else {
                            terrain.holes.push([...verts]);
                            state.terrainDrawingPhase = 'idle';
                            state.terrainDrawingVertices = [];
                            showMessage(`Hole added with ${terrain.holes[terrain.holes.length - 1].length} vertices`);
                        }
                        return;
                    }
                }

                // Add vertex
                if (state.terrainDrawingPhase !== 'drawing') {
                    state.terrainDrawingPhase = 'drawing';
                    state.terrainDrawingVertices = [];
                }
                state.terrainDrawingVertices.push({ x: snappedX, z: snappedZ });
                showMessage(`Vertex ${state.terrainDrawingVertices.length} placed — click near first to close`);
                return;
            }

            if (state.terrainTool === 'edit' && terrain.boundary.length > 0) {
                // Find closest boundary vertex to click
                let bestIdx = -1, bestDist = Infinity;
                for (let i = 0; i < terrain.boundary.length; i++) {
                    const v = terrain.boundary[i];
                    const dist = Math.abs(v.x - snappedX) + Math.abs(v.z - snappedZ);
                    if (dist < bestDist) { bestDist = dist; bestIdx = i; }
                }
                if (bestIdx >= 0 && bestDist <= 3) {
                    saveUndoState();
                    terrain.boundary[bestIdx] = { x: snappedX, z: snappedZ };
                    // Regenerate mesh if exists
                    if (terrain.hasMesh) {
                        generateTerrainMesh(terrain);
                    }
                    showMessage(`Vertex ${bestIdx} moved`);
                }
                return;
            }
            return;
        }

        // Perspective mode: sculpting
        if (state.terrainCameraMode === 'perspective' && state.terrainTool === 'sculpt' && isPointerLocked()) {
            if (terrain.hasMesh) {
                isSculpting = true;
                brushHeightSnapshot = snapshotHeights(terrain);
                saveUndoState();
            }
            return;
        }
        return;
    }

    // ---- INDOOR MODE CLICK HANDLING ----
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

        // Simple stair placement — first click
        if (state.platformPhase === 'simple_stair_from') {
            const anyHit = pickAny(camera, volumeMeshes, platformMeshes);
            if (!anyHit) { showMessage('Click a surface'); return; }
            const snapped = snapToWTGrid(anyHit.point);
            state.simpleStairFrom = { x: snapped.x, y: snapped.y, z: snapped.z };
            state.platformPhase = 'simple_stair_to';
            showMessage('Click second stair endpoint — Esc to cancel');
            return;
        }

        // Simple stair placement — second click
        if (state.platformPhase === 'simple_stair_to' && state.simpleStairFrom) {
            const anyHit = pickAny(camera, volumeMeshes, platformMeshes);
            if (!anyHit) { showMessage('Click a surface'); return; }
            const snapped = snapToWTGrid(anyHit.point);
            const fromPt = state.simpleStairFrom;
            const toPt = { x: snapped.x, y: snapped.y, z: snapped.z };

            const rise = Math.abs(toPt.y - fromPt.y);
            if (rise === 0) {
                showMessage('Points are at the same height — no stairs needed');
                return;
            }
            const ddx = Math.abs(toPt.x - fromPt.x);
            const ddz = Math.abs(toPt.z - fromPt.z);
            if (ddx < 1 && ddz < 1) {
                showMessage('Need horizontal distance between endpoints');
                return;
            }

            saveUndoState();
            const run = new StairRun(
                state.nextStairRunId++,
                null, null,
                { x: fromPt.x, y: fromPt.y, z: fromPt.z },
                { x: toPt.x, y: toPt.y, z: toPt.z },
                state.stairWidth,
                state.stairStepHeight,
                state.stairRiseOverRun,
            );
            state.stairRuns.push(run);
            rebuildStairRun(run);

            const steps = Math.max(1, Math.round(rise / state.stairStepHeight));
            showMessage(`Simple stair run created: ${steps} steps`);

            state.platformPhase = 'idle';
            state.simpleStairFrom = null;
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
                state.selectedStairRunId = null;
                state.platformPhase = 'selected';
                const plat = state.platforms.find(p => p.id === platHit.platformId);
                showMessage(`Selected platform ${platHit.platformId} (${plat.sizeX}x${plat.sizeZ} at Y=${plat.y})`);
                return;
            }

            // Try to select a stair run
            const stairHit = pickStairRun(camera, stairRunMeshes);
            if (stairHit) {
                state.selectedStairRunId = stairHit.stairRunId;
                state.selectedPlatformId = null;
                state.platformPhase = 'selected';
                const run = state.stairRuns.find(r => r.id === stairHit.stairRunId);
                const fromPlat = run.fromPlatformId != null ? state.platforms.find(p => p.id === run.fromPlatformId) : null;
                const toPlat = run.toPlatformId != null ? state.platforms.find(p => p.id === run.toPlatformId) : null;
                const fromPt = StairRun.resolveAnchor(fromPlat, run.anchorFrom);
                const toPt = StairRun.resolveAnchor(toPlat, run.anchorTo);
                const rise = Math.abs(toPt.y - fromPt.y);
                const steps = Math.max(1, Math.round(rise / run.stepHeight));
                showMessage(`Selected stair run ${stairHit.stairRunId}: ${steps} steps`);
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
// TERRAIN MOUSE HANDLERS (mouseup, mousemove, wheel)
// ============================================================
document.addEventListener('mouseup', (e) => {
    if (state.editorMode === 'terrain') {
        if (e.button === 1) {
            handleOrthoMiddleMouseUp();
            return;
        }
        if (e.button === 0 && isSculpting) {
            isSculpting = false;
            brushHeightSnapshot = null;
            // Rebuild walls so they follow the new terrain heights
            const terrain = getActiveTerrain();
            if (terrain && terrain.hasMesh) {
                rebuildTerrainWalls(terrain);
            }
        }
    }
});

document.addEventListener('mousemove', (e) => {
    if (state.editorMode === 'terrain' && state.terrainCameraMode === 'ortho') {
        handleOrthoMiddleMouseMove(e.clientX, e.clientY);
    }
});

document.addEventListener('wheel', (e) => {
    if (state.editorMode === 'terrain' && state.terrainCameraMode === 'ortho') {
        e.preventDefault();
        handleOrthoZoom(e.deltaY);
    }
}, { passive: false });

// Terrain mesh generation helper
function generateTerrainMesh(terrain) {
    const result = triangulateTerrain(terrain.boundary, terrain.holes, terrain.subdivisionLevel);
    terrain.vertices = result.vertices;
    terrain.triangles = result.triangles;
    rebuildTerrainMesh(terrain);
    rebuildTerrainWalls(terrain);
    showMessage(`Mesh generated: ${terrain.vertices.length} vertices, ${terrain.triangles.length} triangles`);
}

// Handle ortho resize
window.addEventListener('resize', () => {
    handleOrthoResize();
});

// ============================================================
// KEY ACTIONS
// ============================================================
onKeyDown((e) => {
    // Don't process hotkeys while radial menu is open (it handles its own Escape)
    if (state.radialMenuOpen) return;

    // ---- TERRAIN MODE KEY HANDLING ----
    if (state.editorMode === 'terrain') {
        // M = switch back to indoor mode
        if (e.code === 'KeyM') {
            e.preventDefault();
            toggleEditorMode();
            return;
        }

        // T = cycle terrain tool
        if (e.code === 'KeyT') {
            e.preventDefault();
            cycleToolForward();
            return;
        }

        // Tab = toggle ortho/perspective camera in terrain mode
        if (e.code === 'Tab') {
            e.preventDefault();
            toggleTerrainCamera();
            return;
        }

        // B = cycle brush type (in sculpt mode)
        if (e.code === 'KeyB' && state.terrainTool === 'sculpt') {
            e.preventDefault();
            cycleTerrainBrush();
            return;
        }

        // G = generate mesh from boundary
        if (e.code === 'KeyG') {
            e.preventDefault();
            const terrain = getActiveTerrain();
            if (!terrain) return;
            if (!terrain.isClosed) {
                showMessage('Close the boundary first (click near first vertex)');
                return;
            }
            saveUndoState();
            generateTerrainMesh(terrain);
            return;
        }

        // Shift+W = toggle wall style (Shift avoids conflict with WASD pan)
        if (e.code === 'KeyW' && e.shiftKey) {
            e.preventDefault();
            const terrain = getActiveTerrain();
            if (!terrain) return;
            terrain.wallStyle = terrain.wallStyle === 'plane' ? 'rocky' : 'plane';
            if (terrain.hasMesh) rebuildTerrainWalls(terrain);
            // Update Wall H input to show the active style's height
            const whInput = document.getElementById('terrain-wall-height');
            if (whInput) whInput.value = terrain.wallStyle === 'rocky' ? terrain.rockyWallHeight : terrain.wallHeight;
            showMessage('Wall style: ' + terrain.wallStyle);
            return;
        }

        // +/- = adjust brush radius (sculpt mode)
        if (state.terrainTool === 'sculpt') {
            if (e.key === '=' || e.key === '+') {
                e.preventDefault();
                state.brushRadius = Math.min(50, state.brushRadius + 1);
                showMessage(`Brush radius: ${state.brushRadius}`);
                return;
            }
            if (e.key === '-') {
                e.preventDefault();
                state.brushRadius = Math.max(1, state.brushRadius - 1);
                showMessage(`Brush radius: ${state.brushRadius}`);
                return;
            }
            // [ / ] = adjust brush strength
            if (e.code === 'BracketRight') {
                e.preventDefault();
                state.brushStrength = Math.min(1, state.brushStrength + 0.1);
                showMessage(`Brush strength: ${state.brushStrength.toFixed(1)}`);
                return;
            }
            if (e.code === 'BracketLeft') {
                e.preventDefault();
                state.brushStrength = Math.max(0.1, state.brushStrength - 0.1);
                showMessage(`Brush strength: ${state.brushStrength.toFixed(1)}`);
                return;
            }
        }

        // +/- = adjust subdivision level (boundary/hole tool)
        if (state.terrainTool === 'boundary' || state.terrainTool === 'hole') {
            if (e.key === '=' || e.key === '+') {
                e.preventDefault();
                const terrain = getActiveTerrain();
                if (terrain) {
                    terrain.subdivisionLevel = Math.min(20, terrain.subdivisionLevel + 1);
                    showMessage(`Subdivision: ${terrain.subdivisionLevel}`);
                }
                return;
            }
            if (e.key === '-') {
                e.preventDefault();
                const terrain = getActiveTerrain();
                if (terrain) {
                    terrain.subdivisionLevel = Math.max(1, terrain.subdivisionLevel - 1);
                    showMessage(`Subdivision: ${terrain.subdivisionLevel}`);
                }
                return;
            }
        }

        // Backspace = undo last vertex while drawing
        if (e.code === 'Backspace' && state.terrainDrawingPhase === 'drawing') {
            e.preventDefault();
            state.terrainDrawingVertices.pop();
            if (state.terrainDrawingVertices.length === 0) {
                state.terrainDrawingPhase = 'idle';
            }
            showMessage(`Vertices: ${state.terrainDrawingVertices.length}`);
            return;
        }

        // Escape = cancel drawing, or deselect
        if (e.code === 'Escape') {
            e.preventDefault();
            if (state.terrainDrawingPhase === 'drawing') {
                clearTerrainDrawingState();
                showMessage('Drawing cancelled');
            }
            return;
        }

        // Ctrl+Z undo (in terrain mode)
        if (e.ctrlKey && e.code === 'KeyZ') {
            e.preventDefault();
            clearTerrainDrawingState();
            undoAction(showMessage, rebuildAll);
            return;
        }

        // Ctrl+S save / Ctrl+O load (in terrain mode)
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

        // Grid toggle works in terrain mode too
        if (hotkeyManager.matches('toggle_grid', e)) {
            e.preventDefault();
            state.showGrid = !state.showGrid;
            if (gridHelper) gridHelper.visible = state.showGrid;
            showMessage('Grid: ' + (state.showGrid ? 'ON' : 'OFF'));
            return;
        }

        // E = toggle terrain wireframe edges
        if (e.code === 'KeyE') {
            e.preventDefault();
            state.showWireframe = !state.showWireframe;
            for (const [, mesh] of terrainMeshes) {
                for (const child of mesh.children) {
                    if (child.isLineSegments) child.visible = state.showWireframe;
                }
            }
            showMessage('Wireframe: ' + (state.showWireframe ? 'ON' : 'OFF'));
            return;
        }

        return; // Don't fall through to indoor key handlers
    }

    // ---- INDOOR MODE: M key to switch to terrain ----
    if (hotkeyManager.matches('toggle_mode', e) && isPointerLocked()) {
        e.preventDefault();
        toggleEditorMode();
        return;
    }

    // Extrude tool: +/- for extrude/shrink, Shift++ for extrude until blocked
    if (state.tool === 'extrude') {
        if (hotkeyManager.matches('push', e)) {
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
        if (hotkeyManager.matches('pull', e)) {
            e.preventDefault();
            if (state.extrudePhase === 'extruded') {
                reExtrudeVolumes('pull', showMessage, rebuildAllVolumes);
            }
            return;
        }
    }

    // Push/Pull tool: +/- for push/pull
    if (hotkeyManager.matches('push', e) && state.selectedFace && state.tool === 'push_pull') {
        e.preventDefault();
        pushSelectedFace(showMessage, rebuildVolume, rebuildAllVolumes);
        return;
    }

    if (hotkeyManager.matches('pull', e) && state.selectedFace && state.tool === 'push_pull') {
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
        if (hotkeyManager.matches('escape', e)) {
            e.preventDefault();
            if (gizmo.isDragging()) {
                gizmo.cancelDrag();
                rebuildPlatform(selectedPlat);
                rebuildConnectedStairRuns(selectedPlat.id);
                showMessage('Cancelled');
            } else if (state.platformPhase === 'simple_stair_from' || state.platformPhase === 'simple_stair_to') {
                state.platformPhase = 'idle';
                state.simpleStairFrom = null;
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

        // Connect mode — pick destination first, then source position
        if (hotkeyManager.matches('connect_stairs', e) && selectedPlat && state.platformPhase === 'selected') {
            e.preventDefault();
            state.platformConnectFrom = { platformId: selectedPlat.id, edge: null, offset: 0.5 };
            state.platformConnectTo = null;
            state.platformPhase = 'connecting_dst';
            showMessage(`Click destination platform or floor — Esc to cancel`);
            return;
        }

        // Simple stair mode (no platform needed)
        if (hotkeyManager.matches('simple_stairs', e) && state.platformPhase === 'idle') {
            e.preventDefault();
            state.platformPhase = 'simple_stair_from';
            state.simpleStairFrom = null;
            showMessage('Click first stair endpoint — Esc to cancel');
            return;
        }

        // Toggle grounded (extend to floor) on platform + connected stairs
        if (hotkeyManager.matches('toggle_grounded', e) && selectedPlat && state.platformPhase === 'selected') {
            e.preventDefault();
            saveUndoState();
            const newGrounded = !selectedPlat.grounded;
            selectedPlat.grounded = newGrounded;
            rebuildPlatform(selectedPlat);
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

        // Toggle railings on platform + connected stairs
        if (hotkeyManager.matches('toggle_railings', e) && selectedPlat && state.platformPhase === 'selected') {
            e.preventDefault();
            saveUndoState();
            const newRailings = !selectedPlat.railings;
            selectedPlat.railings = newRailings;
            rebuildPlatform(selectedPlat);
            const connectedRuns = state.stairRuns.filter(
                r => r.fromPlatformId === selectedPlat.id || r.toPlatformId === selectedPlat.id
            );
            for (const run of connectedRuns) {
                run.railings = newRailings;
                rebuildStairRun(run);
            }
            const count = connectedRuns.length;
            const label = newRailings ? 'ON' : 'OFF';
            showMessage(count > 0
                ? `Railings ${label} (platform + ${count} stair run${count > 1 ? 's' : ''})`
                : `Railings ${label}`);
            return;
        }

        // Delete selected platform
        if ((hotkeyManager.matches('delete', e) || e.key === 'Delete') && selectedPlat && state.platformPhase === 'selected') {
            e.preventDefault();
            saveUndoState();
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

        // --- Selected stair run keys (F/R/X) ---
        const selectedRun = state.selectedStairRunId != null
            ? state.stairRuns.find(r => r.id === state.selectedStairRunId)
            : null;

        if (hotkeyManager.matches('toggle_grounded', e) && selectedRun && state.platformPhase === 'selected') {
            e.preventDefault();
            saveUndoState();
            selectedRun.grounded = !selectedRun.grounded;
            rebuildStairRun(selectedRun);
            showMessage(`Stair run ${selectedRun.grounded ? 'grounded' : 'floating'}`);
            return;
        }

        if (hotkeyManager.matches('toggle_railings', e) && selectedRun && state.platformPhase === 'selected') {
            e.preventDefault();
            saveUndoState();
            selectedRun.railings = !selectedRun.railings;
            rebuildStairRun(selectedRun);
            showMessage(`Stair run railings ${selectedRun.railings ? 'ON' : 'OFF'}`);
            return;
        }

        if ((hotkeyManager.matches('delete', e) || e.key === 'Delete') && selectedRun && state.platformPhase === 'selected') {
            e.preventDefault();
            saveUndoState();
            const mesh = stairRunMeshes.get(selectedRun.id);
            if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); stairRunMeshes.delete(selectedRun.id); }
            state.stairRuns = state.stairRuns.filter(r => r.id !== selectedRun.id);
            clearPlatformToolState();
            showMessage('Stair run deleted');
            return;
        }
    }

    if (hotkeyManager.matches('toggle_view', e) && isPointerLocked()) {
        e.preventDefault();
        state.viewMode = state.viewMode === 'grid' ? 'textured' : 'grid';
        showMessage('View: ' + (state.viewMode === 'grid' ? 'Grid' : 'Textured'));
        rebuildAllVolumes();
        rebuildAllPlatforms();
        rebuildAllStairRuns();
        return;
    }

    if (hotkeyManager.matches('toggle_grid', e)) {
        e.preventDefault();
        state.showGrid = !state.showGrid;
        if (gridHelper) gridHelper.visible = state.showGrid;
        showMessage('Grid: ' + (state.showGrid ? 'ON' : 'OFF'));
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

    if (hotkeyManager.matches('cycle_tool', e) && isPointerLocked()) {
        e.preventDefault();
        cycleToolForward();
        return;
    }

    if ((hotkeyManager.matches('delete', e) || e.key === 'Delete') && state.selectedFace && isPointerLocked()) {
        e.preventDefault();
        const deletedId = deleteSelectedVolume(showMessage, rebuildAllVolumes);
        if (deletedId) removeVolumeMesh(deletedId);
        return;
    }

    if (hotkeyManager.matches('undo', e)) {
        e.preventDefault();
        clearExtrudeState();
        clearPlatformToolState();
        undoAction(showMessage, rebuildAll);
        return;
    }

    if (hotkeyManager.matches('save', e)) {
        e.preventDefault();
        saveLevel(showMessage);
        return;
    }

    if (hotkeyManager.matches('load', e)) {
        e.preventDefault();
        loadLevel(showMessage, rebuildAll);
        return;
    }

    if (hotkeyManager.matches('escape', e) && state.tool !== 'platform') {
        if (state.tool === 'extrude') {
            clearExtrudeState();
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

    // Wire radial menu actions to editor operations
    initMenuActions({
        showMessage,
        clearExtrudeState,
        clearPlatformToolState,
        rebuildVolume,
        rebuildAll,
    });

    // Try loading saved level — if found, skip the mode chooser
    let loadedSave = false;
    try {
        const saved = loadFromLocalStorage();
        if (saved) {
            const data = JSON.parse(saved);
            if (data.volumes && data.volumes.length > 0) {
                deserializeLevel(saved);
                rebuildAll();
                loadedSave = true;
                // Auto-enter appropriate mode
                document.getElementById('lock-prompt').style.display = 'none';
                if (data.terrainMaps && data.terrainMaps.length > 0 && (!data.volumes || data.volumes.length === 0)) {
                    // Terrain-only save — go to terrain mode
                    toggleEditorMode();
                }
                // Otherwise stay in indoor mode (user clicks to lock)
            }
        }
    } catch (e) { /* ignore */ }

    // Mode chooser buttons
    if (!loadedSave) {
        const btnIndoor = document.getElementById('btn-indoor');
        const btnTerrain = document.getElementById('btn-terrain');

        function startIndoorMode() {
            document.getElementById('lock-prompt').style.display = 'none';
            const firstVolume = new Volume(state.nextVolumeId++, 0, 0, 0, 16, 12, 16);
            state.volumes.push(firstVolume);
            rebuildVolume(firstVolume);
            renderer.domElement.requestPointerLock();
        }

        function startTerrainMode() {
            document.getElementById('lock-prompt').style.display = 'none';
            toggleEditorMode(); // switches to terrain ortho mode
        }

        if (btnIndoor) btnIndoor.addEventListener('click', startIndoorMode);
        if (btnTerrain) btnTerrain.addEventListener('click', startTerrainMode);
    }

    // Terrain settings panel inputs
    const terrainSubdivInput = document.getElementById('terrain-subdivision');
    const terrainWallHeightInput = document.getElementById('terrain-wall-height');
    const terrainBrushRadiusInput = document.getElementById('terrain-brush-radius');
    const terrainBrushStrengthInput = document.getElementById('terrain-brush-strength');

    if (terrainSubdivInput) {
        terrainSubdivInput.addEventListener('change', () => {
            const terrain = getActiveTerrain();
            if (terrain) terrain.subdivisionLevel = Math.max(1, Math.min(20, parseInt(terrainSubdivInput.value) || 8));
        });
    }
    if (terrainWallHeightInput) {
        terrainWallHeightInput.addEventListener('change', () => {
            const terrain = getActiveTerrain();
            if (terrain) {
                const val = Math.max(1, parseInt(terrainWallHeightInput.value) || 20);
                if (terrain.wallStyle === 'rocky') {
                    terrain.rockyWallHeight = val;
                } else {
                    terrain.wallHeight = val;
                }
                if (terrain.hasMesh) rebuildTerrainWalls(terrain);
            }
        });
    }
    if (terrainBrushRadiusInput) {
        terrainBrushRadiusInput.addEventListener('change', () => {
            state.brushRadius = Math.max(1, Math.min(50, parseInt(terrainBrushRadiusInput.value) || 8));
        });
    }
    if (terrainBrushStrengthInput) {
        terrainBrushStrengthInput.addEventListener('change', () => {
            state.brushStrength = Math.max(0.1, Math.min(1, parseFloat(terrainBrushStrengthInput.value) || 0.5));
        });
    }

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

    // Show selection highlight for selected stair run
    if (state.selectedStairRunId != null && state.selectedPlatformId == null && state.platformPhase === 'selected') {
        const run = state.stairRuns.find(r => r.id === state.selectedStairRunId);
        if (run) {
            const fromPlat = run.fromPlatformId != null ? state.platforms.find(p => p.id === run.fromPlatformId) : null;
            const toPlat = run.toPlatformId != null ? state.platforms.find(p => p.id === run.toPlatformId) : null;
            const fromPt = StairRun.resolveAnchor(fromPlat, run.anchorFrom);
            const toPt = StairRun.resolveAnchor(toPlat, run.anchorTo);
            const stairPts = buildStairRunPreviewLines(fromPt, toPt, run.width, run.stepHeight, run.riseOverRun);
            if (stairPts.length > 0) {
                const stairGeo = new THREE.BufferGeometry();
                stairGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(stairPts), 3));
                platformPreviewGroup.add(new THREE.LineSegments(stairGeo, platformSelectionMat));
            }
        }
    }

    // Simple stair preview — show markers and wireframe
    if (state.platformPhase === 'simple_stair_from' || state.platformPhase === 'simple_stair_to') {
        const W = WORLD_SCALE;
        const s = 0.5;

        // Helper to draw a marker cube into platformPreviewGroup
        const drawPlatformMarker = (cx, cy, cz, mat) => {
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
            platformPreviewGroup.add(new THREE.Line(geo, mat));
        };

        const anyHit = pickAny(camera, volumeMeshes, platformMeshes);
        if (anyHit) {
            const snapped = snapToWTGrid(anyHit.point);
            // Draw hover marker in yellow
            drawPlatformMarker(snapped.x, snapped.y, snapped.z, platformPreviewMat);

            if (state.platformPhase === 'simple_stair_to' && state.simpleStairFrom) {
                // Draw committed first point marker in green
                drawPlatformMarker(state.simpleStairFrom.x, state.simpleStairFrom.y, state.simpleStairFrom.z, platformSelectionMat);

                // Draw stair wireframe preview
                const fromPt = state.simpleStairFrom;
                const toPt = { x: snapped.x, y: snapped.y, z: snapped.z };
                const rise = Math.abs(toPt.y - fromPt.y);
                const ddx = Math.abs(toPt.x - fromPt.x);
                const ddz = Math.abs(toPt.z - fromPt.z);
                if (rise > 0 && (ddx >= 1 || ddz >= 1)) {
                    const stairPts = buildStairRunPreviewLines(
                        fromPt, toPt, state.stairWidth, state.stairStepHeight, state.stairRiseOverRun,
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
// TERRAIN HUD
// ============================================================
const TERRAIN_TOOL_LABELS = { boundary: 'BOUNDARY', hole: 'HOLE', edit: 'EDIT', sculpt: 'SCULPT' };
const BRUSH_LABELS = { raise: 'RAISE/LOWER', noise: 'NOISE', smooth: 'SMOOTH', flatten: 'FLATTEN' };

function updateTerrainHUD() {
    const statusEl = document.getElementById('status');
    const toolInfoEl = document.getElementById('tool-info');
    const terrainSettingsEl = document.getElementById('terrain-settings');
    if (terrainSettingsEl) terrainSettingsEl.style.display = 'block';
    const lines = [];
    const terrain = getActiveTerrain();

    lines.push(`<span style="color:#ff0">TERRAIN MODE</span>`);

    if (terrain) {
        if (state.terrainTool === 'boundary') {
            if (state.terrainDrawingPhase === 'drawing') {
                lines.push(`Drawing boundary: ${state.terrainDrawingVertices.length} vertices`);
                lines.push(`Click near first vertex to close`);
                lines.push(`Backspace=undo vertex  Esc=cancel`);
            } else if (terrain.isClosed && !terrain.hasMesh) {
                lines.push(`Boundary closed: ${terrain.boundary.length} vertices`);
                lines.push(`G=generate mesh  +/-=subdivision (${terrain.subdivisionLevel})`);
            } else if (terrain.hasMesh) {
                lines.push(`Mesh: ${terrain.vertices.length} verts, ${terrain.triangles.length} tris`);
                lines.push(`G=regenerate mesh  +/-=subdivision (${terrain.subdivisionLevel})`);
            } else {
                lines.push(`Click to place boundary vertices`);
            }
        } else if (state.terrainTool === 'hole') {
            if (state.terrainDrawingPhase === 'drawing') {
                lines.push(`Drawing hole: ${state.terrainDrawingVertices.length} vertices`);
                lines.push(`Click near first vertex to close`);
            } else {
                lines.push(`Click to draw hole polygon`);
                lines.push(`Holes: ${terrain.holes.length}`);
            }
        } else if (state.terrainTool === 'edit') {
            lines.push(`Click to move boundary vertices`);
            lines.push(`Boundary: ${terrain.boundary.length} vertices`);
        } else if (state.terrainTool === 'sculpt') {
            lines.push(`Brush: ${BRUSH_LABELS[state.brushType]}`);
            lines.push(`Radius: ${state.brushRadius} | Strength: ${state.brushStrength.toFixed(1)}`);
            lines.push(`Click+drag=apply  Shift=invert`);
            lines.push(`B=cycle brush  +/-=radius  [/]=strength`);
        }

        lines.push(`Wall: ${terrain.wallStyle} | H=${terrain.wallHeight}`);
    }

    lines.push(`Terrains: ${state.terrainMaps.length}`);
    statusEl.innerHTML = lines.join('<br>');

    const toolName = TERRAIN_TOOL_LABELS[state.terrainTool] || state.terrainTool;
    const camMode = state.terrainCameraMode === 'ortho' ? 'TOP-DOWN' : 'PERSPECTIVE';
    toolInfoEl.innerHTML = `Terrain: ${toolName}<br>Camera: ${camMode}<br>M=indoor  T=tool  Tab=camera  Shift+W=wall`;
}

// ============================================================
// TERRAIN PREVIEW
// ============================================================
function updateTerrainPreview() {
    // Clear previous preview objects
    while (terrainPreviewGroup.children.length > 0) {
        const child = terrainPreviewGroup.children[0];
        terrainPreviewGroup.remove(child);
        if (child.geometry) child.geometry.dispose();
    }

    if (state.editorMode !== 'terrain') return;

    const terrain = getActiveTerrain();
    if (!terrain) return;

    // Draw committed boundary (green)
    if (terrain.boundary.length >= 2) {
        const positions = buildBoundaryLines(terrain.boundary, terrain.isClosed);
        if (positions.length > 0) {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            terrainPreviewGroup.add(new THREE.LineSegments(geo, terrainBoundaryMat));
        }
        // Vertex markers
        const markers = buildVertexMarkers(terrain.boundary);
        if (markers.length > 0) {
            const markerGeo = new THREE.BufferGeometry();
            markerGeo.setAttribute('position', new THREE.Float32BufferAttribute(markers, 3));
            terrainPreviewGroup.add(new THREE.LineSegments(markerGeo, terrainVertexMat));
        }
    }

    // Draw committed holes (red)
    for (const hole of terrain.holes) {
        if (hole.length >= 2) {
            const positions = buildBoundaryLines(hole, true);
            if (positions.length > 0) {
                const geo = new THREE.BufferGeometry();
                geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
                terrainPreviewGroup.add(new THREE.LineSegments(geo, terrainHoleMat));
            }
        }
    }

    // Draw in-progress drawing (yellow)
    if (state.terrainDrawingPhase === 'drawing' && state.terrainDrawingVertices.length >= 1) {
        const verts = state.terrainDrawingVertices;
        if (verts.length >= 2) {
            const positions = buildBoundaryLines(verts, false);
            if (positions.length > 0) {
                const geo = new THREE.BufferGeometry();
                geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
                terrainPreviewGroup.add(new THREE.LineSegments(geo, terrainDrawingMat));
            }
        }
        // Vertex markers for drawing
        const markers = buildVertexMarkers(verts, 0.7);
        if (markers.length > 0) {
            const markerGeo = new THREE.BufferGeometry();
            markerGeo.setAttribute('position', new THREE.Float32BufferAttribute(markers, 3));
            terrainPreviewGroup.add(new THREE.LineSegments(markerGeo, terrainDrawingMat));
        }
    }

    // Brush circle (sculpt mode, perspective view)
    if (state.terrainTool === 'sculpt' && state.terrainCameraMode === 'perspective' && isPointerLocked() && terrain.hasMesh) {
        const terrainMesh = terrainMeshes.get(terrain.id);
        if (terrainMesh) {
            const raycaster = new THREE.Raycaster();
            raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
            const intersects = raycaster.intersectObject(terrainMesh, false);
            if (intersects.length > 0) {
                const p = intersects[0].point;
                const W = WORLD_SCALE;
                const cx = p.x / W, cy = p.y / W, cz = p.z / W;
                const circlePositions = buildBrushCircle(cx, cy, cz, state.brushRadius, terrain);
                const circleGeo = new THREE.BufferGeometry();
                circleGeo.setAttribute('position', new THREE.Float32BufferAttribute(circlePositions, 3));
                terrainPreviewGroup.add(new THREE.LineSegments(circleGeo, terrainBrushMat));
            }
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

    // ---- TERRAIN MODE FRAME UPDATE ----
    if (state.editorMode === 'terrain') {
        if (state.terrainCameraMode === 'ortho') {
            // Keyboard pan in ortho mode (no pointer lock needed)
            const keys = new Set();
            if (isKeyDown('KeyW')) keys.add('KeyW');
            if (isKeyDown('KeyS')) keys.add('KeyS');
            if (isKeyDown('KeyA')) keys.add('KeyA');
            if (isKeyDown('KeyD')) keys.add('KeyD');
            if (isKeyDown('ArrowUp')) keys.add('ArrowUp');
            if (isKeyDown('ArrowDown')) keys.add('ArrowDown');
            if (isKeyDown('ArrowLeft')) keys.add('ArrowLeft');
            if (isKeyDown('ArrowRight')) keys.add('ArrowRight');
            updateOrthoCamera(dt, keys);
        } else {
            // Perspective mode in terrain — use normal FPS camera
            if (gizmo.isDragging()) {
                const { dx, dy } = consumeMouseDelta();
                gizmo.processDrag(dx, dy, camera);
            }
            updateCamera(camera, dt);

            // Apply sculpting brush while mouse is held
            if (isSculpting && state.terrainTool === 'sculpt') {
                const terrain = getActiveTerrain();
                if (terrain && terrain.hasMesh) {
                    const terrainMesh = terrainMeshes.get(terrain.id);
                    if (terrainMesh) {
                        const raycaster = new THREE.Raycaster();
                        raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
                        const intersects = raycaster.intersectObject(terrainMesh, false);
                        if (intersects.length > 0) {
                            const p = intersects[0].point;
                            const W = WORLD_SCALE;
                            const invert = isKeyDown('ShiftLeft') || isKeyDown('ShiftRight');
                            applyBrush(terrain, p.x / W, p.z / W, {
                                type: state.brushType,
                                radius: state.brushRadius,
                                strength: state.brushStrength,
                                noiseScale: state.brushNoiseScale,
                                noiseAmp: state.brushNoiseAmp,
                            }, dt, invert);
                            // Update geometry in-place
                            updateTerrainNormals(terrain, terrainMesh.geometry);
                        }
                    }
                }
            }
        }

        updateTerrainPreview();
        updateTerrainHUD();

        const activeCamera = state.terrainCameraMode === 'ortho' ? orthoCamera : camera;

        // No fog in terrain mode — use appropriate background per camera
        scene.fog = null;
        if (state.terrainCameraMode === 'ortho') {
            scene.background = new THREE.Color(0x111118);
        } else {
            scene.background = new THREE.Color(0x556677); // sky blue-grey for outdoor perspective
        }

        renderer.render(scene, activeCamera);
        return;
    }

    // ---- INDOOR MODE FRAME UPDATE ----
    // Restore fog and background for indoor mode
    if (!scene.fog) {
        scene.fog = new THREE.Fog(0x1a1a2e, 30, 80);
        scene.background = new THREE.Color(0x1a1a2e);
    }

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
    updatePlatformPreview();
    updateHUD(camera);
    renderer.render(scene, camera);
}
