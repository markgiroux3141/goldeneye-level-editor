// Cave Painting Spike — Rust/WASM backend.
// Scene / input / render / glue only; the density field, brushes, noise, and
// marching cubes all live in cave-wasm/pkg/.

import * as THREE from 'three';
import init, { CaveWorld } from './cave-wasm/pkg/cave_wasm.js';
import {
    initInput, onScroll, updateCamera,
    isPointerLocked, isShiftHeld, isLeftMouseDown,
} from './fpsCamera.js';

// mode → u8 enum used by CaveWorld.apply_brush
const MODE = { subtract: 0, add: 1, flatten: 2, smooth: 3, expand: 4 };

// ---------- Scene setup ----------

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x15161c);
scene.fog = new THREE.Fog(0x15161c, 20, 80);

const CAVITY_CENTER = new THREE.Vector3(6.4, 6.4, 6.4);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.copy(CAVITY_CENTER);
camera.lookAt(CAVITY_CENTER.x + 1, CAVITY_CENTER.y, CAVITY_CENTER.z);

scene.add(new THREE.AmbientLight(0x404858, 0.35));
scene.add(new THREE.HemisphereLight(0xb8c4ff, 0x4a3a2a, 0.8));

const sun = new THREE.DirectionalLight(0xfff1d6, 0.9);
sun.position.set(10, 20, 5);
scene.add(sun);

const fill = new THREE.DirectionalLight(0x88a0c8, 0.45);
fill.position.set(-8, -3, -10);
scene.add(fill);

const headlamp = new THREE.PointLight(0xffe8b0, 1.2, 18, 2);
camera.add(headlamp);
scene.add(camera);

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

// ---------- Textures + material ----------

const rockTexture = new THREE.TextureLoader().load('../../public/textures/tempImgEd00BA.bmp');
rockTexture.wrapS = THREE.RepeatWrapping;
rockTexture.wrapT = THREE.RepeatWrapping;
rockTexture.magFilter = THREE.NearestFilter;
rockTexture.minFilter = THREE.NearestFilter;
rockTexture.generateMipmaps = false;
rockTexture.colorSpace = THREE.SRGBColorSpace;

const rockMaterial = new THREE.MeshStandardMaterial({
    map: rockTexture,
    color: 0xffffff,
    roughness: 0.95,
    metalness: 0.0,
    side: THREE.FrontSide,
    flatShading: false,
});

const blocksGroup = new THREE.Group();
blocksGroup.name = 'CaveBlocks';
scene.add(blocksGroup);

// ---------- WASM world ----------

let world = null;
const chunkMeshes = new Map(); // "cx,cy,cz" → THREE.Mesh

function chunkKey(cx, cy, cz) {
    return `${cx},${cy},${cz}`;
}

function regenerateChunk(cx, cy, cz) {
    const handle = world.mesh_chunk(cx, cy, cz);
    const key = chunkKey(cx, cy, cz);
    const existing = chunkMeshes.get(key);

    if (!handle) {
        if (existing) {
            blocksGroup.remove(existing);
            existing.geometry.dispose();
            chunkMeshes.delete(key);
        }
        return;
    }

    const positions = handle.positions();
    const normals = handle.normals();
    const uvs = handle.uvs();
    handle.free();

    let mesh = existing;
    if (!mesh) {
        const geom = new THREE.BufferGeometry();
        mesh = new THREE.Mesh(geom, rockMaterial);
        mesh.name = `chunk_${cx}_${cy}_${cz}`;
        mesh.userData.chunkCoord = [cx, cy, cz];
        blocksGroup.add(mesh);
        chunkMeshes.set(key, mesh);
    }

    const g = mesh.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    g.computeBoundingSphere();
    g.computeBoundingBox();
}

function flushDirtyChunks() {
    const dirty = world.flush_dirty(); // Int32Array, stride 3
    for (let i = 0; i < dirty.length; i += 3) {
        regenerateChunk(dirty[i], dirty[i + 1], dirty[i + 2]);
    }
    return dirty.length / 3;
}

// ---------- Brush preview ----------

const brushPreviewGeom = new THREE.SphereGeometry(1, 24, 16);
const brushPreviewMatSubtract = new THREE.MeshBasicMaterial({
    color: 0xff4444, wireframe: true, transparent: true, opacity: 0.6,
});
const brushPreviewMatAdd = new THREE.MeshBasicMaterial({
    color: 0x44ff66, wireframe: true, transparent: true, opacity: 0.6,
});
const brushPreviewMatSmooth = new THREE.MeshBasicMaterial({
    color: 0x44ffdd, wireframe: true, transparent: true, opacity: 0.6,
});
const brushPreviewMatExpand = new THREE.MeshBasicMaterial({
    color: 0xff8844, wireframe: true, transparent: true, opacity: 0.6,
});
const brushPreview = new THREE.Mesh(brushPreviewGeom, brushPreviewMatSubtract);
brushPreview.visible = false;
scene.add(brushPreview);

