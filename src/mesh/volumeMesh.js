// Volume mesh lifecycle — rebuild, remove, get connections

import * as THREE from 'three';
import { state } from '../state.js';
import { buildVolumeGeometry } from '../geometry/volumeGeometry.js';
import { getWallMaterial, getTexturedMaterialArrayForScheme } from '../scene/materials.js';
import { scene } from '../scene/setup.js';
import { reapplyBakedColors } from '../lighting/bakedColorStore.js';

// Volume mesh storage: Map<volumeId, { mesh, faceIds }>
export const volumeMeshes = new Map();

function getVolumeConnections(volId) {
    return state.connections.filter(c => c.volAId === volId || c.volBId === volId);
}

export function rebuildVolume(vol) {
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

    // Re-apply baked lighting if active
    if (state.bakedLighting) {
        reapplyBakedColors('vol_' + vol.id, geometry);
    }
}

export function rebuildAllVolumes() {
    for (const [id, data] of volumeMeshes) {
        scene.remove(data.mesh);
        data.mesh.geometry.dispose();
    }
    volumeMeshes.clear();

    for (const vol of state.volumes) {
        rebuildVolume(vol);
    }
}

export function removeVolumeMesh(volId) {
    const data = volumeMeshes.get(volId);
    if (data) {
        scene.remove(data.mesh);
        data.mesh.geometry.dispose();
        volumeMeshes.delete(volId);
    }
}
