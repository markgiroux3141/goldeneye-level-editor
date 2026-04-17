// Cave Painting Spike — entry point.
// Density field + marching cubes + spherical FBM brush + first-person walk mode.

import * as THREE from 'three';
import { DensityField } from './densityField.js';
import { meshBlock } from './marchingCubes.js';
import { applyBrush } from './brush.js';
import {
    initInput, onScroll, updateCamera,
    isPointerLocked, isShiftHeld, isLeftMouseDown,
    isKeyDown,
} from './fpsCamera.js';

// ---------- Scene setup ----------

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a10);
scene.fog = new THREE.Fog(0x0a0a10, 15, 45);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.set(18, 8, 18);
camera.lookAt(6.4, 6.4, 6.4);

// Hemisphere fill so cave interiors aren't pitch black.
scene.add(new THREE.HemisphereLight(0xa0b0ff, 0x3a2a20, 0.45));

// Warm directional "sun".
const sun = new THREE.DirectionalLight(0xfff1d6, 0.9);
sun.position.set(10, 20, 5);
scene.add(sun);

// Camera-attached "miner's headlamp" — point light for cave interiors.
const headlamp = new THREE.PointLight(0xffe8b0, 1.2, 18, 2);
camera.add(headlamp);
scene.add(camera);

// Reference ground plane below the volume.
const groundGeo = new THREE.PlaneGeometry(200, 200);
const groundMat = new THREE.MeshStandardMaterial({ color: 0x151820, roughness: 1 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.5;
scene.add(ground);

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

// ---------- Density field + block manager ----------

// 64³ cells → 4³ = 64 blocks of 16³ cells each. 0.2 m voxels → 12.8 m cube.
// Placed so (0,0,0) world sits at the min corner of the volume.
const field = new DensityField({
    resolution: 64,
    voxelSize: 0.2,
    blockSize: 16,
    origin: [0, 0, 0],
});

const rockMaterial = new THREE.MeshStandardMaterial({
    color: 0x807668,
    roughness: 0.95,
    metalness: 0.0,
    side: THREE.DoubleSide, // avoids any winding-order worries; lighting uses gradient normals
    flatShading: false,
});

const blocksGroup = new THREE.Group();
blocksGroup.name = 'CaveBlocks';
scene.add(blocksGroup);

// blockMeshes[bi][bj][bk] → Mesh | null
const blockMeshes = [];
for (let bi = 0; bi < field.blocksPerAxis; bi++) {
    blockMeshes.push([]);
    for (let bj = 0; bj < field.blocksPerAxis; bj++) {
        blockMeshes[bi].push(new Array(field.blocksPerAxis).fill(null));
    }
}

function regenerateBlock(bi, bj, bk) {
    const data = meshBlock(field, bi, bj, bk);
    const existing = blockMeshes[bi][bj][bk];

    if (!data) {
        if (existing) {
            blocksGroup.remove(existing);
            existing.geometry.dispose();
            blockMeshes[bi][bj][bk] = null;
        }
        return;
    }

    let mesh = existing;
    if (!mesh) {
        const geom = new THREE.BufferGeometry();
        mesh = new THREE.Mesh(geom, rockMaterial);
        mesh.name = `block_${bi}_${bj}_${bk}`;
        mesh.userData.blockIJK = [bi, bj, bk];
        blocksGroup.add(mesh);
        blockMeshes[bi][bj][bk] = mesh;
    }

    const g = mesh.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    g.computeBoundingSphere();
    g.computeBoundingBox();
}

// ---------- Brush preview ----------

const brushPreviewGeom = new THREE.SphereGeometry(1, 24, 16);
const brushPreviewMatSubtract = new THREE.MeshBasicMaterial({
    color: 0xff4444, wireframe: true, transparent: true, opacity: 0.6,
});
const brushPreviewMatAdd = new THREE.MeshBasicMaterial({
    color: 0x44ff66, wireframe: true, transparent: true, opacity: 0.6,
});
const brushPreview = new THREE.Mesh(brushPreviewGeom, brushPreviewMatSubtract);
brushPreview.visible = false;
scene.add(brushPreview);

// ---------- Brush state ----------

const brushState = {
    radius: 1.2,
    strength: 0.8,
    minRadius: 0.3,
    maxRadius: 3.0,
};

onScroll((deltaY) => {
    const step = deltaY > 0 ? -0.15 : 0.15;
    brushState.radius = Math.max(brushState.minRadius, Math.min(brushState.maxRadius, brushState.radius + step));
});

// ---------- Initialization ----------

const hudRadius = document.getElementById('hud-radius');
const hudMode = document.getElementById('hud-mode');
const hudRemesh = document.getElementById('hud-remesh');
const loadingOverlay = document.getElementById('loading');

function initAndMeshAll() {
    const t0 = performance.now();
    field.initLumpyRock();
    const t1 = performance.now();
    console.log(`[cave] Density init: ${(t1 - t0).toFixed(1)} ms`);

    const t2 = performance.now();
    let meshed = 0;
    field.flushDirty((bi, bj, bk) => {
        regenerateBlock(bi, bj, bk);
        meshed++;
    });
    const t3 = performance.now();
    console.log(`[cave] Initial mesh: ${meshed} blocks in ${(t3 - t2).toFixed(1)} ms`);
}

// Async so the "Generating…" overlay can render first.
setTimeout(() => {
    initAndMeshAll();
    loadingOverlay.style.display = 'none';
    initInput(canvas);
    requestAnimationFrame(loop);
}, 50);

// ---------- Raycaster + brush targeting ----------

const raycaster = new THREE.Raycaster();
const screenCenter = new THREE.Vector2(0, 0);
const brushTarget = new THREE.Vector3();

function pickBrushTarget() {
    camera.updateMatrixWorld();
    raycaster.setFromCamera(screenCenter, camera);
    const hits = raycaster.intersectObjects(blocksGroup.children, false);
    if (hits.length > 0) {
        brushTarget.copy(hits[0].point);
        return true;
    }
    // Fallback: 3 m in front of camera.
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    brushTarget.copy(camera.position).addScaledVector(fwd, 3);
    return false;
}

// ---------- Radius keybinds (+/-) ----------

document.addEventListener('keydown', (e) => {
    if (e.code === 'Equal' || e.code === 'NumpadAdd') {
        brushState.radius = Math.min(brushState.maxRadius, brushState.radius + 0.15);
    } else if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
        brushState.radius = Math.max(brushState.minRadius, brushState.radius - 0.15);
    }
});

// ---------- Main loop ----------

let lastT = performance.now();

function loop() {
    requestAnimationFrame(loop);

    const now = performance.now();
    let dt = (now - lastT) / 1000;
    if (dt > 0.1) dt = 0.1;
    lastT = now;

    updateCamera(camera, dt);

    // Brush preview — where the brush would hit.
    pickBrushTarget();
    const mode = isShiftHeld() ? 'add' : 'subtract';
    brushPreview.visible = isPointerLocked();
    brushPreview.position.copy(brushTarget);
    brushPreview.scale.setScalar(brushState.radius);
    brushPreview.material = (mode === 'add') ? brushPreviewMatAdd : brushPreviewMatSubtract;

    // Paint while mouse held.
    let remeshCount = 0;
    let remeshMs = 0;
    if (isPointerLocked() && isLeftMouseDown()) {
        const changed = applyBrush(field, brushTarget, brushState.radius, brushState.strength, mode, dt);
        if (changed) {
            const t0 = performance.now();
            field.flushDirty((bi, bj, bk) => {
                regenerateBlock(bi, bj, bk);
                remeshCount++;
            });
            remeshMs = performance.now() - t0;
        }
    }

    hudRadius.textContent = brushState.radius.toFixed(2);
    hudMode.textContent = mode;
    if (remeshCount > 0) {
        hudRemesh.textContent = `${remeshCount} blk / ${remeshMs.toFixed(1)}ms`;
    }

    renderer.render(scene, camera);
}
