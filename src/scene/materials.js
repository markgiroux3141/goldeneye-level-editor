// Procedural textures and materials

import * as THREE from 'three';
import { TEXTURE_SCHEMES } from './textureSchemes.js';

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

// Loaded BMP textures keyed by name (without path/extension)
const textureMap = new Map();

export function initMaterials() {
    wallTex = createCanvasTexture('#808080', '#777777', '#666666');
    floorTex = createCanvasTexture('#6b6b4e', '#636346', '#5a5a42');
    ceilingTex = createCanvasTexture('#909090', '#888888', '#777777');
    highlightTex = createCanvasTexture('#44aa44', '#55bb55', '#33aa33');

    // Collect all unique texture names from all schemes
    const textureNames = new Set();
    for (const scheme of Object.values(TEXTURE_SCHEMES)) {
        for (const zone of Object.values(scheme.zones)) {
            if (zone.texture) textureNames.add(zone.texture);
        }
    }

    // Load all textures
    const loader = new THREE.TextureLoader();
    for (const name of textureNames) {
        const tex = loader.load(`public/textures/${name}.bmp`);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestMipMapLinearFilter;
        textureMap.set(name, tex);
    }

    // Load transparent textures — convert black pixels to alpha=0
    loader.load('public/transparent_textures/railing.bmp', (tex) => {
        const img = tex.image;
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i] < 10 && data[i + 1] < 10 && data[i + 2] < 10) {
                data[i + 3] = 0;
            }
        }
        ctx.putImageData(imageData, 0, 0);
        const rgbaTex = new THREE.CanvasTexture(canvas);
        rgbaTex.wrapS = THREE.RepeatWrapping;
        rgbaTex.wrapT = THREE.RepeatWrapping;
        rgbaTex.magFilter = THREE.NearestFilter;
        rgbaTex.minFilter = THREE.NearestMipMapLinearFilter;
        textureMap.set('railing', rgbaTex);
    });
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

// Build material array for a specific texture scheme.
// Returns array of 7 materials indexed by zone (0-6).
export function getTexturedMaterialArrayForScheme(schemeName) {
    const scheme = TEXTURE_SCHEMES[schemeName] || TEXTURE_SCHEMES.facility_white_tile;

    return Object.keys(scheme.zones).sort((a, b) => a - b).map(zoneIdx => {
        const zone = scheme.zones[zoneIdx];
        if (zone.texture === null) {
            return new THREE.MeshLambertMaterial({
                color: zone.color,
                side: THREE.FrontSide,
                vertexColors: true,
            });
        }
        const baseTex = textureMap.get(zone.texture);
        if (!baseTex) {
            return new THREE.MeshLambertMaterial({
                color: 0xff00ff, // magenta = missing texture
                side: THREE.FrontSide,
                vertexColors: true,
            });
        }
        const t = baseTex.clone();
        t.repeat.set(zone.repeat, zone.repeat);
        if (zone.offsetX || zone.offsetY) t.offset.set(zone.offsetX || 0, zone.offsetY || 0);
        if (zone.rotation) t.rotation = zone.rotation * (Math.PI / 180); // degrees to radians
        t.needsUpdate = true;
        return new THREE.MeshLambertMaterial({
            map: t,
            side: THREE.FrontSide,
            vertexColors: true,
        });
    });
}

// Convenience alias for default scheme
export function getTexturedMaterialArray() {
    return getTexturedMaterialArrayForScheme('facility_white_tile');
}

// Double-sided alpha-tested material for railings.
// The railing BMP is converted to RGBA during init (black → transparent).
export function getRailingMaterial() {
    const baseTex = textureMap.get('railing');
    if (!baseTex) {
        return new THREE.MeshLambertMaterial({ color: 0xff00ff, side: THREE.DoubleSide });
    }
    const t = baseTex.clone();
    t.repeat.set(1.0, 1.0);
    t.needsUpdate = true;
    return new THREE.MeshLambertMaterial({
        map: t,
        side: THREE.DoubleSide,
        alphaTest: 0.5,
        transparent: true,
    });
}

// Simple wireframe-style material for railings in grid mode
export function getRailingGridMaterial() {
    return new THREE.MeshLambertMaterial({
        color: 0xaaaa55,
        side: THREE.DoubleSide,
        opacity: 0.5,
        transparent: true,
    });
}
