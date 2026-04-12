// CSG mesh lifecycle — cluster brushes into regions, run CSG, swap meshes.
//
// Supports two rebuild modes:
//   1. rebuildAllCSG()   — full teardown + recluster (used by undo, load, delete)
//   2. rebuildAffectedRegions(brushIds) — incremental, only re-evaluates dirty regions

import * as THREE from 'three';
import { state } from '../state.js';
import { scene } from '../scene/setup.js';
import { clusterBrushes, brushesOverlapOrTouch } from '../core/csg/regions.js';
import { CSGRegion } from '../core/csg/CSGRegion.js';
import { assignUVsAndZones } from '../core/csg/uvZones.js';
import { getCSGMaterialsForScheme } from '../scene/materials.js';

// Per-region mesh storage: Map<regionId, { mesh, faceIds, lastEvalMs, region }>
export const csgRegionMeshes = new Map();

// ─── Stable region tracking ──────────────────────────────────────────
// Persistent maps that survive across incremental rebuilds.
// Only reset by rebuildAllCSG() (undo / load / delete).
const regionMap = new Map();        // regionId -> CSGRegion
const brushToRegion = new Map();    // brushId  -> regionId
let nextStableRegionId = 1;

// Fallback material for grid (non-textured) view mode.
const _gridMaterial = new THREE.MeshStandardMaterial({
    color: 0x6688aa, roughness: 0.7, metalness: 0.1,
    flatShading: true, side: THREE.FrontSide, vertexColors: true,
});

function disposeRegion(data) {
    scene.remove(data.mesh);
    if (data.mesh.geometry) data.mesh.geometry.dispose();
}

// ─── Build mesh for a single region ──────────────────────────────────
function buildRegionMesh(region) {
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
        if (!finalGeo.getAttribute('color')) {
            const vertCount = finalGeo.getAttribute('position').count;
            const whiteColors = new Float32Array(vertCount * 3).fill(1);
            finalGeo.setAttribute('color', new THREE.Float32BufferAttribute(whiteColors, 3));
        }
    }

    const mesh = new THREE.Mesh(finalGeo, material);
    mesh.userData = { regionId: region.id, isCSG: true };

    // Edge wireframe overlay
    if (state.viewMode === 'textured') {
        const edgesGeo = new THREE.EdgesGeometry(finalGeo, 30);
        const edgesMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.15 });
        mesh.add(new THREE.LineSegments(edgesGeo, edgesMat));
    } else {
        const edges = new THREE.EdgesGeometry(finalGeo);
        mesh.add(new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x333333 })));
    }

    csgRegionMeshes.set(region.id, { mesh, faceIds: finalFaceIds, lastEvalMs: timeMs, region });
    scene.add(mesh);
}

// ─── Full rebuild ────────────────────────────────────────────────────
// Used by undo, load, delete, and any change that may alter clustering.
export function rebuildAllCSG(brushes = state.csg.brushes) {
    // Invalidate baked lighting
    if (state.bakedLighting) state.bakedLighting = false;

    // Tear down all existing region meshes
    for (const [, data] of csgRegionMeshes) disposeRegion(data);
    csgRegionMeshes.clear();

    // Reset stable tracking maps
    regionMap.clear();
    brushToRegion.clear();

    if (brushes.length === 0) return;

    // Cluster brushes into connected regions
    const regions = clusterBrushes(brushes);

    for (const region of regions) {
        // Assign stable IDs
        region.id = nextStableRegionId++;

        // Populate tracking maps
        regionMap.set(region.id, region);
        for (const b of region.brushes) {
            brushToRegion.set(b.id, region.id);
        }

        buildRegionMesh(region);
    }
}

