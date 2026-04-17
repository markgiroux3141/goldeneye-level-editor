// main.js — Three.js viewer with toggle controls for shadow lighting spike.
// Baking is performed in Rust via lighting-wasm.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { buildTestScene, defaultLights } from './geometry.js';
import { loadGLBScene } from './glbSceneLoader.js';
import initWasm, { LightingBaker } from '../lighting-wasm/pkg/lighting_wasm.js';

// --- WASM init ---
await initWasm();

// --- Scene setup ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111111);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 500);
camera.position.set(8, 18, 28);
camera.lookAt(2, 2, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(2, 2, 0);
controls.update();

// --- Transform gizmo for dragging lights ---
const transformControls = new TransformControls(camera, renderer.domElement);
transformControls.setMode('translate');
transformControls.setSize(0.75);
scene.add(transformControls.getHelper ? transformControls.getHelper() : transformControls);
let selectedLightIndex = -1;
let suppressClick = false;

transformControls.addEventListener('dragging-changed', (e) => {
    controls.enabled = !e.value;
    if (!e.value && selectedLightIndex !== -1) {
        // Drag ended — commit position, rebake.
        const entry = lightHelperByIndex.get(selectedLightIndex);
        const light = sceneData.lights[selectedLightIndex];
        if (entry && light) {
            light.x = entry.sphere.position.x;
            light.y = entry.sphere.position.y;
            light.z = entry.sphere.position.z;
            entry.rangeSphere.position.copy(entry.sphere.position);
            rebuildScene(currentMode);
        }
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 0);
    }
});
// Keep the range-sphere halo following the handle while dragging.
transformControls.addEventListener('objectChange', () => {
    if (selectedLightIndex === -1) return;
    const entry = lightHelperByIndex.get(selectedLightIndex);
    if (entry) entry.rangeSphere.position.copy(entry.sphere.position);
});

// --- Shared vertex-color materials ---
const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
const wireMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.DoubleSide, wireframe: true,
});

// Composite materials (texture × baked vertex color), keyed by source material UUID.
const texturedBakeMaterialCache = new Map();
function getTexturedBakeMaterial(origMat) {
    if (!origMat || !origMat.map) return material;
    let m = texturedBakeMaterialCache.get(origMat.uuid);
    if (!m) {
        m = new THREE.MeshBasicMaterial({
            vertexColors: true,
            side: THREE.DoubleSide,
            map: origMat.map,
        });
        texturedBakeMaterialCache.set(origMat.uuid, m);
    }
    return m;
}

// --- State ---
let sceneData = null;         // { meshes:[{positions, normals, indices, originalMaterial?, aabb}], lights, cameraTarget, cameraPos }
let sceneMeshes = [];
let lightHelpers = [];
let currentMode = 'none';
let currentSource = 'test';
let showWireframe = false;
let showTextures = false;
let isLoading = false;

// --- Extract flat arrays from a THREE.BufferGeometry (triangulated) ---
function extractMeshArrays(geometry) {
    const pos = geometry.getAttribute('position');
    let nor = geometry.getAttribute('normal');
    if (!nor) { geometry.computeVertexNormals(); nor = geometry.getAttribute('normal'); }
    const uvAttr = geometry.getAttribute('uv');
    const idxAttr = geometry.getIndex();

    const positions = new Float32Array(pos.array);
    const normals = new Float32Array(nor.array);
    const uvs = uvAttr ? new Float32Array(uvAttr.array) : null;
    let indices;
    if (idxAttr) {
        indices = idxAttr.array instanceof Uint32Array ? idxAttr.array : new Uint32Array(idxAttr.array);
    } else {
        const count = pos.count;
        indices = new Uint32Array(count);
        for (let i = 0; i < count; i++) indices[i] = i;
    }
    return { positions, normals, uvs, indices };
}

function aabbFromPositions(positions) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i], y = positions[i+1], z = positions[i+2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return { minX, minY, minZ, maxX, maxY, maxZ };
}

// --- Scene source loading ---
function loadTestScene() {
    const data = buildTestScene();
    const lights = defaultLights();
    const meshes = [];

    const roomArrays = extractMeshArrays(data.room.geometry);
    meshes.push({ ...roomArrays, aabb: aabbFromPositions(roomArrays.positions) });

    for (const p of data.platforms) {
        const a = extractMeshArrays(p.geometry);
        meshes.push({ ...a, aabb: p.aabb });
    }

    return {
        meshes,
        lights,
        cameraTarget: new THREE.Vector3(2, 2, 0),
        cameraPos: new THREE.Vector3(8, 18, 28),
    };
}

