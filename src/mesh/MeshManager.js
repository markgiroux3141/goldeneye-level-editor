// MeshManager — central coordinator for all mesh rebuild/remove operations

import { volumeMeshes, rebuildAllVolumes } from './volumeMesh.js';
import { platformMeshes, rebuildAllPlatforms } from './platformMesh.js';
import { stairRunMeshes, rebuildAllStairRuns } from './stairRunMesh.js';
import { rebuildAllTerrain } from './terrainMesh.js';
import { lightMeshes, rebuildAllLights } from './lightMesh.js';

// Re-export mesh Maps for external access (raycasting, previews, etc.)
export { volumeMeshes } from './volumeMesh.js';
export { platformMeshes } from './platformMesh.js';
export { stairRunMeshes } from './stairRunMesh.js';
export { terrainMeshes, terrainWallMeshes } from './terrainMesh.js';
export { lightMeshes } from './lightMesh.js';

// Re-export individual rebuild/remove functions
export { rebuildVolume, rebuildAllVolumes, removeVolumeMesh } from './volumeMesh.js';
export { rebuildPlatform, rebuildAllPlatforms, removePlatformMesh } from './platformMesh.js';
export { rebuildStairRun, rebuildAllStairRuns, rebuildConnectedStairRuns } from './stairRunMesh.js';
export { rebuildTerrainMesh, rebuildTerrainWalls, rebuildAllTerrain, generateTerrainMesh } from './terrainMesh.js';
export { rebuildLight, rebuildAllLights, removeLightMesh, updateLightSelection, getLightPickTargets, setRealtimePreview } from './lightMesh.js';

// Rebuild everything (volumes + platforms + stair runs + terrain + lights) — used for undo/load
export function rebuildAll() {
    rebuildAllVolumes();
    rebuildAllPlatforms();
    rebuildAllStairRuns();
    rebuildAllTerrain();
    rebuildAllLights();
}

// Toggle visibility of all indoor meshes (volumes + platforms + stair runs + lights)
export function setIndoorMeshesVisible(visible) {
    for (const [, data] of volumeMeshes) data.mesh.visible = visible;
    for (const [, mesh] of platformMeshes) mesh.visible = visible;
    for (const [, mesh] of stairRunMeshes) mesh.visible = visible;
    for (const [, group] of lightMeshes) group.visible = visible;
}

// Toggle wireframe (LineSegments) visibility on all indoor meshes
export function setAllWireframeVisible(visible) {
    function setWireframe(mesh) {
        for (const child of mesh.children) {
            if (child.isLineSegments) child.visible = visible;
        }
    }
    for (const [, data] of volumeMeshes) setWireframe(data.mesh);
    for (const [, mesh] of platformMeshes) setWireframe(mesh);
    for (const [, mesh] of stairRunMeshes) setWireframe(mesh);
}
