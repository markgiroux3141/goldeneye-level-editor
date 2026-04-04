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

// Pick a platform mesh under the crosshair
// platformMeshes: Map<platformId, THREE.Mesh>
export function pickPlatform(camera, platformMeshes) {
    raycaster.setFromCamera(screenCenter, camera);

    const meshes = [];
    for (const [, mesh] of platformMeshes) {
        meshes.push(mesh);
    }

    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;

    const hit = hits[0];
    const mesh = hit.object;
    const platformId = mesh.userData.platformId;
    if (platformId == null) return null;

    return { platformId, point: hit.point };
}

// Pick a stair run mesh under the crosshair
// stairRunMeshes: Map<stairRunId, THREE.Mesh>
export function pickStairRun(camera, stairRunMeshes) {
    raycaster.setFromCamera(screenCenter, camera);

    const meshes = [];
    for (const [, mesh] of stairRunMeshes) {
        meshes.push(mesh);
    }

    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;

    const hit = hits[0];
    const mesh = hit.object;
    const stairRunId = mesh.userData.stairRunId;
    if (stairRunId == null) return null;

    return { stairRunId, point: hit.point };
}

// Pick only the ground plane (ignoring all meshes)
export function pickGroundOnly(camera) {
    raycaster.setFromCamera(screenCenter, camera);
    const intersect = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(groundPlane, intersect)) {
        return { type: 'ground', point: intersect.clone() };
    }
    return null;
}

// Pick a light mesh under the crosshair
// pickTargets: array of Mesh (icon + core parts from getLightPickTargets())
export function pickLight(camera, pickTargets) {
    raycaster.setFromCamera(screenCenter, camera);

    const hits = raycaster.intersectObjects(pickTargets, false);
    if (hits.length === 0) return null;

    const hit = hits[0];
    const lightId = hit.object.userData.lightId;
    if (lightId == null) return null;

    return { lightId, point: hit.point };
}

// Pick any object (volumes, platforms, lights) or the ground plane — returns the nearest hit
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // Y=0 ground plane
const groundIntersect = new THREE.Vector3();

export function pickAny(camera, volumeMeshes, platformMeshes, lightPickTargets) {
    raycaster.setFromCamera(screenCenter, camera);

    const allMeshes = [];
    for (const [, data] of volumeMeshes) allMeshes.push(data.mesh);
    for (const [, mesh] of platformMeshes) allMeshes.push(mesh);
    if (lightPickTargets) {
        for (const mesh of lightPickTargets) allMeshes.push(mesh);
    }

    const hits = raycaster.intersectObjects(allMeshes, false);

    // Also check ground plane
    let groundHit = null;
    let groundDist = Infinity;
    if (raycaster.ray.intersectPlane(groundPlane, groundIntersect)) {
        groundDist = groundIntersect.distanceTo(raycaster.ray.origin);
        groundHit = { type: 'ground', point: groundIntersect.clone() };
    }

    if (hits.length === 0) return groundHit;

    const hit = hits[0];
    const mesh = hit.object;

    // If ground is closer than the mesh hit (with tolerance to avoid z-fighting), return ground
    if (groundHit && groundDist < hit.distance - 0.01) {
        return groundHit;
    }

    // Check if it's a light
    if (mesh.userData.lightId != null) {
        return { type: 'light', lightId: mesh.userData.lightId, point: hit.point };
    }

    // Check if it's a platform
    if (mesh.userData.platformId != null) {
        return { type: 'platform', platformId: mesh.userData.platformId, point: hit.point };
    }

    // Check if it's a volume
    if (mesh.userData.volumeId != null) {
        let faceIds = null;
        for (const [, data] of volumeMeshes) {
            if (data.mesh === mesh) { faceIds = data.faceIds; break; }
        }
        if (faceIds) {
            const triIndex = hit.faceIndex;
            if (triIndex >= 0 && triIndex < faceIds.length) {
                return { type: 'volume', ...faceIds[triIndex], point: hit.point };
            }
        }
    }

    return null;
}