async function loadGLBSceneAdapted() {
    const raw = await loadGLBScene();
    const meshes = raw.meshes.map(entry => {
        const a = extractMeshArrays(entry.geometry);
        return {
            ...a,
            aabb: entry.aabb,
            originalMaterial: entry.originalMaterial,
            originalGeometry: entry.geometry,
        };
    });
    return {
        meshes,
        lights: raw.lights,
        cameraTarget: raw.cameraTarget,
        cameraPos: raw.cameraPos,
    };
}

async function loadSceneSource(kind) {
    if (kind === 'glb') return await loadGLBSceneAdapted();
    return loadTestScene();
}

// --- Light helpers ---
// Keyed by light index so we can re-attach the transform gizmo across rebuilds.
const lightHelperByIndex = new Map();

function buildLightHelpers() {
    for (const h of lightHelpers) scene.remove(h);
    lightHelpers = [];
    lightHelperByIndex.clear();

    sceneData.lights.forEach((light, idx) => {
        if (!light.enabled) return;
        const geo = new THREE.SphereGeometry(0.3, 8, 8);
        const mat = new THREE.MeshBasicMaterial({
            color: new THREE.Color(light.color.r, light.color.g, light.color.b),
        });
        const sphere = new THREE.Mesh(geo, mat);
        sphere.position.set(light.x, light.y, light.z);
        sphere.userData.lightIndex = idx;
        sphere.userData.isLightHandle = true;
        scene.add(sphere);
        lightHelpers.push(sphere);

        const rangeGeo = new THREE.SphereGeometry(light.range, 16, 12);
        const rangeMat = new THREE.MeshBasicMaterial({
            color: new THREE.Color(light.color.r, light.color.g, light.color.b),
            wireframe: true, transparent: true, opacity: 0.08,
        });
        const rs = new THREE.Mesh(rangeGeo, rangeMat);
        rs.position.copy(sphere.position);
        scene.add(rs);
        lightHelpers.push(rs);

        lightHelperByIndex.set(idx, { sphere, rangeSphere: rs });
    });

    // Re-attach transform gizmo if a light is still selected and visible.
    if (selectedLightIndex !== -1) {
        const entry = lightHelperByIndex.get(selectedLightIndex);
        if (entry) transformControls.attach(entry.sphere);
        else { transformControls.detach(); selectedLightIndex = -1; }
    }
}

// --- Build BufferGeometry from a BakedMesh result. If sourceUvs are provided and
// the baked vertex count matches the source, they're attached unchanged (valid
// only when the bake didn't alter topology — i.e. bake_none). ---
function bakedToGeometry(baked, sourceUvs) {
    const positions = baked.positions();
    const normals = baked.normals();
    const colors = baked.colors();
    const indices = baked.indices();
    baked.free();

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    if (sourceUvs && sourceUvs.length * 3 === positions.length * 2) {
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(sourceUvs, 2));
    }
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    return geo;
}

// --- Serialize lights to JSON for WASM ---
function lightsToJson(lights) {
    return JSON.stringify(lights.map(l => ({
        x: l.x, y: l.y, z: l.z,
        color: [l.color.r, l.color.g, l.color.b],
        intensity: l.intensity,
        range: l.range,
        enabled: !!l.enabled,
    })));
}

function rebuildScene(mode) {
    clearSceneMeshes();
    const t0 = performance.now();

    const baker = new LightingBaker(lightsToJson(sceneData.lights));
    for (const m of sceneData.meshes) {
        baker.add_occluder(m.positions, m.indices);
    }
    baker.build();

    let totalTris = 0;
    for (let i = 0; i < sceneData.meshes.length; i++) {
        const m = sceneData.meshes[i];
        const hasTexture = !!(m.originalMaterial && m.originalMaterial.map);

        // Textures mode requires UVs on the baked geometry; only bake_none preserves
        // them. Force 'none' when textures are on for textured meshes.
        const effectiveMode = (showTextures && hasTexture) ? 'none' : mode;

        let baked;
        switch (effectiveMode) {
            case 'none':
                baked = baker.bake_none(m.positions, m.normals, m.indices);
                break;
            case 'uniform':
                baked = baker.bake_uniform(m.positions, m.normals, m.indices, 2);
                break;
            case 'adaptive':
                baked = baker.bake_adaptive(m.positions, m.normals, m.indices);
                break;
            case 'stencil': {
                const otherAabbs = sceneData.meshes
                    .filter((_, j) => j !== i)
                    .map(o => o.aabb);
                baked = baker.bake_stencil(m.positions, m.normals, m.indices, JSON.stringify(otherAabbs), 0.3);
                break;
            }
        }

        // Only attach UVs for bake_none where topology matches the source.
        const sourceUvs = effectiveMode === 'none' ? m.uvs : null;
        const geo = bakedToGeometry(baked, sourceUvs);

        let mat;
        if (showWireframe) mat = wireMaterial;
        else if (showTextures && hasTexture) mat = getTexturedBakeMaterial(m.originalMaterial);
        else mat = material;

        const mesh = new THREE.Mesh(geo, mat);
        mesh.userData.bakedGeometry = true;
        scene.add(mesh);
        sceneMeshes.push(mesh);
        totalTris += geo.getIndex().count / 3;
    }

    baker.free();

    const elapsed = (performance.now() - t0).toFixed(1);
    document.getElementById('tri-count').textContent = totalTris;
    document.getElementById('bake-time').textContent = elapsed;
    currentMode = mode;
}

