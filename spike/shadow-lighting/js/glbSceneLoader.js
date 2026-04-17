// glbSceneLoader.js — Load a GLB level file and adapt it to the spike's scene contract.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const GLB_URL = '../../created-levels/level_1.glb';

function ensureColorAttribute(geometry) {
    if (geometry.getAttribute('color')) return;
    const count = geometry.getAttribute('position').count;
    const arr = new Float32Array(count * 3);
    arr.fill(1);
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
}

function ensureNormalAttribute(geometry) {
    if (geometry.getAttribute('normal')) return;
    geometry.computeVertexNormals();
}

function lightsFromBounds(bbox) {
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    bbox.getSize(size);
    bbox.getCenter(center);

    const diag = size.length();
    const range = Math.max(10, diag * 0.6);
    const y = bbox.min.y + size.y * 0.75;

    // Place two lights along the longest horizontal axis
    const useX = size.x >= size.z;
    const axisMin = useX ? bbox.min.x : bbox.min.z;
    const axisSize = useX ? size.x : size.z;
    const posA = axisMin + axisSize * (1 / 3);
    const posB = axisMin + axisSize * (2 / 3);
    const other = useX ? center.z : center.x;

    const mkLight = (a, b, color, intensity) => useX
        ? { x: a, y, z: b, color, intensity, range, enabled: true }
        : { x: b, y, z: a, color, intensity, range, enabled: true };

    return [
        mkLight(posA, other, { r: 1, g: 0.9, b: 0.7 }, 5.0),
        mkLight(posB, other, { r: 0.5, g: 0.6, b: 0.8 }, 1.5),
    ];
}

export async function loadGLBScene() {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(GLB_URL);

    const meshes = [];
    const combinedBBox = new THREE.Box3();
    combinedBBox.makeEmpty();

    gltf.scene.updateMatrixWorld(true);

    gltf.scene.traverse((obj) => {
        if (!obj.isMesh) return;

        // Bake world matrix into geometry so bake raycaster can use world-space positions directly
        const geometry = obj.geometry.clone();
        geometry.applyMatrix4(obj.matrixWorld);

        ensureNormalAttribute(geometry);
        ensureColorAttribute(geometry);
        geometry.computeBoundingBox();

        // Stash original material for textures toggle
        const originalMaterial = Array.isArray(obj.material) ? obj.material[0] : obj.material;
        geometry.userData.originalMaterial = originalMaterial;

        const bb = geometry.boundingBox;
        const aabb = {
            minX: bb.min.x, maxX: bb.max.x,
            minY: bb.min.y, maxY: bb.max.y,
            minZ: bb.min.z, maxZ: bb.max.z,
        };

        meshes.push({ geometry, originalMaterial, aabb });
        combinedBBox.union(bb);
    });

    const lights = lightsFromBounds(combinedBBox);

    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    combinedBBox.getCenter(center);
    combinedBBox.getSize(size);
    const diag = size.length();
    const cameraPos = new THREE.Vector3(
        center.x + diag * 0.6,
        combinedBBox.max.y + diag * 0.3,
        center.z + diag * 0.9,
    );

    return {
        meshes,
        lights,
        cameraTarget: center,
        cameraPos,
    };
}
