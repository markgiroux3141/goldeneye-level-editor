// Indoor mode mousedown handler

import { WORLD_SCALE } from '../core/Volume.js';
import { state, saveUndoState } from '../state.js';
import { isPointerLocked } from '../input/input.js';
import { showMessage } from '../hud/hud.js';
import { pickFace, pickPlatform, pickStairRun, pickAny } from '../raycaster.js';
import { addExtrudeSelection, clearExtrudeState, placeDoorOnFace, snapToWTGrid } from '../actions.js';
import { Platform } from '../core/Platform.js';
import { StairRun } from '../core/StairRun.js';
import {
    volumeMeshes, platformMeshes,
    rebuildVolume, rebuildAllVolumes,
    rebuildPlatform, rebuildStairRun, rebuildConnectedStairRuns,
} from '../mesh/MeshManager.js';
import { stairRunMeshes } from '../mesh/MeshManager.js';
import { closestPlatformEdge, closestOffsetOnEdge, projectCrosshairOntoEdge, bestEdgeForDirection } from './platformEdgeUtils.js';
import { clearPlatformToolState } from './ToolManager.js';

export function handleIndoorClick(e, { gizmo, camera }) {
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
                const fromPtR = StairRun.resolveAnchor(fromPlat, run.anchorFrom);
                const toPtR = StairRun.resolveAnchor(toPlat, run.anchorTo);
                const rise = Math.abs(toPtR.y - fromPtR.y);
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
                const camPos = camera.position;
                if (anyHit.axis === 'x') {
                    const wallX = snapped.x;
                    if (camPos.x / WORLD_SCALE > wallX) {
                        px = wallX;
                    } else {
                        px = wallX - state.platformSizeX;
                    }
                } else {
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
                const toPlat = state.platforms.find(p => p.id === anyHit.platformId);
                const edge = closestPlatformEdge(toPlat, anyHit.point);
                state.platformConnectTo = { type: 'platform', platformId: toPlat.id, edge };
                const dir = { x: toPlat.centerX - fromPlat.centerX, z: toPlat.centerZ - fromPlat.centerZ };
                state.platformConnectFrom.edge = bestEdgeForDirection(fromPlat, dir);
            } else if (anyHit.type === 'ground' || anyHit.type === 'volume') {
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

            const fromPt = fromPlat.getEdgePointAtOffset(from.edge, offset);
            fromPt.y = fromPlat.y;

            let toPt;
            if (to.type === 'platform') {
                const toPlat = state.platforms.find(p => p.id === to.platformId);
                const destOffset = closestOffsetOnEdge(toPlat, to.edge, fromPt);
                toPlatformId = toPlat.id;
                anchorTo = { edge: to.edge, offset: destOffset };
                toPt = { ...toPlat.getEdgePointAtOffset(to.edge, destOffset), y: toPlat.y };
            } else {
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
        if (hit.bounds.u0 === 0 && hit.bounds.u1 === 0 && hit.bounds.v0 === 0 && hit.bounds.v1 === 0) return;

        if (!e.shiftKey) {
            clearExtrudeState();
        }
        addExtrudeSelection(hit.volumeId, hit.axis, hit.side, hit.point, showMessage);
        return;
    }

    if (state.tool === 'door' && !(hit.bounds.u0 === 0 && hit.bounds.u1 === 0 && hit.bounds.v0 === 0 && hit.bounds.v1 === 0)) {
        placeDoorOnFace(hit.volumeId, hit.axis, hit.side, hit.point, showMessage, rebuildVolume);
    } else {
        state.selectedFace = hit;
        rebuildAllVolumes();
    }
}