const flattenGizmoGeom = new THREE.BufferGeometry();
{
    const segs = 48;
    const pts = new Float32Array(segs * 3);
    for (let i = 0; i < segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        pts[i * 3    ] = Math.cos(a);
        pts[i * 3 + 1] = 0;
        pts[i * 3 + 2] = Math.sin(a);
    }
    flattenGizmoGeom.setAttribute('position', new THREE.BufferAttribute(pts, 3));
}
const flattenGizmo = new THREE.LineLoop(
    flattenGizmoGeom,
    new THREE.LineBasicMaterial({ color: 0x44aaff, transparent: true, opacity: 0.7 })
);
flattenGizmo.visible = false;
scene.add(flattenGizmo);

// ---------- Brush state ----------

const brushState = {
    radius: 1.5,
    strength: 0.4,
    minRadius: 0.6,
    maxRadius: 10.0,
    minStrength: 0.05,
    maxStrength: 2.0,
};

onScroll((deltaY) => {
    const step = deltaY > 0 ? -0.15 : 0.15;
    brushState.radius = Math.max(brushState.minRadius, Math.min(brushState.maxRadius, brushState.radius + step));
});

// ---------- HUD ----------

const hudRadius = document.getElementById('hud-radius');
const hudStrength = document.getElementById('hud-strength');
const hudMode = document.getElementById('hud-mode');
const hudRemesh = document.getElementById('hud-remesh');
const loadingOverlay = document.getElementById('loading');

// ---------- Init (async) ----------

async function bootstrap() {
    await init();
    world = new CaveWorld(0.4, 1.0);

    const t0 = performance.now();
    world.init_hollow_cavity(CAVITY_CENTER.x, CAVITY_CENTER.y, CAVITY_CENTER.z, 5.0, 0.3, 0.15);
    const t1 = performance.now();
    console.log(`[cave-rust] Density init: ${(t1 - t0).toFixed(1)} ms`);

    const t2 = performance.now();
    const meshed = flushDirtyChunks();
    const t3 = performance.now();
    console.log(`[cave-rust] Initial mesh: ${meshed} chunks in ${(t3 - t2).toFixed(1)} ms`);

    loadingOverlay.style.display = 'none';
    initInput(canvas);
    requestAnimationFrame(loop);
}

bootstrap();

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
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    brushTarget.copy(camera.position).addScaledVector(fwd, 3);
    return false;
}

// ---------- Keybinds ----------

let brushGizmoVisible = true;
let specialMode = null;

document.addEventListener('keydown', (e) => {
    if (e.code === 'Equal' || e.code === 'NumpadAdd') {
        brushState.radius = Math.min(brushState.maxRadius, brushState.radius + 0.15);
    } else if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
        brushState.radius = Math.max(brushState.minRadius, brushState.radius - 0.15);
    } else if (e.code === 'BracketRight') {
        brushState.strength = Math.min(brushState.maxStrength, brushState.strength + 0.1);
    } else if (e.code === 'BracketLeft') {
        brushState.strength = Math.max(brushState.minStrength, brushState.strength - 0.1);
    } else if (e.code === 'KeyG') {
        brushGizmoVisible = !brushGizmoVisible;
    } else if (e.code === 'KeyF') {
        specialMode = specialMode === 'flatten' ? null : 'flatten';
    } else if (e.code === 'KeyR') {
        specialMode = specialMode === 'smooth' ? null : 'smooth';
    } else if (e.code === 'KeyE') {
        specialMode = specialMode === 'expand' ? null : 'expand';
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

    pickBrushTarget();
    let mode = isShiftHeld() ? 'add' : 'subtract';
    if (specialMode) mode = specialMode;
    const isFlatten = mode === 'flatten';
    const isExpand = mode === 'expand';
    const brushCenter = isExpand ? camera.position : brushTarget;
    const gizmoVisible = isPointerLocked() && brushGizmoVisible;
    brushPreview.visible = gizmoVisible && !isFlatten;
    brushPreview.position.copy(brushCenter);
    brushPreview.scale.setScalar(brushState.radius);
    brushPreview.material =
        mode === 'add'    ? brushPreviewMatAdd    :
        mode === 'smooth' ? brushPreviewMatSmooth :
        mode === 'expand' ? brushPreviewMatExpand :
                            brushPreviewMatSubtract;
    flattenGizmo.visible = gizmoVisible && isFlatten;
    flattenGizmo.position.copy(brushTarget);
    flattenGizmo.scale.setScalar(brushState.radius);

    let remeshCount = 0;
    let remeshMs = 0;
    if (isPointerLocked() && isLeftMouseDown()) {
        const changed = world.apply_brush(
            MODE[mode],
            brushCenter.x, brushCenter.y, brushCenter.z,
            brushState.radius, brushState.strength, dt,
        );
        if (changed) {
            const t0 = performance.now();
            remeshCount = flushDirtyChunks();
            remeshMs = performance.now() - t0;
        }
    }

    hudRadius.textContent = brushState.radius.toFixed(2);
    hudStrength.textContent = brushState.strength.toFixed(2);
    hudMode.textContent = mode;
    if (remeshCount > 0) {
        hudRemesh.textContent = `${remeshCount} chk / ${remeshMs.toFixed(1)}ms`;
    }

    renderer.render(scene, camera);
}