function clearSceneMeshes() {
    for (const m of sceneMeshes) {
        scene.remove(m);
        // Only dispose geometries we created during bake; leave originalGeometry alone.
        if (m.userData.bakedGeometry) m.geometry.dispose();
    }
    sceneMeshes = [];
}

// --- Scene source switch ---
async function switchSceneSource(kind) {
    if (isLoading || kind === currentSource) return;
    isLoading = true;
    setBakeButtonsEnabled(false);
    document.getElementById('bake-time').textContent = 'loading…';

    try {
        sceneData = await loadSceneSource(kind);
        currentSource = kind;

        camera.position.copy(sceneData.cameraPos);
        controls.target.copy(sceneData.cameraTarget);
        controls.update();

        buildLightHelpers();
        rebuildScene(currentMode);
    } catch (err) {
        console.error('Failed to load scene:', err);
        document.getElementById('bake-time').textContent = 'error';
    } finally {
        isLoading = false;
        setBakeButtonsEnabled(true);
    }
}

// --- UI ---
function setActiveButton(groupSelector, id) {
    document.querySelectorAll(groupSelector + ' button').forEach(b => b.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

function setBakeButtonsEnabled(enabled) {
    ['btn-none', 'btn-uniform', 'btn-adaptive', 'btn-stencil'].forEach(id => {
        document.getElementById(id).disabled = !enabled;
    });
}

document.getElementById('btn-none').addEventListener('click', () => {
    setActiveButton('#row-bake', 'btn-none');
    rebuildScene('none');
});
document.getElementById('btn-uniform').addEventListener('click', () => {
    setActiveButton('#row-bake', 'btn-uniform');
    rebuildScene('uniform');
});
document.getElementById('btn-adaptive').addEventListener('click', () => {
    setActiveButton('#row-bake', 'btn-adaptive');
    rebuildScene('adaptive');
});
document.getElementById('btn-stencil').addEventListener('click', () => {
    setActiveButton('#row-bake', 'btn-stencil');
    rebuildScene('stencil');
});

document.getElementById('btn-source-test').addEventListener('click', () => {
    setActiveButton('#row-source', 'btn-source-test');
    switchSceneSource('test');
});
document.getElementById('btn-source-glb').addEventListener('click', () => {
    setActiveButton('#row-source', 'btn-source-glb');
    switchSceneSource('glb');
});

document.getElementById('btn-wireframe').addEventListener('click', (e) => {
    showWireframe = !showWireframe;
    e.target.classList.toggle('active', showWireframe);
    rebuildScene(currentMode);
});

document.getElementById('btn-textures').addEventListener('click', (e) => {
    showTextures = !showTextures;
    e.target.classList.toggle('active', showTextures);
    rebuildScene(currentMode);
});

document.getElementById('btn-light1').addEventListener('click', (e) => {
    const l = sceneData.lights[0]; if (!l) return;
    l.enabled = !l.enabled;
    e.target.classList.toggle('active', !l.enabled);
    e.target.textContent = l.enabled ? 'Light 1' : 'Light 1 (off)';
    buildLightHelpers();
    rebuildScene(currentMode);
});
document.getElementById('btn-light2').addEventListener('click', (e) => {
    const l = sceneData.lights[1]; if (!l) return;
    l.enabled = !l.enabled;
    e.target.classList.toggle('active', !l.enabled);
    e.target.textContent = l.enabled ? 'Light 2' : 'Light 2 (off)';
    buildLightHelpers();
    rebuildScene(currentMode);
});

// --- Click-to-select a light handle ---
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
renderer.domElement.addEventListener('pointerdown', (e) => {
    if (suppressClick || e.button !== 0) return;
    // Ignore clicks that started on the gizmo itself.
    if (transformControls.dragging) return;

    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    const handles = [];
    for (const entry of lightHelperByIndex.values()) handles.push(entry.sphere);
    const hits = raycaster.intersectObjects(handles, false);
    if (hits.length > 0) {
        const sphere = hits[0].object;
        selectedLightIndex = sphere.userData.lightIndex ?? -1;
        transformControls.attach(sphere);
    } else {
        // Click in empty space — deselect only if not clicking gizmo.
        transformControls.detach();
        selectedLightIndex = -1;
    }
});

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Init ---
sceneData = loadTestScene();
buildLightHelpers();
rebuildScene('none');

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}
animate();
