// Level Viewer spike - main entry point

import * as THREE from 'three';
import { createScene } from './scene-setup.js';
import { initCamera } from './camera.js';
import { parseOBJ, parseMTL } from './obj-parser.js';
import { initUI } from './ui.js';
import {
    computeNormalDirectionColors,
    computePredictedLighting,
    computePredictionError,
    computeAOEstimate,
    computeLocalHeightMap,
} from './analysis.js';

// --- Setup ---
const { scene, renderer } = createScene();
const canvas = renderer.domElement;
const { camera, update: updateCamera } = initCamera(canvas);
const textureLoader = new THREE.TextureLoader();

// --- Display modes ---
// 0: Textured          1: Flat Shaded       2: Vertex Colors
// 3: Lit + VColors     4: Wireframe         5: (separator)
// 6: Normal Direction  7: Predicted         8: Predicted + Textured
// 9: Error Map        10: AO Estimate
let currentMode = 0;
let currentMesh = null;
let texturedMaterials = null;

// Cached analysis data
let actualColors = null;
let aoColors = null;
let heightMap = null;   // cached local floor/ceiling per vertex
let analysisParams = { ambient: 0.3, intensity: 0.7, heightFalloff: 0.5 };

// Simple materials for non-textured modes
const flatMat = new THREE.MeshLambertMaterial({ color: 0xcccccc, flatShading: true, side: THREE.DoubleSide });
const vcolorMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
const litVcolorMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
const wireMat = new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true });
const analysisMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });

function applyMode() {
    if (!currentMesh) return;
    const geom = currentMesh.geometry;
    ui.showStats(null);

    switch (currentMode) {
        case 0: // Textured
            restoreActualColors(geom);
            currentMesh.material = texturedMaterials || flatMat;
            break;
        case 1: // Flat shaded
            restoreActualColors(geom);
            currentMesh.material = flatMat;
            break;
        case 2: // Vertex colors only
            restoreActualColors(geom);
            currentMesh.material = vcolorMat;
            break;
        case 3: // Lit + vertex colors
            restoreActualColors(geom);
            currentMesh.material = litVcolorMat;
            break;
        case 4: // Wireframe
            currentMesh.material = wireMat;
            break;
        case 6: // Normal direction
            applyAnalysisColors(computeNormalDirectionColors(geom));
            currentMesh.material = analysisMat;
            break;
        case 7: // Predicted lighting (no textures)
            applyAnalysisColors(computePredictedLighting(geom, { ...analysisParams, heightMap }));
            currentMesh.material = analysisMat;
            break;
        case 8: // Predicted + Textured
            applyAnalysisColors(computePredictedLighting(geom, { ...analysisParams, heightMap }));
            currentMesh.material = texturedMaterials || flatMat;
            break;
        case 9: // Error map
            applyErrorMap();
            currentMesh.material = analysisMat;
            break;
        case 10: // AO estimate
            if (aoColors) {
                applyAnalysisColors(aoColors);
            } else {
                // Gray placeholder until AO is computed
                applyAnalysisColors(computePredictedLighting(geom, { ambient: 0.5, intensity: 0 }));
            }
            currentMesh.material = analysisMat;
            break;
    }
}

function restoreActualColors(geom) {
    if (!actualColors) return;
    const colorAttr = geom.getAttribute('color');
    colorAttr.array.set(actualColors);
    colorAttr.needsUpdate = true;
}

function applyAnalysisColors(colors) {
    const colorAttr = currentMesh.geometry.getAttribute('color');
    colorAttr.array.set(colors);
    colorAttr.needsUpdate = true;
}

function applyErrorMap() {
    if (!actualColors) return;
    const predicted = computePredictedLighting(currentMesh.geometry, { ...analysisParams, heightMap });
    const { colors, stats } = computePredictionError(predicted, actualColors);
    applyAnalysisColors(colors);
    ui.showStats(stats);
}

// --- Texture loading ---

function loadTexture(baseUrl, filename, clampS, clampT) {
    const tex = textureLoader.load(baseUrl + filename);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = clampS ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    tex.wrapT = clampT ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return tex;
}

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

    const cvs = document.createElement('canvas');
    cvs.width = width;
    cvs.height = height;
    const ctx = cvs.getContext('2d');
    const imageData = ctx.createImageData(width, height);
    const data = imageData.data;

    if (bpp === 32) {
        for (let y = 0; y < height; y++) {
            const srcRow = topDown ? y : (height - 1 - y);
            for (let x = 0; x < width; x++) {
                const srcIdx = pixelOffset + (srcRow * width + x) * 4;
                const dstIdx = (y * width + x) * 4;
                data[dstIdx]     = view.getUint8(srcIdx + 2);
                data[dstIdx + 1] = view.getUint8(srcIdx + 1);
                data[dstIdx + 2] = view.getUint8(srcIdx);
                data[dstIdx + 3] = view.getUint8(srcIdx + 3);
            }
        }
    } else {
        const rowBytes = Math.ceil(width * 3 / 4) * 4;
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
    const tex = new THREE.CanvasTexture(cvs);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = clampS ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    tex.wrapT = clampT ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return tex;
}

