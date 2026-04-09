// Platform tool preview — selection outlines, connect mode visuals, stair preview

import * as THREE from 'three';
import { WORLD_SCALE } from '../core/constants.js';
import { state } from '../state.js';
import { pickAny } from '../raycaster.js';
import { isPointerLocked } from '../input/input.js';
import { snapToWTGrid } from '../actions.js';
import { Platform } from '../core/Platform.js';
import { StairRun } from '../core/StairRun.js';
import { buildPlatformPreviewLines, buildEdgeHighlightLines, buildEdgeSlotLines, buildStairRunPreviewLines } from '../geometry/platformGeometry.js';
import { csgRegionMeshes, platformMeshes } from '../mesh/MeshManager.js';
import { closestPlatformEdge, closestOffsetOnEdge, projectCrosshairOntoEdge } from '../tools/platformEdgeUtils.js';
import { scene } from '../scene/setup.js';

const platformPreviewGroup = new THREE.Group();
let _added = false;
const platformPreviewMat = new THREE.LineBasicMaterial({ color: 0xffff00, linewidth: 2 });
const platformSelectionMat = new THREE.LineBasicMaterial({ color: 0x00ff00, linewidth: 2 });
const platformEdgeHighlightMat = new THREE.LineBasicMaterial({ color: 0x00ffff, linewidth: 3 });

export function updatePlatformPreview(camera) {
    if (!_added) { scene.add(platformPreviewGroup); _added = true; }
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

    // Connect mode visuals — phase 1: choosing destination
    if (state.platformPhase === 'connecting_dst' && state.platformConnectFrom) {
        const fromPlat = state.platforms.find(p => p.id === state.platformConnectFrom.platformId);
        if (fromPlat) {
            const anyHit = pickAny(camera, csgRegionMeshes, platformMeshes);
            if (anyHit) {
                if (anyHit.type === 'platform' && anyHit.platformId !== fromPlat.id) {
                    const toPlat = state.platforms.find(p => p.id === anyHit.platformId);
                    if (toPlat) {
                        const edge = closestPlatformEdge(toPlat, anyHit.point);
                        const edgePts = buildEdgeHighlightLines(toPlat, edge);
                        const edgeGeo = new THREE.BufferGeometry();
                        edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(edgePts), 3));
                        platformPreviewGroup.add(new THREE.LineSegments(edgeGeo, platformEdgeHighlightMat));
                    }
                }
            }
        }
    }

    // Connect mode visuals — phase 2: sliding source slot + stair preview
    if (state.platformPhase === 'connecting_src' && state.platformConnectFrom && state.platformConnectTo) {
        const from = state.platformConnectFrom;
        const to = state.platformConnectTo;
        const fromPlat = state.platforms.find(p => p.id === from.platformId);
        if (fromPlat) {
            const edgePts = buildEdgeHighlightLines(fromPlat, from.edge);
            const edgeGeo = new THREE.BufferGeometry();
            edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(edgePts), 3));
            platformPreviewGroup.add(new THREE.LineSegments(edgeGeo, platformEdgeHighlightMat));

            const offset = projectCrosshairOntoEdge(fromPlat, from.edge, camera);
            const slotPts = buildEdgeSlotLines(fromPlat, from.edge, offset, state.stairWidth);
            const slotGeo = new THREE.BufferGeometry();
            slotGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(slotPts), 3));
            platformPreviewGroup.add(new THREE.LineSegments(slotGeo, platformSelectionMat));

            const fromPt = { ...fromPlat.getEdgePointAtOffset(from.edge, offset), y: fromPlat.y };
            let destPt = null;

            if (to.type === 'platform') {
                const toPlat = state.platforms.find(p => p.id === to.platformId);
                if (toPlat) {
                    const destOffset = closestOffsetOnEdge(toPlat, to.edge, fromPt);
                    destPt = { ...toPlat.getEdgePointAtOffset(to.edge, destOffset), y: toPlat.y };

                    const destSlotPts = buildEdgeSlotLines(toPlat, to.edge, destOffset, state.stairWidth);
                    const destGeo = new THREE.BufferGeometry();
                    destGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(destSlotPts), 3));
                    platformPreviewGroup.add(new THREE.LineSegments(destGeo, platformEdgeHighlightMat));
                }
            } else {
                const normal = Platform.edgeNormal(from.edge);
                const destY = to.y ?? 0;
                const rise = fromPlat.y - destY;
                const run = rise / state.stairRiseOverRun;
                const gx = fromPt.x + normal.x * run;
                const gz = fromPt.z + normal.z * run;
                destPt = { x: Math.round(gx), y: destY, z: Math.round(gz) };
            }

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

    // Selection highlight for selected stair run
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

    // Simple stair preview — markers and wireframe
    if (state.platformPhase === 'simple_stair_from' || state.platformPhase === 'simple_stair_to') {
        const W = WORLD_SCALE;
        const s = 0.5;

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

        const anyHit = pickAny(camera, csgRegionMeshes, platformMeshes);
        if (anyHit) {
            const snapped = snapToWTGrid(anyHit.point);
            drawPlatformMarker(snapped.x, snapped.y, snapped.z, platformPreviewMat);

            if (state.platformPhase === 'simple_stair_to' && state.simpleStairFrom) {
                drawPlatformMarker(state.simpleStairFrom.x, state.simpleStairFrom.y, state.simpleStairFrom.z, platformSelectionMat);

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

    // Hover preview when idle
    if (state.platformPhase === 'idle') {
        const anyHit = pickAny(camera, csgRegionMeshes, platformMeshes);
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
