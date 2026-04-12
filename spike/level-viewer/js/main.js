// Level Viewer spike - main entry point

import * as THREE from 'three';
import { createScene } from './scene-setup.js';
import { initCamera } from './camera.js';
import { parseOBJ, parseMTL } from './obj-parser.js';
import { initUI } from './ui.js';

// --- Setup ---
const { scene, renderer } = createScene();
const canvas = renderer.domElement;
const { camera, update: updateCamera } = initCamera(canvas);
const textureLoader = new THREE.TextureLoader();

// --- Display modes ---
// 0: Textured + lit + vertex colors (full)
// 1: Flat shaded (no texture, no vcolors)
// 2: Vertex colors only (unlit)
// 3: Lit + vertex colors (no texture)
// 4: Wireframe
const MODE_COUNT = 5;
let currentMode = 0;
let currentMesh = null;
let texturedMaterials = null;  // array of per-material-group Three.js materials

// Simple materials for non-textured modes
const flatMat = new THREE.MeshLambertMaterial({ color: 0xcccccc, flatShading: true, side: THREE.DoubleSide });
const vcolorMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
const litVcolorMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
const wireMat = new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true });

function applyMode() {
    if (!currentMesh) return;
    switch (currentMode) {
        case 0: // Textured + lit + vertex colors
            currentMesh.material = texturedMaterials || flatMat;
            break;
        case 1: // Flat shaded
            currentMesh.material = flatMat;
            break;
        case 2: // Vertex colors only
            currentMesh.material = vcolorMat;
            break;
        case 3: // Lit + vertex colors
            currentMesh.material = litVcolorMat;
            break;
        case 4: // Wireframe
            currentMesh.material = wireMat;
            break;
    }
}

// --- Texture loading ---

// Load a BMP as a standard opaque texture
function loadTexture(baseUrl, filename, clampS, clampT) {
    const tex = textureLoader.load(baseUrl + filename);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = clampS ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    tex.wrapT = clampT ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return tex;
}

