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

// Real textures loaded from BMP files
let brownWallTex, greyTileFloorTex, whiteTileTex, stairGradientTex, floorDoorframeTex;

export function initMaterials() {
    wallTex = createCanvasTexture('#808080', '#777777', '#666666');
    floorTex = createCanvasTexture('#6b6b4e', '#636346', '#5a5a42');
    ceilingTex = createCanvasTexture('#909090', '#888888', '#777777');
    highlightTex = createCanvasTexture('#44aa44', '#55bb55', '#33aa33');

    // Load real textures for textured mode
    const loader = new THREE.TextureLoader();
    const configTex = (tex) => {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestMipMapLinearFilter;
        return tex;
    };

    brownWallTex = configTex(loader.load('public/textures/brown_wall.bmp'));
    greyTileFloorTex = configTex(loader.load('public/textures/grey_tile_floor.bmp'));
    whiteTileTex = configTex(loader.load('public/textures/white_tile.bmp'));
    stairGradientTex = configTex(loader.load('public/textures/stair_gradient.bmp'));
    floorDoorframeTex = configTex(loader.load('public/textures/floor_doorframe.bmp'));
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

// Returns array of materials for textured mode, indexed by zone:
//   0 = floor (grey_tile_floor)
//   1 = ceiling (brown_wall)
//   2 = lower wall (white_tile)
//   3 = upper wall (brown_wall)
//   4 = tunnel/door frame (unused, kept for index stability)
//   5 = tunnel sides + top (stair_gradient)
//   6 = tunnel floor (floor_doorframe)
export function getTexturedMaterialArray() {
    const makemat = (tex, repeatScale) => {
        const t = tex.clone();
        t.repeat.set(repeatScale, repeatScale);
        t.needsUpdate = true;
        return new THREE.MeshLambertMaterial({
            map: t,
            side: THREE.FrontSide,
            vertexColors: true,
        });
    };

    return [
        makemat(greyTileFloorTex, 0.35),   // zone 0: floor — slightly smaller tiles
        makemat(brownWallTex, 0.10),        // zone 1: ceiling — large scale
        makemat(whiteTileTex, 0.80),        // zone 2: lower wall — small individual tiles
        makemat(brownWallTex, 0.10),        // zone 3: upper wall — large scale
        new THREE.MeshLambertMaterial({     // zone 4: tunnel (legacy fallback)
            color: 0x8B7355,
            side: THREE.FrontSide,
            vertexColors: true,
        }),
        makemat(stairGradientTex, 1.0),     // zone 5: tunnel sides + top (UVs handle stretching)
        makemat(floorDoorframeTex, 0.35),   // zone 6: tunnel floor
    ];
}
