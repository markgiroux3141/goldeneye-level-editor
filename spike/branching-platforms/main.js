// Branching platforms spike — unified polygon-union rendering pipeline.
// On every graph mutation, partition segments into flat-height components,
// Boolean-union all rectangles within each component into one polygon, and
// emit one mesh per component. Stair segments (different y at each end)
// still render per-segment as 3D meshes.

import * as THREE from 'three';
import { Graph } from './graph.js';
import { computeFlatComponents } from './flatComponents.js';
import { unionComponent } from './polygonUnion.js';
import { polygonToGeometry } from './polygonMesh.js';
import { buildStairSegment } from './segmentGeometry.js';
import { TopDownCamera } from './topDownCamera.js';
import { FpsCamera } from './fpsCamera.js';
import { InputController } from './input.js';
import { loadTextures, buildMaterialArray } from './materials.js';

const WORLD_SCALE = 0.25;
const DEFAULT_THICKNESS = 1;      // WT
const DEFAULT_STEP_HEIGHT = 1;    // WT

// ─── SCENE SETUP ─────────────────────────────────────────────

const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a2e);

scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const dir = new THREE.DirectionalLight(0xffffff, 0.6);
dir.position.set(-5, 10, -3);
scene.add(dir);

const gridHelper = new THREE.GridHelper(80, 80, 0x333344, 0x222233);
gridHelper.position.y = -0.01;
scene.add(gridHelper);

const topCam = new TopDownCamera(canvas);
const fpsCam = new FpsCamera(canvas, {
    lockPromptEl: document.getElementById('lock-prompt'),
    crosshairEl: document.getElementById('crosshair'),
});

// Track which camera renders. Start in top-down edit mode.
let mode = 'TOP';   // 'TOP' | 'FPS'

function resize() {
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    topCam.onResize();
    fpsCam.onResize();
}
window.addEventListener('resize', resize);
new ResizeObserver(resize).observe(canvas);
resize();

// ─── GRAPH + MESH STATE ──────────────────────────────────────

const graph = new Graph();

// flatMeshes: one mesh per flat-height component. stairMeshes: one per stair
// segment. nodeMarkers: small clickable dots (not rendered as geometry but
// shown for hit-testing feedback).
const flatMeshes = [];
const stairMeshes = new Map();   // segId → THREE.Mesh
const nodeMarkers = new Map();   // nodeId → THREE.Mesh

const segmentGroup = new THREE.Group();  // flat + stair meshes
const markerGroup = new THREE.Group();
scene.add(segmentGroup);
scene.add(markerGroup);

// Preview group for the in-progress segment.
const previewGroup = new THREE.Group();
scene.add(previewGroup);

// Selected-node highlight.
const selectionMarker = new THREE.Mesh(
    new THREE.RingGeometry(0.25 * WORLD_SCALE, 0.35 * WORLD_SCALE, 24),
    new THREE.MeshBasicMaterial({ color: 0xffcc44, side: THREE.DoubleSide }),
);
selectionMarker.rotation.x = -Math.PI / 2;
selectionMarker.visible = false;
scene.add(selectionMarker);

// Hover highlight — green ring over current snap target.
const hoverMarker = new THREE.Mesh(
    new THREE.RingGeometry(0.25 * WORLD_SCALE, 0.38 * WORLD_SCALE, 24),
    new THREE.MeshBasicMaterial({ color: 0x44ff88, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }),
);
hoverMarker.rotation.x = -Math.PI / 2;
hoverMarker.visible = false;
scene.add(hoverMarker);

const hoverLabelEl = document.getElementById('hover-label');

let mats = null;
let previewMat = null;
let nodeMarkerMat = null;

// ─── REBUILD ─────────────────────────────────────────────────

function disposeMesh(mesh) {
    if (!mesh) return;
    if (mesh.parent) mesh.parent.remove(mesh);
    if (mesh.geometry) mesh.geometry.dispose();
}

function clearAllMeshes() {
    for (const m of flatMeshes) disposeMesh(m);
    flatMeshes.length = 0;
    for (const m of stairMeshes.values()) disposeMesh(m);
    stairMeshes.clear();
}

