// Hub-walkway spike — axis-aligned hubs connected by arbitrary-angle walkways.

import * as THREE from 'three';
import { World, resolveAnchor } from './model.js';
import { buildHub, buildWalkway, walkwayGapWidthAlongEdge } from './geometry.js';
import { TopDownCamera } from './topDownCamera.js';
import { InputController } from './input.js';
import { loadTextures, buildMaterialArray } from './materials.js';

const WORLD_SCALE = 0.25;

const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a2e);
scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const dir = new THREE.DirectionalLight(0xffffff, 0.6);
dir.position.set(-5, 10, -3);
scene.add(dir);
const grid = new THREE.GridHelper(80, 80, 0x333344, 0x222233);
grid.position.y = -0.01;
scene.add(grid);

const topCam = new TopDownCamera(canvas);

function resize() {
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    topCam.onResize();
}
window.addEventListener('resize', resize);
new ResizeObserver(resize).observe(canvas);
resize();

const world = new World();
const hubMeshes = new Map();
const walkwayMeshes = new Map();

const hubGroup = new THREE.Group();
const walkwayGroup = new THREE.Group();
const previewGroup = new THREE.Group();
scene.add(hubGroup); scene.add(walkwayGroup); scene.add(previewGroup);

const hoverMarker = new THREE.Mesh(
    new THREE.RingGeometry(0.4 * WORLD_SCALE, 0.55 * WORLD_SCALE, 24),
    new THREE.MeshBasicMaterial({ color: 0x44ff88, side: THREE.DoubleSide, transparent: true, opacity: 0.85 }),
);
hoverMarker.rotation.x = -Math.PI / 2;
hoverMarker.visible = false;
scene.add(hoverMarker);

const selectionMarker = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: 0xffcc44, side: THREE.DoubleSide, transparent: true, opacity: 0.15 }),
);
selectionMarker.rotation.x = -Math.PI / 2;
selectionMarker.visible = false;
scene.add(selectionMarker);

let mats = null;
let previewMat = null;

function dispose(mesh) {
    if (!mesh) return;
    if (mesh.parent) mesh.parent.remove(mesh);
    if (mesh.geometry) mesh.geometry.dispose();
}

// Compute walkway attachments per hub edge so buildHub can cut skirt gaps.
function attachmentsForHub(hubId) {
    const byEdge = { xMin: [], xMax: [], zMin: [], zMax: [] };
    for (const w of world.walkways.values()) {
        for (const anchor of [w.anchorA, w.anchorB]) {
            if (anchor.hubId !== hubId) continue;
            const ptA = resolveAnchor(world, w.anchorA);
            const ptB = resolveAnchor(world, w.anchorB);
            const gap = walkwayGapWidthAlongEdge(ptA, ptB, anchor, w.width);
            byEdge[anchor.edge].push({ t: anchor.t, gapHalfWidthAlongEdge: gap / 2 });
        }
    }
    return byEdge;
}

function applyDirty({ dirtyHubs, dirtyWalkways }) {
    // Walkways that touch a dirty hub must rebuild too.
    for (const hubId of dirtyHubs) {
        for (const w of world.walkwaysOfHub(hubId)) dirtyWalkways.add(w.id);
    }
    // Rebuild hubs.
    for (const hubId of dirtyHubs) {
        dispose(hubMeshes.get(hubId)); hubMeshes.delete(hubId);
        const hub = world.hubs.get(hubId);
        if (!hub || !mats) continue;
        const geo = buildHub(hub, attachmentsForHub(hubId));
        const mesh = new THREE.Mesh(geo, mats);
        hubGroup.add(mesh);
        hubMeshes.set(hubId, mesh);
    }
    // Rebuild walkways.
    for (const wId of dirtyWalkways) {
        dispose(walkwayMeshes.get(wId)); walkwayMeshes.delete(wId);
        const w = world.walkways.get(wId);
        if (!w || !mats) continue;
        const hubA = world.hubs.get(w.anchorA.hubId);
        const hubB = world.hubs.get(w.anchorB.hubId);
        if (!hubA || !hubB) continue;
        const geo = buildWalkway(world, w);
        const mesh = new THREE.Mesh(geo, mats);
        walkwayGroup.add(mesh);
        walkwayMeshes.set(wId, mesh);
    }
}

function rebuildAll() {
    applyDirty({
        dirtyHubs: new Set(world.hubs.keys()),
        dirtyWalkways: new Set(world.walkways.keys()),
    });
}

