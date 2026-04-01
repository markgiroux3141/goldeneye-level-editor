// MeshManager — central coordinator for all mesh rebuild/remove operations

import { volumeMeshes, rebuildAllVolumes } from './volumeMesh.js';
import { platformMeshes, rebuildAllPlatforms } from './platformMesh.js';
import { stairRunMeshes, rebuildAllStairRuns } from './stairRunMesh.js';
import { rebuildAllTerrain } from './terrainMesh.js';

// Re-export mesh Maps for external access (raycasting, previews, etc.)
export { volumeMeshes } from './volumeMesh.js';
export { platformMeshes } from './platformMesh.js';
export { stairRunMeshes } from './stairRunMesh.js';
export { terrainMeshes, terrainWallMeshes } from './terrainMesh.js';

// Re-export individual rebuild/remove functions
export { rebuildVolume, rebuildAllVolumes, removeVolumeMesh } from './volumeMesh.js';
export { rebuildPlatform, rebuildAllPlatforms, removePlatformMesh } from './platformMesh.js';
export { rebuildStairRun, rebuildAllStairRuns, rebuildConnectedStairRuns } from './stairRunMesh.js';
export { rebuildTerrainMesh, rebuildTerrainWalls, rebuildAllTerrain, generateTerrainMesh } from './terrainMesh.js';

// Rebuild everything (volumes + platforms + stair runs + terrain) — used for undo/load
export function rebuildAll() {
    rebuildAllVolumes();
    rebuildAllPlatforms();
    rebuildAllStairRuns();
    rebuildAllTerrain();
}

// Toggle visibility of all indoor meshes (volumes + platforms + stair runs)
export function setIndoorMeshesVisible(visible) {
    for (const [, data] of volumeMeshes) data.mesh.visible = visible;
    for (const [, mesh] of platformMeshes) mesh.visible = visible;
    for (const [, mesh] of stairRunMeshes) mesh.visible = visible;
}
