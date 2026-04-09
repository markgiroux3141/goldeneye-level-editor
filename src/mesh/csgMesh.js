// CSG mesh lifecycle — cluster brushes into regions, run CSG, swap meshes.
//
// During the migration (Phase 3-5) this lives alongside volumeMesh.js.
// Phase 6 deletes volumeMesh.js once nothing references it.

import * as THREE from 'three';
import { state } from '../state.js';
import { scene } from '../scene/setup.js';
import { clusterBrushes } from '../core/csg/regions.js';
import { assignUVsAndZones } from '../core/csg/uvZones.js';
import { getCSGMaterialsForScheme } from '../scene/materials.js';

// Per-region mesh storage: Map<regionId, { mesh, faceIds, lastEvalMs }>
// regionId is assigned by clusterBrushes — note it's NOT stable across rebuilds
// because clustering is recomputed every time. The map is fully rebuilt on each
// rebuildAllCSG() call. This is fine because regionId is only used as a transient
// scene-graph key, not for selection or persistence.
export const csgRegionMeshes = new Map();

// Fallback material for grid (non-textured) view mode.
// Matches the spike's mainMaterial. vertexColors is on so baked lighting (which
// writes per-vertex colors directly into the CSG geometry) is visible in grid
// mode too — unbaked geometry still reads white-by-default and renders flat.
const _gridMaterial = new THREE.MeshStandardMaterial({
    color: 0x6688aa, roughness: 0.7, metalness: 0.1,
    flatShading: true, side: THREE.FrontSide, vertexColors: true,
});

function disposeRegion(data) {
    scene.remove(data.mesh);
    if (data.mesh.geometry) data.mesh.geometry.dispose();
    // Don't dispose materials — they're cached and shared across rebuilds
    // (see materials.js getCSGMaterialsForScheme).
}

// Rebuild every CSG region from scratch. Used by undo, load, and any change
// that adds/removes brushes (which can change clustering).
//
// `brushes` defaults to state.csg.brushes — production code calls with no args.
// Tests may pass an explicit brush list to avoid module-state coordination.
export function rebuildAllCSG(brushes = state.csg.brushes) {
    // Phase 9 (Flavor A): any rebuild invalidates the baked lighting on CSG.
    // Vertex colors are stored only on the live mesh's color attribute, and
    // assignUVsAndZones writes white-by-default for fresh geometry, so once
    // we tear down the old meshes the bake is gone. Flip the flag so the
    // platform/stair reapply paths and the HUD know the bake is stale.
    if (state.bakedLighting) state.bakedLighting = false;

    // Tear down existing region meshes
    for (const [, data] of csgRegionMeshes) disposeRegion(data);
    csgRegionMeshes.clear();

    if (brushes.length === 0) return;

    // Cluster brushes into connected regions
    const regions = clusterBrushes(brushes);

    for (const region of regions) {
        const { geometry: rawGeo, faceIds: rawFaceIds, timeMs } = region.evaluateBrushes();

        let finalGeo, finalFaceIds, material;
        if (state.viewMode === 'textured') {
            const result = assignUVsAndZones(rawGeo, rawFaceIds, region.brushes, getCSGMaterialsForScheme);
            finalGeo = result.geometry;
            finalFaceIds = result.faceIds;
            material = result.materials;
            rawGeo.dispose();
        } else {
            finalGeo = rawGeo;
            finalFaceIds = rawFaceIds;
            material = _gridMaterial;
            // Grid material uses vertexColors so baked lighting can paint into
            // it; seed a white color attribute so unbaked geometry renders the
            // flat material color rather than black ("Stevie Wonder" bug).
            if (!finalGeo.getAttribute('color')) {
                const vertCount = finalGeo.getAttribute('position').count;
                const whiteColors = new Float32Array(vertCount * 3).fill(1);
                finalGeo.setAttribute('color', new THREE.Float32BufferAttribute(whiteColors, 3));
            }
        }

        const mesh = new THREE.Mesh(finalGeo, material);
        mesh.userData = { regionId: region.id, isCSG: true };

        // Edge wireframe overlay (always added; toggleable via setAllWireframeVisible)
        if (state.viewMode === 'textured') {
            const edgesGeo = new THREE.EdgesGeometry(finalGeo, 30);
            const edgesMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.15 });
            const edgesLines = new THREE.LineSegments(edgesGeo, edgesMat);
            mesh.add(edgesLines);
        } else {
            const edges = new THREE.EdgesGeometry(finalGeo);
            const wireframe = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x333333 }));
            mesh.add(wireframe);
        }

        csgRegionMeshes.set(region.id, { mesh, faceIds: finalFaceIds, lastEvalMs: timeMs, region });
        scene.add(mesh);
    }
}

// Rebuild only the regions that contain any of the given brush ids.
// Falls back to a full rebuild if the brush set straddles regions or if
// clustering would change (e.g., adding/removing brushes).
//
// Phase 5 callers will use this for fast incremental rebuilds during push/pull.
// For now (Phase 3) we just expose it; the implementation always full-rebuilds
// because we don't have stable regionIds across calls.
export function rebuildAffectedRegions(/* brushIds */) {
    // Conservative: always full-rebuild until Phase 5 introduces stable region tracking.
    rebuildAllCSG();
}

// Remove a region mesh by id. Currently unused — exposed for Phase 5 callers
// that may want to drop a region without rebuilding everything.
export function removeCSGRegion(regionId) {
    const data = csgRegionMeshes.get(regionId);
    if (data) {
        disposeRegion(data);
        csgRegionMeshes.delete(regionId);
    }
}