function rebuildNodeMarkers() {
    // Add/move markers for current nodes; drop stale ones.
    const alive = new Set(graph.nodes.keys());
    for (const [id, marker] of [...nodeMarkers]) {
        if (!alive.has(id)) { disposeMesh(marker); nodeMarkers.delete(id); }
    }
    for (const node of graph.nodes.values()) {
        let marker = nodeMarkers.get(node.id);
        if (!marker && nodeMarkerMat) {
            const geo = new THREE.CircleGeometry(0.15 * WORLD_SCALE, 16);
            geo.rotateX(-Math.PI / 2);
            marker = new THREE.Mesh(geo, nodeMarkerMat);
            markerGroup.add(marker);
            nodeMarkers.set(node.id, marker);
        }
        if (marker) {
            marker.position.set(
                node.x * WORLD_SCALE,
                node.y * WORLD_SCALE + 0.02,
                node.z * WORLD_SCALE,
            );
        }
    }
}

function rebuildAll() {
    if (!mats) return;   // textures still loading
    clearAllMeshes();

    const { components, stairs } = computeFlatComponents(graph);

    for (const comp of components) {
        const multiPoly = unionComponent(comp, graph);
        if (!multiPoly || multiPoly.length === 0) continue;
        const geo = polygonToGeometry(multiPoly, comp.y, DEFAULT_THICKNESS);
        const pos = geo.getAttribute('position');
        if (!pos || pos.count === 0) { geo.dispose(); continue; }
        const mesh = new THREE.Mesh(geo, mats);
        segmentGroup.add(mesh);
        flatMeshes.push(mesh);
    }

    for (const seg of stairs) {
        const a = graph.nodes.get(seg.a);
        const b = graph.nodes.get(seg.b);
        const geo = buildStairSegment(a, b, seg.width, DEFAULT_STEP_HEIGHT);
        const pos = geo.getAttribute('position');
        if (!pos || pos.count === 0) { geo.dispose(); continue; }
        const mesh = new THREE.Mesh(geo, mats);
        segmentGroup.add(mesh);
        stairMeshes.set(seg.id, mesh);
    }

    rebuildNodeMarkers();
}

// Input.js passes dirty-set hints; under the unified pipeline any change
// triggers a full rebuild (cheap at spike scale).
function applyDirty(_ignored) {
    rebuildAll();
}

// ─── PREVIEW (in-progress segment) ───────────────────────────

function updatePreview(preview) {
    while (previewGroup.children.length > 0) {
        const c = previewGroup.children[0];
        previewGroup.remove(c);
        if (c.geometry) c.geometry.dispose();
    }
    if (!preview || !previewMat) return;
    const { start, end, width } = preview;
    const dx = end.x - start.x, dz = end.z - start.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) return;
    const ax = dx / len, az = dz / len;
    const lx = -az, lz = ax;
    const hw = width / 2;
    const aL = { x: start.x + hw * lx, z: start.z + hw * lz };
    const aR = { x: start.x - hw * lx, z: start.z - hw * lz };
    const bL = { x: end.x   + hw * lx, z: end.z   + hw * lz };
    const bR = { x: end.x   - hw * lx, z: end.z   - hw * lz };

    const y = (start.y || 0) + 0.05;
    const pts = [aL, bL, bR, aR, aL].map((p) =>
        new THREE.Vector3(p.x * WORLD_SCALE, y * WORLD_SCALE, p.z * WORLD_SCALE));
    const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(lineGeo, previewMat);
    previewGroup.add(line);
}

// ─── STATE / UI OVERLAY ──────────────────────────────────────

const statusEl = document.getElementById('status');

function updateStatus({ state, selectedNodeId, previewWidth, angleSnap }) {
    let txt = `State: ${state}`;
    if (state === 'PLACING') {
        txt += `  |  Width: ${previewWidth.toFixed(2)} WT`;
        txt += `  |  Angle snap: ${angleSnap ? 'ON (15°, hold Alt to free)' : 'OFF'}`;
        txt += '  |  wheel: width  |  ESC: cancel';
    }
    if (state === 'SELECTED' && selectedNodeId != null) {
        const n = graph.nodes.get(selectedNodeId);
        txt += `  |  Node #${selectedNodeId}  y=${n.y.toFixed(2)} WT  |  ↑/↓: height, Del: delete, ESC: deselect`;
    }
    if (state === 'IDLE') txt += '  |  click empty → start  |  click edge/mid → branch  |  click node → select';
    statusEl.textContent = txt;

    if (state === 'SELECTED' && selectedNodeId != null) {
        const n = graph.nodes.get(selectedNodeId);
        selectionMarker.position.set(n.x * WORLD_SCALE, n.y * WORLD_SCALE + 0.05, n.z * WORLD_SCALE);
        selectionMarker.visible = true;
    } else {
        selectionMarker.visible = false;
    }
}

