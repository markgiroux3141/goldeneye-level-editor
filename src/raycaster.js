// Face picking via raycaster — uses triangle index to faceId lookup

import * as THREE from 'three';

const raycaster = new THREE.Raycaster();
const screenCenter = new THREE.Vector2(0, 0);

// Pick the face under the crosshair
// volumeMeshes: Map<volumeId, { mesh, faceIds }>
export function pickFace(camera, volumeMeshes) {
    raycaster.setFromCamera(screenCenter, camera);

    const meshes = [];
    for (const [, data] of volumeMeshes) {
        meshes.push(data.mesh);
    }

    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;

    const hit = hits[0];
    const mesh = hit.object;

    let faceIds = null;
    for (const [, data] of volumeMeshes) {
        if (data.mesh === mesh) {
            faceIds = data.faceIds;
            break;
        }
    }

    if (!faceIds) return null;

    const triIndex = hit.faceIndex;
    if (triIndex >= 0 && triIndex < faceIds.length) {
        return {
            ...faceIds[triIndex],
            point: hit.point,
        };
    }

    return null;
}