async function buildTexturedMaterials(mtlData, materialGroups, baseUrl) {
    const texCache = new Map();
    const transTexCache = new Map();
    const mats = [];
    const transLoads = [];

    for (let i = 0; i < materialGroups.length; i++) {
        const group = materialGroups[i];
        const mtl = mtlData.get(group.name);
        const isTransparent = group.secondary || (mtl && mtl.transparent);

        if (mtl && mtl.texture) {
            const cacheKey = mtl.texture + (mtl.clampS ? '_cS' : '') + (mtl.clampT ? '_cT' : '');

            if (isTransparent) {
                if (!transTexCache.has(cacheKey)) {
                    transTexCache.set(cacheKey, loadTransparentBMP(
                        baseUrl + mtl.texture, mtl.clampS, mtl.clampT
                    ));
                }
                const mat = new THREE.MeshLambertMaterial({
                    vertexColors: true, flatShading: true, side: THREE.DoubleSide,
                    transparent: true, alphaTest: 0.5, depthWrite: false,
                });
                mats.push(mat);
                transLoads.push({ index: i, promise: transTexCache.get(cacheKey) });
            } else {
                if (!texCache.has(cacheKey)) {
                    texCache.set(cacheKey, loadTexture(baseUrl, mtl.texture, mtl.clampS, mtl.clampT));
                }
                mats.push(new THREE.MeshLambertMaterial({
                    map: texCache.get(cacheKey), vertexColors: true,
                    flatShading: true, side: THREE.DoubleSide,
                }));
            }
        } else {
            mats.push(new THREE.MeshLambertMaterial({
                vertexColors: true, flatShading: true, side: THREE.DoubleSide,
            }));
        }
    }

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
        actualColors = null;
        aoColors = null;
        heightMap = null;
    }

    try {
        const baseUrl = `../../public/existing goldeneye levels/${folderName}/`;

        const [objResp, mtlResp] = await Promise.all([
            fetch(baseUrl + 'LevelIndices.obj'),
            fetch(baseUrl + 'LevelIndices.mtl')
        ]);

        if (!objResp.ok) throw new Error(`OBJ load failed: ${objResp.status}`);

        const objText = await objResp.text();
        const mtlText = mtlResp.ok ? await mtlResp.text() : '';

        const mtlData = parseMTL(mtlText);
        const { geometry, materialGroups } = parseOBJ(objText);

        for (let i = 0; i < materialGroups.length; i++) {
            geometry.groups[i].materialIndex = i;
        }

        texturedMaterials = await buildTexturedMaterials(mtlData, materialGroups, baseUrl);

        const colorAttr = geometry.getAttribute('color');
        actualColors = new Float32Array(colorAttr.array);

        currentMesh = new THREE.Mesh(geometry, texturedMaterials);
        scene.add(currentMesh);
        applyMode();

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

function onParamsChange(params) {
    analysisParams.ambient = params.ambient;
    analysisParams.intensity = params.intensity;
    analysisParams.heightFalloff = params.heightFalloff;
    if (currentMode === 7 || currentMode === 8 || currentMode === 9) {
        applyMode();
    }
}

async function onComputeAO(params) {
    if (!currentMesh) return;
    ui.showLoading(true);
    ui.setLoadingText('Computing AO...');
    aoColors = null;

    try {
        aoColors = await computeAOEstimate(currentMesh.geometry, currentMesh, {
            samples: params.aoSamples,
            radius: params.aoRadius,
            onProgress(frac) {
                ui.setLoadingText(`Computing AO... ${(frac * 100).toFixed(0)}%`);
            }
        });

        if (currentMode === 10) applyMode();
    } catch (err) {
        console.error('AO computation failed:', err);
    }

    ui.setLoadingText('Loading...');
    ui.showLoading(false);
}

async function onComputeHeights() {
    if (!currentMesh) return;
    ui.showLoading(true);
    ui.setLoadingText('Computing local heights...');
    heightMap = null;

    try {
        heightMap = await computeLocalHeightMap(currentMesh.geometry, currentMesh, {
            onProgress(frac) {
                ui.setLoadingText(`Computing heights... ${(frac * 100).toFixed(0)}%`);
            }
        });

        // Re-apply if in a mode that uses height
        if (currentMode === 7 || currentMode === 8 || currentMode === 9) {
            applyMode();
        }
    } catch (err) {
        console.error('Height map computation failed:', err);
    }

    ui.setLoadingText('Loading...');
    ui.showLoading(false);
}

// --- UI ---
const ui = initUI({
    onLevelChange: loadLevel,
    onToggleMode: setMode,
    onParamsChange,
    onComputeAO,
    onComputeHeights,
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