const SNAP_COLORS = {
    NODE:      0x44ff88,
    MIDPOINT:  0xffaa44,
    EDGE:      0x88ccff,
    PERPFOOT:  0xff88cc,
};
const SNAP_LABELS = {
    NODE: 'VERTEX',
    MIDPOINT: 'MIDPOINT',
    EDGE: 'EDGE',
    PERPFOOT: 'PERPENDICULAR',
};

function updateHover(snap) {
    if (!snap) {
        hoverMarker.visible = false;
        hoverLabelEl.style.display = 'none';
        return;
    }
    hoverMarker.visible = true;
    hoverMarker.position.set(snap.x * WORLD_SCALE, 0.02, snap.z * WORLD_SCALE);
    hoverMarker.material.color.setHex(SNAP_COLORS[snap.type] || 0x44ff88);
    hoverLabelEl.textContent = SNAP_LABELS[snap.type] || snap.type;
    hoverLabelEl.style.color = '#' + (SNAP_COLORS[snap.type] || 0x44ff88).toString(16).padStart(6, '0');
    const v = new THREE.Vector3(snap.x * WORLD_SCALE, 0, snap.z * WORLD_SCALE);
    v.project(topCam.camera);
    const rect = canvas.getBoundingClientRect();
    const sx = ((v.x + 1) / 2) * rect.width + rect.left;
    const sy = ((-v.y + 1) / 2) * rect.height + rect.top;
    hoverLabelEl.style.display = 'block';
    hoverLabelEl.style.left = (sx + 12) + 'px';
    hoverLabelEl.style.top = (sy - 18) + 'px';
}

// ─── BOOT ────────────────────────────────────────────────────

(async function boot() {
    await loadTextures();
    mats = buildMaterialArray();
    previewMat = new THREE.LineBasicMaterial({ color: 0xffff00 });
    nodeMarkerMat = new THREE.MeshBasicMaterial({ color: 0xff4444, side: THREE.DoubleSide });
    rebuildAll();
    document.getElementById('loading').style.display = 'none';
})();

// Input controller wires up all canvas/window listeners as a side effect.
const input = new InputController(canvas, topCam, graph, applyDirty, updatePreview, updateStatus, updateHover);
updateStatus({ state: 'IDLE', selectedNodeId: null, previewWidth: 2, angleSnap: true });

// ─── MODE TOGGLE (Top-down ↔ FPS fly) ────────────────────────

function setMode(newMode) {
    if (newMode === mode) return;
    mode = newMode;
    const fps = (mode === 'FPS');
    input.setEnabled(!fps);
    fpsCam.setEnabled(fps);
    // Hide top-down-only overlays while in FPS mode.
    hoverMarker.visible = false;
    selectionMarker.visible = false;
    if (hoverLabelEl) hoverLabelEl.style.display = 'none';
    // Hide the in-progress preview line too.
    while (previewGroup.children.length > 0) {
        const c = previewGroup.children[0];
        previewGroup.remove(c);
        if (c.geometry) c.geometry.dispose();
    }
    // Seed the FPS camera somewhere useful: above/behind the centroid of all nodes.
    if (fps) {
        let cx = 0, cz = 0, n = 0;
        for (const node of graph.nodes.values()) { cx += node.x; cz += node.z; n++; }
        if (n > 0) { cx /= n; cz /= n; }
        fpsCam.lookAtTarget({ x: cx * WORLD_SCALE, z: cz * WORLD_SCALE });
    }
    const modeEl = document.getElementById('mode-indicator');
    if (modeEl) modeEl.textContent = fps ? '3D FLY  |  click to lock  |  WASD · Space/C · Shift fast · V to exit'
                                         : 'TOP-DOWN  |  V: 3D fly';
}

window.addEventListener('keydown', (e) => {
    // V toggles 3D fly mode. Avoid triggering while typing in any input (no
    // inputs in this spike, but future-proof).
    if ((e.key === 'v' || e.key === 'V') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setMode(mode === 'TOP' ? 'FPS' : 'TOP');
    }
});

// Initialize indicator text.
setMode('TOP');

// ─── RENDER LOOP ─────────────────────────────────────────────

let lastTs = performance.now();
function animate(nowTs) {
    const ts = nowTs ?? performance.now();
    const dt = Math.min(0.1, (ts - lastTs) / 1000);   // cap big frame jumps
    lastTs = ts;
    fpsCam.update(dt);
    const cam = (mode === 'FPS') ? fpsCam.camera : topCam.camera;
    renderer.render(scene, cam);
    requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