// Load a 32-bit BMP with real alpha channel via ArrayBuffer decoding.
// Three.js TextureLoader strips alpha from BMPs, so we decode manually.
async function loadTransparentBMP(url, clampS, clampT) {
    const resp = await fetch(url);
    const buf = await resp.arrayBuffer();
    const view = new DataView(buf);

    const pixelOffset = view.getUint32(10, true);
    const width = view.getInt32(18, true);
    const rawHeight = view.getInt32(22, true);
    const height = Math.abs(rawHeight);
    const bpp = view.getUint16(28, true);
    const topDown = rawHeight < 0;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(width, height);
    const data = imageData.data;

    if (bpp === 32) {
        // BGRA pixel data
        for (let y = 0; y < height; y++) {
            const srcRow = topDown ? y : (height - 1 - y);
            for (let x = 0; x < width; x++) {
                const srcIdx = pixelOffset + (srcRow * width + x) * 4;
                const dstIdx = (y * width + x) * 4;
                data[dstIdx]     = view.getUint8(srcIdx + 2); // R
                data[dstIdx + 1] = view.getUint8(srcIdx + 1); // G
                data[dstIdx + 2] = view.getUint8(srcIdx);     // B
                data[dstIdx + 3] = view.getUint8(srcIdx + 3); // A
            }
        }
    } else {
        // Fallback for 24-bit: treat near-black as transparent
        const rowBytes = Math.ceil(width * 3 / 4) * 4; // rows are 4-byte aligned
        for (let y = 0; y < height; y++) {
            const srcRow = topDown ? y : (height - 1 - y);
            for (let x = 0; x < width; x++) {
                const srcIdx = pixelOffset + srcRow * rowBytes + x * 3;
                const dstIdx = (y * width + x) * 4;
                const b = view.getUint8(srcIdx);
                const g = view.getUint8(srcIdx + 1);
                const r = view.getUint8(srcIdx + 2);
                data[dstIdx]     = r;
                data[dstIdx + 1] = g;
                data[dstIdx + 2] = b;
                data[dstIdx + 3] = (r < 10 && g < 10 && b < 10) ? 0 : 255;
            }
        }
    }

    ctx.putImageData(imageData, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = clampS ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    tex.wrapT = clampT ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return tex;
}

async function buildTexturedMaterials(mtlData, materialGroups, baseUrl) {
    const texCache = new Map();        // opaque texture cache
    const transTexCache = new Map();   // transparent texture cache (promises)
    const mats = [];
    const transLoads = [];  // { index, promise }

    for (let i = 0; i < materialGroups.length; i++) {
        const group = materialGroups[i];
        const mtl = mtlData.get(group.name);
        const isTransparent = group.secondary || (mtl && mtl.transparent);

        if (mtl && mtl.texture) {
            const cacheKey = mtl.texture + (mtl.clampS ? '_cS' : '') + (mtl.clampT ? '_cT' : '');

            if (isTransparent) {
                // Transparent: need async BMP decode for alpha
                if (!transTexCache.has(cacheKey)) {
                    transTexCache.set(cacheKey, loadTransparentBMP(
                        baseUrl + mtl.texture, mtl.clampS, mtl.clampT
                    ));
                }
                // Placeholder material - texture assigned after load
                const mat = new THREE.MeshLambertMaterial({
                    vertexColors: true,
                    flatShading: true,
                    side: THREE.DoubleSide,
                    transparent: true,
                    alphaTest: 0.5,
                    depthWrite: false,
                });
                mats.push(mat);
                transLoads.push({ index: i, promise: transTexCache.get(cacheKey) });
            } else {
                // Opaque: synchronous TextureLoader is fine
                if (!texCache.has(cacheKey)) {
                    texCache.set(cacheKey, loadTexture(baseUrl, mtl.texture, mtl.clampS, mtl.clampT));
                }
                mats.push(new THREE.MeshLambertMaterial({
                    map: texCache.get(cacheKey),
                    vertexColors: true,
                    flatShading: true,
                    side: THREE.DoubleSide,
                }));
            }
        } else {
            // UNTEXTURED or unknown material
            mats.push(new THREE.MeshLambertMaterial({
                vertexColors: true,
                flatShading: true,
                side: THREE.DoubleSide,
            }));
        }
    }

    // Resolve all transparent texture loads and assign to materials
    if (transLoads.length > 0) {
        const results = await Promise.all(transLoads.map(t => t.promise));
        for (let i = 0; i < transLoads.length; i++) {
            mats[transLoads[i].index].map = results[i];
            mats[transLoads[i].index].needsUpdate = true;
        }
    }

    return mats;
}

// --- Level loading ---
async function loadLevel(folderName) {
    ui.showLoading(true);

    // Clean up previous
    if (currentMesh) {
        scene.remove(currentMesh);
        currentMesh.geometry.dispose();
        if (Array.isArray(texturedMaterials)) {
            for (const m of texturedMaterials) {
                if (m.map) m.map.dispose();
                m.dispose();
            }
        }
        currentMesh = null;
        texturedMaterials = null;
    }

    try {
        const baseUrl = `../../public/existing goldeneye levels/${folderName}/`;

        // Fetch OBJ and MTL in parallel
        const [objResp, mtlResp] = await Promise.all([
            fetch(baseUrl + 'LevelIndices.obj'),
            fetch(baseUrl + 'LevelIndices.mtl')
        ]);

        if (!objResp.ok) throw new Error(`OBJ load failed: ${objResp.status}`);

        const objText = await objResp.text();
        const mtlText = mtlResp.ok ? await mtlResp.text() : '';

        const mtlData = parseMTL(mtlText);
        const { geometry, materialGroups } = parseOBJ(objText);

        // Assign material indices to geometry groups
        for (let i = 0; i < materialGroups.length; i++) {
            geometry.groups[i].materialIndex = i;
        }

        // Build per-group textured materials (async for transparent BMP decoding)
        texturedMaterials = await buildTexturedMaterials(mtlData, materialGroups, baseUrl);

        currentMesh = new THREE.Mesh(geometry, texturedMaterials);
        scene.add(currentMesh);
        applyMode();

        // Position camera at bounding box center
        const center = new THREE.Vector3();
        geometry.boundingBox.getCenter(center);
        camera.position.copy(center);
    } catch (err) {
        console.error('Failed to load level:', err);
    }

    ui.showLoading(false);
}

function setMode(index) {
    currentMode = index;
    applyMode();
}

// --- UI ---
const ui = initUI({
    onLevelChange: loadLevel,
    onToggleMode: setMode
});

// Keyboard shortcut for mode cycling
document.addEventListener('keydown', (e) => {
    if (e.code === 'KeyC') ui.cycleMode();
});

// --- Animation loop ---
const clock = new THREE.Clock();

function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();
    updateCamera(dt);
    renderer.render(scene, camera);
}

// --- Start ---
animate();
loadLevel(ui.getSelectedLevel());
