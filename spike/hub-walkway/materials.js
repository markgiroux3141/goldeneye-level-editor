// Shared texture loader (copy of branching-platforms version).
import * as THREE from 'three';

const TEX_DIR = '../../public/textures/';

let floorTex = null, blueTex = null;

export async function loadTextures() {
    const loader = new THREE.TextureLoader();
    const load = (name) => new Promise((resolve, reject) => {
        loader.load(TEX_DIR + name + '.bmp', (tex) => {
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
            tex.magFilter = THREE.LinearFilter;
            tex.minFilter = THREE.LinearMipmapLinearFilter;
            resolve(tex);
        }, undefined, (err) => reject(new Error('failed to load ' + name + ': ' + err)));
    });
    [floorTex, blueTex] = await Promise.all([load('floor_doorframe'), load('blue_stairs')]);
}

export function buildMaterialArray() {
    const floor = floorTex.clone(); floor.needsUpdate = true;
    const blue = blueTex.clone(); blue.needsUpdate = true;
    return [
        new THREE.MeshLambertMaterial({ map: floor, side: THREE.DoubleSide }),
        new THREE.MeshLambertMaterial({ map: blue, side: THREE.DoubleSide }),
    ];
}
