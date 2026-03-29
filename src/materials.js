// Procedural textures and materials

import * as THREE from 'three';

function createCanvasTexture(color1, color2, lineColor) {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = color1;
    ctx.fillRect(0, 0, size, size);

    // Subtle noise
    for (let i = 0; i < 800; i++) {
        ctx.fillStyle = color2;
        ctx.fillRect(Math.random() * size, Math.random() * size, 1, 1);
    }

    // Grid line border
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, size, size);

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestMipMapLinearFilter;
    return tex;
}

// Shared base textures (cloned per material instance)
let wallTex, floorTex, ceilingTex, highlightTex;

export function initMaterials() {
    wallTex = createCanvasTexture('#808080', '#777777', '#666666');
    floorTex = createCanvasTexture('#6b6b4e', '#636346', '#5a5a42');
    ceilingTex = createCanvasTexture('#909090', '#888888', '#777777');
    highlightTex = createCanvasTexture('#44aa44', '#55bb55', '#33aa33');
}

export function getWallMaterial() {
    return new THREE.MeshLambertMaterial({ map: wallTex.clone(), side: THREE.FrontSide });
}

export function getFloorMaterial() {
    return new THREE.MeshLambertMaterial({ map: floorTex.clone(), side: THREE.FrontSide });
}

export function getCeilingMaterial() {
    return new THREE.MeshLambertMaterial({ map: ceilingTex.clone(), side: THREE.FrontSide });
}

export function getHighlightMaterial() {
    return new THREE.MeshLambertMaterial({
        map: highlightTex.clone(),
        side: THREE.FrontSide,
        emissive: 0x224422,
        emissiveIntensity: 0.5,
    });
}

export function getDoorFrameMaterial() {
    return new THREE.MeshLambertMaterial({ color: 0x8B7355, side: THREE.FrontSide });
}

export function getDoorExitMaterial() {
    return new THREE.MeshLambertMaterial({ color: 0x556655, side: THREE.FrontSide });
}
