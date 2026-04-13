// main.js — Three.js viewer with toggle controls for shadow lighting spike.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildTestScene, defaultLights } from './geometry.js';
import { bakeNone, bakeUniform, bakeAdaptive, bakeStencilAdaptive, countTriangles } from './lightBaker.js';

// --- Scene setup ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111111);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(8, 18, 28);
camera.lookAt(2, 2, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(2, 2, 0);
controls.update();

// --- Build scene geometry ---
const sceneData = buildTestScene();
const lights = defaultLights();

// Material: vertex colors, no real-time lighting
// DoubleSide because splitTrisAtAxis can flip triangle winding
const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
const wireMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.DoubleSide, wireframe: true,
});

// The meshes currently in the scene
let roomMesh = null;
let platformMeshes = [];
let lightHelpers = [];
let showWireframe = false;

// Store original (un-modified) geometry sources so each mode gets a fresh copy
const roomGeoSource = sceneData.room.geometry;
const platGeoSources = sceneData.platforms.map(p => p.geometry);

function cloneGeo(geo) {
    const clone = geo.clone();
    // Clone the color attribute so writes don't affect the source
    const col = clone.getAttribute('color');
    clone.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(col.array), 3));
    return clone;
}

// --- Occluder meshes for raycasting ---
// We need Three.js meshes for the raycaster to intersect against.
// Create "invisible" meshes from the platform geometries.
function buildOccluderMeshes() {
    const meshes = [];
    for (const platGeo of platGeoSources) {
        const m = new THREE.Mesh(platGeo, new THREE.MeshBasicMaterial({ visible: false }));
        meshes.push(m);
        scene.add(m);
    }
    return meshes;
}

const occluderMeshes = buildOccluderMeshes();

// --- Light helpers (small spheres at light positions) ---
function buildLightHelpers() {
    for (const h of lightHelpers) scene.remove(h);
    lightHelpers = [];

    for (const light of lights) {
        if (!light.enabled) continue;
        const geo = new THREE.SphereGeometry(0.3, 8, 8);
        const mat = new THREE.MeshBasicMaterial({
            color: new THREE.Color(light.color.r, light.color.g, light.color.b),
        });
        const sphere = new THREE.Mesh(geo, mat);
        sphere.position.set(light.x, light.y, light.z);
        scene.add(sphere);
        lightHelpers.push(sphere);

        // Range wireframe sphere
        const rangeGeo = new THREE.SphereGeometry(light.range, 16, 12);
        const rangeMat = new THREE.MeshBasicMaterial({
            color: new THREE.Color(light.color.r, light.color.g, light.color.b),
            wireframe: true, transparent: true, opacity: 0.08,
        });
        const rangeSphere = new THREE.Mesh(rangeGeo, rangeMat);
        rangeSphere.position.copy(sphere.position);
        scene.add(rangeSphere);
        lightHelpers.push(rangeSphere);
    }
}

// --- Bake modes ---
let currentMode = 'none';

function clearScene() {
    if (roomMesh) { scene.remove(roomMesh); roomMesh = null; }
    for (const m of platformMeshes) scene.remove(m);
    platformMeshes = [];
}

function rebuildScene(mode) {
    clearScene();
    const t0 = performance.now();

    let roomGeo, platGeos;

    switch (mode) {
        case 'none': {
            roomGeo = cloneGeo(roomGeoSource);
            bakeNone(roomGeo, lights, occluderMeshes);
            platGeos = platGeoSources.map(g => {
                const c = cloneGeo(g);
                bakeNone(c, lights, occluderMeshes);
                return c;
            });
            break;
        }
        case 'uniform': {
            roomGeo = bakeUniform(roomGeoSource, lights, occluderMeshes, 2);
            platGeos = platGeoSources.map(g => bakeUniform(g, lights, occluderMeshes, 2));
            break;
        }
        case 'adaptive': {
            roomGeo = bakeAdaptive(cloneGeo(roomGeoSource), lights, occluderMeshes);
            platGeos = platGeoSources.map(g => bakeAdaptive(cloneGeo(g), lights, occluderMeshes));
            break;
        }
        case 'stencil': {
            const aabbs = sceneData.platforms.map(p => p.aabb);
            roomGeo = bakeStencilAdaptive(roomGeoSource, lights, aabbs, occluderMeshes, 0.3);
            // Platforms don't need stenciling against themselves, just adaptive
            platGeos = platGeoSources.map(g => bakeAdaptive(cloneGeo(g), lights, occluderMeshes));
            break;
        }
    }

    const elapsed = (performance.now() - t0).toFixed(1);

    const mat = showWireframe ? wireMaterial : material;
    roomMesh = new THREE.Mesh(roomGeo, mat);
    scene.add(roomMesh);

    let totalTris = countTriangles(roomGeo);
    for (const g of platGeos) {
        const m = new THREE.Mesh(g, mat);
        scene.add(m);
        platformMeshes.push(m);
        totalTris += countTriangles(g);
    }

    document.getElementById('tri-count').textContent = totalTris;
    document.getElementById('bake-time').textContent = elapsed;
    currentMode = mode;
}

// --- UI ---
function setActiveButton(id) {
    document.querySelectorAll('#ui .row:first-child button').forEach(b => b.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

document.getElementById('btn-none').addEventListener('click', () => {
    setActiveButton('btn-none');
    rebuildScene('none');
});
document.getElementById('btn-uniform').addEventListener('click', () => {
    setActiveButton('btn-uniform');
    rebuildScene('uniform');
});
document.getElementById('btn-adaptive').addEventListener('click', () => {
    setActiveButton('btn-adaptive');
    rebuildScene('adaptive');
});
document.getElementById('btn-stencil').addEventListener('click', () => {
    setActiveButton('btn-stencil');
    rebuildScene('stencil');
});

document.getElementById('btn-wireframe').addEventListener('click', (e) => {
    showWireframe = !showWireframe;
    e.target.classList.toggle('active', showWireframe);
    rebuildScene(currentMode);
});

// Light toggles
document.getElementById('btn-light1').addEventListener('click', (e) => {
    lights[0].enabled = !lights[0].enabled;
    e.target.classList.toggle('active', !lights[0].enabled);
    e.target.textContent = lights[0].enabled ? 'Light 1' : 'Light 1 (off)';
    buildLightHelpers();
    rebuildScene(currentMode);
});
document.getElementById('btn-light2').addEventListener('click', (e) => {
    lights[1].enabled = !lights[1].enabled;
    e.target.classList.toggle('active', !lights[1].enabled);
    e.target.textContent = lights[1].enabled ? 'Light 2' : 'Light 2 (off)';
    buildLightHelpers();
    rebuildScene(currentMode);
});

// --- Resize ---
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Init ---
buildLightHelpers();
rebuildScene('none');

// --- Render loop ---
function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}
animate();