// ─── PREVIEW ────────────────────────────────────────────────────

function clearPreview() {
    while (previewGroup.children.length) {
        const c = previewGroup.children[0];
        previewGroup.remove(c);
        if (c.geometry) c.geometry.dispose();
    }
}

function updatePreview(p) {
    clearPreview();
    if (!p || !previewMat) return;
    if (p.kind === 'HUB') {
        const x0 = Math.min(p.a.x, p.b.x), z0 = Math.min(p.a.z, p.b.z);
        const x1 = Math.max(p.a.x, p.b.x), z1 = Math.max(p.a.z, p.b.z);
        const y = 0.1;
        const pts = [
            [x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0],
        ].map(([x,y,z]) => new THREE.Vector3(x * WORLD_SCALE, y * WORLD_SCALE, z * WORLD_SCALE));
        const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
        previewGroup.add(new THREE.Line(lineGeo, previewMat));
    } else if (p.kind === 'WALKWAY') {
        const ptA = resolveAnchor(world, p.anchorA);
        const ptB = { x: p.end.x, z: p.end.z, y: ptA.y };
        const dx = ptB.x - ptA.x, dz = ptB.z - ptA.z;
        const len = Math.hypot(dx, dz);
        if (len < 0.05) return;
        const ax = dx / len, az = dz / len;
        const nx = -az, nz = ax;
        const hw = p.width / 2;
        const y = ptA.y + 0.05;
        const corners = [
            { x: ptA.x + hw * nx, z: ptA.z + hw * nz },
            { x: ptB.x + hw * nx, z: ptB.z + hw * nz },
            { x: ptB.x - hw * nx, z: ptB.z - hw * nz },
            { x: ptA.x - hw * nx, z: ptA.z - hw * nz },
        ];
        const pts = [...corners, corners[0]].map((c) =>
            new THREE.Vector3(c.x * WORLD_SCALE, y * WORLD_SCALE, c.z * WORLD_SCALE));
        const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
        previewGroup.add(new THREE.Line(lineGeo, previewMat));
    }
}

// ─── STATUS ─────────────────────────────────────────────────────

const statusEl = document.getElementById('status');

function updateStatus({ state, selectedHubId, previewWidth }) {
    let txt = `State: ${state}`;
    if (state === 'PLACING_HUB') txt += '  |  click to set opposite corner  |  ESC: cancel';
    else if (state === 'PLACING_WALKWAY') txt += `  |  width ${previewWidth.toFixed(2)} WT  |  wheel: width, click hub edge to commit`;
    else if (state === 'SELECTED' && selectedHubId != null) {
        const h = world.hubs.get(selectedHubId);
        txt += `  |  Hub #${selectedHubId}  ${h.sizeX.toFixed(1)}×${h.sizeZ.toFixed(1)} WT y=${h.y.toFixed(2)}  |  ↑/↓: height, Del: delete`;
    } else txt += '  |  click empty → hub, click hub edge → walkway, click inside → select';
    statusEl.textContent = txt;

    if (state === 'SELECTED' && selectedHubId != null) {
        const h = world.hubs.get(selectedHubId);
        selectionMarker.position.set((h.x + h.sizeX / 2) * WORLD_SCALE, h.y * WORLD_SCALE + 0.1, (h.z + h.sizeZ / 2) * WORLD_SCALE);
        selectionMarker.scale.set(h.sizeX * WORLD_SCALE, h.sizeZ * WORLD_SCALE, 1);
        selectionMarker.visible = true;
    } else {
        selectionMarker.visible = false;
    }
}

function updateHover(h) {
    if (!h) { hoverMarker.visible = false; return; }
    hoverMarker.visible = true;
    hoverMarker.position.set(h.foot.x * WORLD_SCALE, 0.02, h.foot.z * WORLD_SCALE);
}

// ─── BOOT ───────────────────────────────────────────────────────

(async function boot() {
    await loadTextures();
    mats = buildMaterialArray();
    previewMat = new THREE.LineBasicMaterial({ color: 0xffff00 });
    rebuildAll();
    document.getElementById('loading').style.display = 'none';
})();

const input = new InputController(canvas, topCam, world, {
    onMutate: applyDirty,
    onPreview: updatePreview,
    onHover: updateHover,
    onState: updateStatus,
});
updateStatus({ state: 'IDLE', selectedHubId: null, previewWidth: 2 });

function animate() {
    renderer.render(scene, topCam.camera);
    requestAnimationFrame(animate);
}
animate();
