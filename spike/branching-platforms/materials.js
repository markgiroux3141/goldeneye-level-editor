// Load just the two textures we need for the simple_blue style:
//   floor_doorframe.bmp  — top / tread (zone 0)
//   blue_stairs.bmp      — vertical surfaces (zone 3)

import * as THREE from 'three';

const TEX_DIR = '../../public/textures/';

let floorTex = null;
let blueTex = null;

export async function loadTextures() {
    const loader = new THREE.TextureLoader();
    const load = (name) => new Promise((resolve, reject) => {
        loader.load(
            TEX_DIR + name + '.bmp',
            (tex) => {
                tex.wrapS = THREE.RepeatWrapping;
                tex.wrapT = THREE.RepeatWrapping;
                tex.magFilter = THREE.LinearFilter;
                tex.minFilter = THREE.LinearMipmapLinearFilter;
                resolve(tex);
            },
            undefined,
            (err) => reject(new Error('failed to load ' + name + ': ' + err)),
        );
    });
    [floorTex, blueTex] = await Promise.all([load('floor_doorframe'), load('blue_stairs')]);
}

// Two materials corresponding to zone 0 (floor) and zone 3 (vertical blue).
// UVs already come pre-tiled by the geometry builders, so repeat = 1.
export function buildMaterialArray() {
    const floor = floorTex.clone(); floor.needsUpdate = true;
    const blue = blueTex.clone(); blue.needsUpdate = true;
    return [
        new THREE.MeshLambertMaterial({ map: floor, side: THREE.DoubleSide }),
        new THREE.MeshLambertMaterial({ map: blue, side: THREE.DoubleSide }),
    ];
}

// Zone → material index in the array returned by buildMaterialArray().
export const ZONE_FLOOR = 0;
export const ZONE_SIDE = 1;