// ─── Incremental rebuild ─────────────────────────────────────────────
// Only re-evaluates regions that contain the given brush IDs.
// All other region meshes stay untouched in the scene.
export function rebuildAffectedRegions(brushIds) {
    if (!brushIds || brushIds.length === 0) { rebuildAllCSG(); return; }

    // Invalidate baked lighting
    if (state.bakedLighting) state.bakedLighting = false;

    // Collect unique dirty region IDs
    const dirtyRegionIds = new Set();
    for (const bid of brushIds) {
        const rid = brushToRegion.get(bid);
        if (rid != null) dirtyRegionIds.add(rid);
    }

    // If we couldn't map any brush to a region, fall back to full rebuild
    if (dirtyRegionIds.size === 0) { rebuildAllCSG(); return; }

    for (const rid of dirtyRegionIds) {
        const region = regionMap.get(rid);
        if (!region) continue;

        // Dispose old mesh for this region
        const oldData = csgRegionMeshes.get(rid);
        if (oldData) disposeRegion(oldData);
        csgRegionMeshes.delete(rid);

        // Rebuild just this region
        buildRegionMesh(region);
    }
}

// ─── Brush-to-region assignment (for new brushes) ────────────────────
// O(n) scan: test new brush against all existing brushes to find which
// region(s) it touches, then add it to that region. If it touches
// multiple regions, merge them. If none, create a new region.
export function assignBrushToRegion(brush) {
    const touchedRegionIds = new Set();

    // Build a quick lookup from brush id to BrushDef
    const brushById = new Map();
    for (const b of state.csg.brushes) brushById.set(b.id, b);

    for (const [bid, rid] of brushToRegion) {
        const existing = brushById.get(bid);
        if (!existing) continue;
        if (brushesOverlapOrTouch(brush, existing)) {
            touchedRegionIds.add(rid);
        }
    }

    if (touchedRegionIds.size === 0) {
        // New isolated region
        const rid = nextStableRegionId++;
        const region = new CSGRegion(rid);
        region.brushes.push(brush);
        region.updateShell();
        regionMap.set(rid, region);
        brushToRegion.set(brush.id, rid);
        return;
    }

    if (touchedRegionIds.size === 1) {
        // Add to existing region
        const rid = touchedRegionIds.values().next().value;
        const region = regionMap.get(rid);
        if (region) {
            region.brushes.push(brush);
            brushToRegion.set(brush.id, rid);
        }
        return;
    }

    // Touches multiple regions — merge them into the first
    const rids = [...touchedRegionIds];
    const primaryRid = rids[0];
    const primaryRegion = regionMap.get(primaryRid);

    for (let i = 1; i < rids.length; i++) {
        const mergeRid = rids[i];
        const mergeRegion = regionMap.get(mergeRid);
        if (!mergeRegion) continue;

        // Move all brushes from mergeRegion to primaryRegion
        for (const b of mergeRegion.brushes) {
            primaryRegion.brushes.push(b);
            brushToRegion.set(b.id, primaryRid);
        }

        // If mergeRegion had baked geometry, we need a full rebuild
        // to properly merge the baked CSG brushes.
        if (mergeRegion.bakedCSGBrush) {
            primaryRegion.brushes.push(brush);
            brushToRegion.set(brush.id, primaryRid);
            rebuildAllCSG();
            return;
        }

        // Dispose the merged region's mesh
        const oldData = csgRegionMeshes.get(mergeRid);
        if (oldData) disposeRegion(oldData);
        csgRegionMeshes.delete(mergeRid);
        regionMap.delete(mergeRid);
    }

    primaryRegion.brushes.push(brush);
    brushToRegion.set(brush.id, primaryRid);
}

// ─── Direct brush-to-region registration (no overlap scan) ──────────
// Used when the caller already knows which region the brush belongs to
// (e.g. stair brushes carved from a known wall face).
export function assignBrushToRegionDirect(brushId, regionId) {
    brushToRegion.set(brushId, regionId);
}

// ─── Remove brush from region tracking ───────────────────────────────
export function removeBrushFromRegion(brushId) {
    const rid = brushToRegion.get(brushId);
    if (rid == null) return;

    const region = regionMap.get(rid);
    if (region) {
        region.brushes = region.brushes.filter(b => b.id !== brushId);
    }
    brushToRegion.delete(brushId);
}

// Remove a region mesh by id.
export function removeCSGRegion(regionId) {
    const data = csgRegionMeshes.get(regionId);
    if (data) {
        disposeRegion(data);
        csgRegionMeshes.delete(regionId);
    }
}
