import * as THREE from 'three';
import { Evaluator, Brush as CSGBrush, ADDITION, SUBTRACTION } from 'three-bvh-csg';

// ─── Constants ───────────────────────────────────────────────────────

const SCALE = 0.25;
const MOVE_SPEED = 8;
const LOOK_SPEED = 0.002;
const WALL_THICKNESS = 1;

// ─── Brush Definition ────────────────────────────────────────────────

let nextBrushId = 1;

class BrushDef {
    constructor(op, x, y, z, w, h, d) {
        this.id = nextBrushId++;
        this.op = op;
        this.x = x; this.y = y; this.z = z;
        this.w = w; this.h = h; this.d = d;
        // Per-face taper: key = 'x-min'|'x-max'|'y-min'|'y-max'|'z-min'|'z-max'
        // value = { u: number, v: number } — symmetric inset in WT on each edge
        this.taper = {};
    }

    hasTaper() { return Object.keys(this.taper).length > 0; }

    toCSGBrush() {
        const geo = new THREE.BoxGeometry(this.w * SCALE, this.h * SCALE, this.d * SCALE);
        if (this.hasTaper()) {
            applyTaperToBoxGeo(geo, this);
        }
        const cx = (this.x + this.w / 2) * SCALE;
        const cy = (this.y + this.h / 2) * SCALE;
        const cz = (this.z + this.d / 2) * SCALE;
        const brush = new CSGBrush(geo);
        brush.position.set(cx, cy, cz);
        brush.updateMatrixWorld();
        return brush;
    }

    getFaces() {
        return [
            { brushId: this.id, axis: 'x', side: 'min', pos: this.x },
            { brushId: this.id, axis: 'x', side: 'max', pos: this.x + this.w },
            { brushId: this.id, axis: 'y', side: 'min', pos: this.y },
            { brushId: this.id, axis: 'y', side: 'max', pos: this.y + this.h },
            { brushId: this.id, axis: 'z', side: 'min', pos: this.z },
            { brushId: this.id, axis: 'z', side: 'max', pos: this.z + this.d },
        ];
    }

    get minX() { return this.x; }  get maxX() { return this.x + this.w; }
    get minY() { return this.y; }  get maxY() { return this.y + this.h; }
    get minZ() { return this.z; }  get maxZ() { return this.z + this.d; }
}

// ─── Frustum Geometry Builder ───────────────────────────────────────
// Builds a BufferGeometry for a brush with tapered faces.
// A taper on a face insets its 4 vertices toward the face center,
// creating a frustum (truncated pyramid) shape. Side faces become trapezoids.

// ─── Taper: Modify BoxGeometry Vertices In-Place ────────────────────
// Instead of building custom geometry, we modify a standard BoxGeometry.
// This preserves the index buffer, UVs, and groups that three-bvh-csg expects.
// For each tapered face, we find all vertices at that face's position and
// move them toward the face center in the face's UV plane.

function applyTaperToBoxGeo(geo, brush) {
    const pos = geo.getAttribute('position');
    const hw = brush.w * SCALE / 2;
    const hh = brush.h * SCALE / 2;
    const hd = brush.d * SCALE / 2;

    for (const [faceKey, { u: tU, v: tV }] of Object.entries(brush.taper)) {
        const [axis, side] = faceKey.split('-');

        // Determine: which position component identifies this face,
        // what value it should match, and which components to adjust
        let checkAxis, target, uAxis, vAxis;
        if (axis === 'y') {
            checkAxis = 1; target = side === 'max' ? hh : -hh;
            uAxis = 0; vAxis = 2; // U=X, V=Z
        } else if (axis === 'x') {
            checkAxis = 0; target = side === 'max' ? hw : -hw;
            uAxis = 2; vAxis = 1; // U=Z, V=Y
        } else {
            checkAxis = 2; target = side === 'max' ? hd : -hd;
            uAxis = 0; vAxis = 1; // U=X, V=Y
        }

        const getComp = (i, c) => c === 0 ? pos.getX(i) : c === 1 ? pos.getY(i) : pos.getZ(i);

        for (let i = 0; i < pos.count; i++) {
            const val = getComp(i, checkAxis);
            if (Math.abs(val - target) < 0.001) {
                const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
                const coords = [x, y, z];
                // Move U and V components toward center (center is 0 in local space)
                coords[uAxis] -= Math.sign(coords[uAxis]) * tU * SCALE;
                coords[vAxis] -= Math.sign(coords[vAxis]) * tV * SCALE;
                pos.setXYZ(i, coords[0], coords[1], coords[2]);
            }
        }
    }

    pos.needsUpdate = true;
    geo.computeVertexNormals();
}

// ─── Face UV Helpers ─────────────────────────────────────────────────
// Each face axis maps to 2D (U, V):
//   axis='x': U=z, V=y  |  axis='y': U=x, V=z  |  axis='z': U=x, V=y

function getFaceUVInfo(brush, axis) {
    if (axis === 'x') return { uMin: brush.z, uMax: brush.z + brush.d, vMin: brush.y, vMax: brush.y + brush.h, uSize: brush.d, vSize: brush.h };
    if (axis === 'y') return { uMin: brush.x, uMax: brush.x + brush.w, vMin: brush.z, vMax: brush.z + brush.d, uSize: brush.w, vSize: brush.d };
    return              { uMin: brush.x, uMax: brush.x + brush.w, vMin: brush.y, vMax: brush.y + brush.h, uSize: brush.w, vSize: brush.h };
}

function worldToFaceUV(hitPoint, axis) {
    const p = { x: hitPoint.x / SCALE, y: hitPoint.y / SCALE, z: hitPoint.z / SCALE };
    if (axis === 'x') return { u: p.z, v: p.y };
    if (axis === 'y') return { u: p.x, v: p.z };
    return              { u: p.x, v: p.y };
}

// Compute face UV bounds for a baked face by scanning the mesh geometry
function getBakedFaceUVInfo(face) {
    if (!csgMesh) return null;
    const { axis, side, position } = face;
    const pos = csgMesh.geometry.getAttribute('position');
    const idx = csgMesh.geometry.index;

    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    const v = new THREE.Vector3();

    for (let i = 0; i < currentFaceIds.length; i++) {
        const f = currentFaceIds[i];
        if (!f || f.brushId !== 0 || f.axis !== axis || f.side !== side || f.position !== position) continue;

        for (let j = 0; j < 3; j++) {
            const vi = idx ? idx.getX(i * 3 + j) : i * 3 + j;
            v.fromBufferAttribute(pos, vi);
            const uv = worldToFaceUV(v, axis);
            uMin = Math.min(uMin, uv.u); uMax = Math.max(uMax, uv.u);
            vMin = Math.min(vMin, uv.v); vMax = Math.max(vMax, uv.v);
        }
    }

    if (!isFinite(uMin)) return null;

    return {
        uMin: Math.round(uMin), uMax: Math.round(uMax),
        vMin: Math.round(vMin), vMax: Math.round(vMax),
        uSize: Math.round(uMax - uMin),
        vSize: Math.round(vMax - vMin)
    };
}

// ─── State ───────────────────────────────────────────────────────────

const shell = new BrushDef('add', -1, -1, -1, 14, 10, 14);

const brushes = [
    new BrushDef('subtract', 0, 0, 0, 12, 8, 12),
];

// Selection state
let selectedFace = null;  // { brushId, axis, side, position }
let selSizeU = 0;         // selection width in WT (0 = full face)
let selSizeV = 0;         // selection height in WT (0 = full face)
let selU0 = 0, selU1 = 0, selV0 = 0, selV1 = 0; // computed each frame

// Active push/pull/extrude tracking
let activeBrush = null;   // the brush being grown by consecutive operations
let activeOp = null;       // 'push' | 'pull' | 'extrude'
let activeSide = null;     // original face side when operation started

// ─── Shell Auto-Resize ───────────────────────────────────────────────

let bakedBounds = null;

function updateShell() {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    if (bakedBounds) {
        minX = bakedBounds.minX; minY = bakedBounds.minY; minZ = bakedBounds.minZ;
        maxX = bakedBounds.maxX; maxY = bakedBounds.maxY; maxZ = bakedBounds.maxZ;
    }

    for (const b of brushes) {
        if (b.op !== 'subtract') continue;
        minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY); minZ = Math.min(minZ, b.minZ);
        maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY); maxZ = Math.max(maxZ, b.maxZ);
    }
    if (!isFinite(minX)) return;

    const t = WALL_THICKNESS;
    shell.x = minX - t; shell.y = minY - t; shell.z = minZ - t;
    shell.w = (maxX - minX) + t * 2;
    shell.h = (maxY - minY) + t * 2;
    shell.d = (maxZ - minZ) + t * 2;
}

// ─── CSG Evaluation ──────────────────────────────────────────────────

const csgEvaluator = new Evaluator();

let bakedCSGBrush = null;
let totalBakedBrushes = 0;

function evaluateBrushes() {
    const t0 = performance.now();

    let result = shell.toCSGBrush();

    if (bakedCSGBrush) {
        result = csgEvaluator.evaluate(result, bakedCSGBrush, SUBTRACTION);
    }

    for (const brush of brushes) {
        const csgBrush = brush.toCSGBrush();
        const op = brush.op === 'subtract' ? SUBTRACTION : ADDITION;
        result = csgEvaluator.evaluate(result, csgBrush, op);
    }

    const elapsed = performance.now() - t0;
    const geometry = result.geometry;
    const allBrushes = [shell, ...brushes];
    const faceIds = buildFaceMap(geometry, allBrushes);
    return { geometry, timeMs: elapsed, faceIds };
}

function bake() {
    if (brushes.length === 0 && !bakedCSGBrush) return;
    const t0 = performance.now();

    let interior = bakedCSGBrush;

    for (const brush of brushes) {
        const csgBrush = brush.toCSGBrush();
        if (brush.op === 'subtract') {
            if (!interior) { interior = csgBrush; }
            else { interior = csgEvaluator.evaluate(interior, csgBrush, ADDITION); }
        } else {
            if (interior) { interior = csgEvaluator.evaluate(interior, csgBrush, SUBTRACTION); }
        }
    }

    const bakedCount = brushes.length;
    totalBakedBrushes += bakedCount;
    bakedCSGBrush = interior;

    if (interior && interior.geometry) {
        interior.geometry.computeBoundingBox();
        const bb = interior.geometry.boundingBox;
        bakedBounds = {
            minX: Math.round(bb.min.x / SCALE), minY: Math.round(bb.min.y / SCALE), minZ: Math.round(bb.min.z / SCALE),
            maxX: Math.round(bb.max.x / SCALE), maxY: Math.round(bb.max.y / SCALE), maxZ: Math.round(bb.max.z / SCALE),
        };
    }

    brushes.length = 0;
    selectedFace = null;
    activeBrush = null;
    activeOp = null;
    activeSide = null;
    selSizeU = 0;
    selSizeV = 0;

    const elapsed = performance.now() - t0;
    console.log(`Baked ${bakedCount} brushes in ${elapsed.toFixed(1)}ms (${totalBakedBrushes} total baked)`);

    rebuildCSG();
    updateHUD();
}

// ─── Face Identity Recovery ──────────────────────────────────────────

function buildFaceMap(geometry, brushList) {
    const pos = geometry.getAttribute('position');
    const idx = geometry.index;
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    const faceIds = [];

    const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
    const normal = new THREE.Vector3(), centroid = new THREE.Vector3();
    const edge1 = new THREE.Vector3(), edge2 = new THREE.Vector3();

    const allFaces = [];
    for (const brush of brushList) {
        for (const face of brush.getFaces()) {
            allFaces.push({ ...face, brush });
        }
    }

    // Helper: check if a point (in WT space) falls within a brush's extent on the two tangent axes
    const TOL = 0.5; // tolerance in WT
    function centroidInBrush(brush, axis, cx, cy, cz) {
        if (axis === 'x') {
            return cz >= brush.minZ - TOL && cz <= brush.maxZ + TOL &&
                   cy >= brush.minY - TOL && cy <= brush.maxY + TOL;
        } else if (axis === 'y') {
            return cx >= brush.minX - TOL && cx <= brush.maxX + TOL &&
                   cz >= brush.minZ - TOL && cz <= brush.maxZ + TOL;
        } else {
            return cx >= brush.minX - TOL && cx <= brush.maxX + TOL &&
                   cy >= brush.minY - TOL && cy <= brush.maxY + TOL;
        }
    }

    for (let t = 0; t < triCount; t++) {
        const i0 = idx ? idx.getX(t * 3) : t * 3;
        const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;

        vA.fromBufferAttribute(pos, i0);
        vB.fromBufferAttribute(pos, i1);
        vC.fromBufferAttribute(pos, i2);

        edge1.subVectors(vB, vA);
        edge2.subVectors(vC, vA);
        normal.crossVectors(edge1, edge2).normalize();

        centroid.set(
            (vA.x + vB.x + vC.x) / 3,
            (vA.y + vB.y + vC.y) / 3,
            (vA.z + vB.z + vC.z) / 3
        );

        const ax = Math.abs(normal.x), ay = Math.abs(normal.y), az = Math.abs(normal.z);
        let axis, side, posAlongAxis;
        if (ax >= ay && ax >= az) {
            axis = 'x'; side = normal.x > 0 ? 'min' : 'max'; posAlongAxis = centroid.x / SCALE;
        } else if (ay >= ax && ay >= az) {
            axis = 'y'; side = normal.y > 0 ? 'min' : 'max'; posAlongAxis = centroid.y / SCALE;
        } else {
            axis = 'z'; side = normal.z > 0 ? 'min' : 'max'; posAlongAxis = centroid.z / SCALE;
        }

        // Convert centroid to WT space for bounding-box check
        const cx = centroid.x / SCALE, cy = centroid.y / SCALE, cz = centroid.z / SCALE;

        // Match to the brush whose face is closest AND whose bounding box contains
        // the centroid on the tangent axes. Prefer smaller (more specific) brushes
        // when distances are equal.
        let bestFace = null, bestDist = Infinity, bestVolume = Infinity;
        for (const face of allFaces) {
            if (face.axis !== axis || face.side !== side) continue;
            const dist = Math.abs(face.pos - posAlongAxis);
            if (dist > 0.5) continue; // outside tolerance
            if (!centroidInBrush(face.brush, axis, cx, cy, cz)) continue;

            const vol = face.brush.w * face.brush.h * face.brush.d;
            if (dist < bestDist || (dist === bestDist && vol < bestVolume)) {
                bestDist = dist; bestFace = face; bestVolume = vol;
            }
        }

        if (bestFace) {
            faceIds.push({
                brushId: bestFace.brushId, axis: bestFace.axis,
                side: bestFace.side, position: bestFace.pos
            });
        } else {
            faceIds.push({
                brushId: 0, axis, side,
                position: Math.round(posAlongAxis)
            });
        }
    }
    return faceIds;
}

// ─── Three.js Scene ──────────────────────────────────────────────────

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a2e);
scene.fog = new THREE.Fog(0x1a1a2e, 12, 30);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 100);
camera.position.set(1.5, 1.0, 1.5);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

// Lighting — bright and even, no shadows
scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 0.6));
const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.9);
dirLight1.position.set(5, 10, 7);
scene.add(dirLight1);
const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.3);
dirLight2.position.set(-5, -2, -5);
scene.add(dirLight2);
scene.add(new THREE.AmbientLight(0xffffff, 0.3));

const grid = new THREE.GridHelper(20, 80, 0x333355, 0x222244);
scene.add(grid);

// ─── FPS Camera ──────────────────────────────────────────────────────

const keys = new Set();
let isLocked = false;
let mouseDX = 0, mouseDY = 0;
const euler = new THREE.Euler(0, 0, 0, 'YXZ');

document.addEventListener('keydown', e => keys.add(e.code));
document.addEventListener('keyup', e => keys.delete(e.code));

renderer.domElement.addEventListener('click', () => {
    if (!isLocked) renderer.domElement.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
    isLocked = document.pointerLockElement === renderer.domElement;
    document.getElementById('lock-prompt').style.display = isLocked ? 'none' : 'block';
    document.getElementById('crosshair').style.display = isLocked ? 'block' : 'none';
});

document.addEventListener('mousemove', e => {
    if (!isLocked) return;
    mouseDX += e.movementX;
    mouseDY += e.movementY;
});

function updateCamera(dt) {
    if (!isLocked) return;
    euler.y -= mouseDX * LOOK_SPEED;
    euler.x -= mouseDY * LOOK_SPEED;
    euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, euler.x));
    camera.quaternion.setFromEuler(euler);
    mouseDX = 0; mouseDY = 0;

    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
    const speed = MOVE_SPEED * dt;

    if (keys.has('KeyW')) camera.position.addScaledVector(forward, speed);
    if (keys.has('KeyS')) camera.position.addScaledVector(forward, -speed);
    if (keys.has('KeyA')) camera.position.addScaledVector(right, -speed);
    if (keys.has('KeyD')) camera.position.addScaledVector(right, speed);
    if (keys.has('Space')) camera.position.y += speed;
    if (keys.has('ShiftLeft') || keys.has('ShiftRight')) camera.position.y -= speed;
}

// ─── Mesh Management ─────────────────────────────────────────────────

let csgMesh = null;
let wireMesh = null;
let currentFaceIds = [];

const mainMaterial = new THREE.MeshStandardMaterial({
    color: 0x6688aa, roughness: 0.7, metalness: 0.1,
    flatShading: true, side: THREE.FrontSide,
});
const wireMaterial = new THREE.MeshBasicMaterial({
    color: 0x000000, wireframe: true, transparent: true, opacity: 0.12,
});

function rebuildCSG() {
    if (csgMesh) { scene.remove(csgMesh); csgMesh.geometry.dispose(); }
    if (wireMesh) { scene.remove(wireMesh); wireMesh.geometry.dispose(); }

    const { geometry, timeMs, faceIds } = evaluateBrushes();
    currentFaceIds = faceIds;

    csgMesh = new THREE.Mesh(geometry, mainMaterial);
    scene.add(csgMesh);
    wireMesh = new THREE.Mesh(geometry, wireMaterial);
    scene.add(wireMesh);

    const bakeInfo = totalBakedBrushes > 0 ? ` | baked: ${totalBakedBrushes}` : '';
    document.getElementById('timing').textContent =
        `CSG: ${timeMs.toFixed(1)}ms | ${faceIds.length} tris | ${brushes.length} brushes${bakeInfo}`;
}

// ─── Selection Preview (rendered every frame) ────────────────────────

let previewMesh = null;
const previewMat = new THREE.MeshBasicMaterial({
    color: 0xff6644, transparent: true, opacity: 0.35,
    side: THREE.DoubleSide, depthTest: true,
    polygonOffset: true, polygonOffsetFactor: -2,
});

function updateSelectionPreview() {
    if (previewMesh) { scene.remove(previewMesh); previewMesh.geometry.dispose(); previewMesh = null; }
    if (!selectedFace || !csgMesh || !isLocked) return;

    const faceInfo = getSelectedFaceInfo();
    if (!faceInfo) return;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const hits = raycaster.intersectObject(csgMesh);
    if (hits.length === 0) return;

    const hitFace = currentFaceIds[hits[0].faceIndex];
    if (!facesMatch(hitFace, selectedFace)) {
        // Not looking at the selected face — don't show a stale preview
        return;
    }

    const { axis } = selectedFace;
    const uv = worldToFaceUV(hits[0].point, axis);

    const sU = selSizeU <= 0 ? faceInfo.uSize : Math.min(selSizeU, faceInfo.uSize);
    const sV = selSizeV <= 0 ? faceInfo.vSize : Math.min(selSizeV, faceInfo.vSize);

    let u0 = Math.round(uv.u - sU / 2);
    let v0 = Math.round(uv.v - sV / 2);
    u0 = Math.max(faceInfo.uMin, Math.min(u0, faceInfo.uMax - sU));
    v0 = Math.max(faceInfo.vMin, Math.min(v0, faceInfo.vMax - sV));
    const u1 = u0 + sU;
    const v1 = v0 + sV;

    selU0 = u0; selU1 = u1; selV0 = v0; selV1 = v1;

    renderPreviewQuadFromUV(selectedFace, u0, u1, v0, v1);
}

function renderPreviewQuadFromUV(face, u0, u1, v0, v1) {
    const { axis, side, position } = face;
    const pos = position * SCALE;
    const offset = side === 'min' ? 0.002 : -0.002;

    let x0, x1, y0, y1, z0, z1;
    if (axis === 'x') {
        x0 = x1 = pos + offset;
        z0 = u0 * SCALE; z1 = u1 * SCALE;
        y0 = v0 * SCALE; y1 = v1 * SCALE;
    } else if (axis === 'y') {
        y0 = y1 = pos + offset;
        x0 = u0 * SCALE; x1 = u1 * SCALE;
        z0 = v0 * SCALE; z1 = v1 * SCALE;
    } else {
        z0 = z1 = pos + offset;
        x0 = u0 * SCALE; x1 = u1 * SCALE;
        y0 = v0 * SCALE; y1 = v1 * SCALE;
    }

    const positions = new Float32Array(axis === 'x' ? [
        x0, y0, z0,  x0, y1, z0,  x0, y1, z1,
        x0, y0, z0,  x0, y1, z1,  x0, y0, z1,
    ] : axis === 'y' ? [
        x0, y0, z0,  x0, y0, z1,  x1, y0, z1,
        x0, y0, z0,  x1, y0, z1,  x1, y0, z0,
    ] : [
        x0, y0, z0,  x0, y1, z0,  x1, y1, z0,
        x0, y0, z0,  x1, y1, z0,  x1, y0, z0,
    ]);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    previewMesh = new THREE.Mesh(geo, previewMat);
    scene.add(previewMesh);
}

// ─── Face Picking ────────────────────────────────────────────────────

const mainRaycaster = new THREE.Raycaster();

function pickFace() {
    mainRaycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    if (!csgMesh) return null;
    const hits = mainRaycaster.intersectObject(csgMesh);
    if (hits.length === 0) return null;
    return currentFaceIds[hits[0].faceIndex] || null;
}

// ─── Actions ─────────────────────────────────────────────────────────

function facesMatch(a, b) {
    if (!a || !b) return false;
    return a.brushId === b.brushId && a.axis === b.axis && a.side === b.side;
}

function selectFaceAtCrosshair() {
    const face = pickFace();
    if (!face) return;

    if (!facesMatch(selectedFace, face)) {
        selectedFace = face;
        selSizeU = 0;
        selSizeV = 0;
        selU0 = 0; selU1 = 0; selV0 = 0; selV1 = 0;
        activeBrush = null;
        activeOp = null;
        activeSide = null;
    }
    updateHUD();
}

function getSelectedFaceInfo() {
    if (!selectedFace) return null;
    if (selectedFace.brushId === 0) {
        return getBakedFaceUVInfo(selectedFace);
    }
    // Check brushes array first, then shell
    const brush = brushes.find(b => b.id === selectedFace.brushId)
        || (shell.id === selectedFace.brushId ? shell : null);
    if (!brush) return null;
    return getFaceUVInfo(brush, selectedFace.axis);
}

function isFullFace() {
    const info = getSelectedFaceInfo();
    if (!info) return true;
    return (selSizeU <= 0 || selSizeU >= info.uSize) &&
           (selSizeV <= 0 || selSizeV >= info.vSize);
}

function pushSelectedFace() {
    if (!selectedFace) return;

    const brush = brushes.find(b => b.id === selectedFace.brushId);
    const isBaked = selectedFace.brushId === 0;

    if (isFullFace() && brush && !isBaked) {
        // Full face push on a real brush — resize it directly (no new geometry)
        const { axis, side } = selectedFace;
        const dimKey = axis === 'x' ? 'w' : axis === 'y' ? 'h' : 'd';
        if (side === 'max') { brush[dimKey] += 1; }
        else { brush[axis] -= 1; brush[dimKey] += 1; }
        selectedFace.position = side === 'max' ? brush[axis] + brush[dimKey] : brush[axis];
        activeBrush = null;
        activeSide = null;
    } else {
        // Sub-face push OR baked face push — create/grow a subtractive brush
        if (activeBrush && activeOp === 'push') {
            growActiveBrush(1);
        } else {
            activeSide = selectedFace.side;
            activeBrush = createSubFaceBrush('subtract', 1);
            activeOp = 'push';
        }
        selectedFace = getActiveBrushOutwardFace();
        selSizeU = 0; selSizeV = 0;
    }

    updateShell();
    rebuildCSG();
    updateHUD();
}

function pullSelectedFace() {
    if (!selectedFace) return;

    const brush = brushes.find(b => b.id === selectedFace.brushId);
    const isBaked = selectedFace.brushId === 0;

    // Continue active pull operation first (must check before isFullFace,
    // because after the first pull the selected face becomes a full face
    // of the additive brush, and the full-face path would shrink it instead)
    if (activeBrush && activeOp === 'pull') {
        growActiveBrush(1);
        selectedFace = getActiveBrushInwardFace();
    } else if (isFullFace() && brush && !isBaked) {
        const { axis, side } = selectedFace;
        const dimKey = axis === 'x' ? 'w' : axis === 'y' ? 'h' : 'd';
        if (brush[dimKey] <= 1) return;
        if (side === 'max') { brush[dimKey] -= 1; }
        else { brush[axis] += 1; brush[dimKey] -= 1; }
        selectedFace.position = side === 'max' ? brush[axis] + brush[dimKey] : brush[axis];
        activeBrush = null;
        activeSide = null;
    } else {
        activeSide = selectedFace.side;
        activeBrush = createSubFaceBrush('add', 1);
        activeOp = 'pull';
        selectedFace = getActiveBrushInwardFace();
        selSizeU = 0; selSizeV = 0;
    }

    updateShell();
    rebuildCSG();
    updateHUD();
}

// ─── Extrude: Push WITH new geometry ─────────────────────────────────
// Creates a new brush from the selected face (same footprint, 1 WT deep),
// so that subsequent push/scale operates on the new section.

function extrudeSelectedFace() {
    if (!selectedFace) return;

    const brush = brushes.find(b => b.id === selectedFace.brushId);
    const isBaked = selectedFace.brushId === 0;
    const { axis, side } = selectedFace;

    // Get the full face dimensions
    let faceInfo;
    if (brush) {
        faceInfo = getFaceUVInfo(brush, axis);
    } else if (isBaked) {
        faceInfo = getBakedFaceUVInfo(selectedFace);
    }
    if (!faceInfo) return;

    const depth = 1;
    let nx, ny, nz, nw, nh, nd;

    if (axis === 'x') {
        nz = faceInfo.uMin; ny = faceInfo.vMin;
        nd = faceInfo.uSize; nh = faceInfo.vSize;
        nw = depth;
        nx = side === 'max' ? selectedFace.position : selectedFace.position - depth;
    } else if (axis === 'y') {
        nx = faceInfo.uMin; nz = faceInfo.vMin;
        nw = faceInfo.uSize; nd = faceInfo.vSize;
        nh = depth;
        ny = side === 'max' ? selectedFace.position : selectedFace.position - depth;
    } else {
        nx = faceInfo.uMin; ny = faceInfo.vMin;
        nw = faceInfo.uSize; nh = faceInfo.vSize;
        nd = depth;
        nz = side === 'max' ? selectedFace.position : selectedFace.position - depth;
    }

    const op = brush ? brush.op : 'subtract';
    const newBrush = new BrushDef(op, nx, ny, nz, nw, nh, nd);
    brushes.push(newBrush);

    activeSide = side;
    activeBrush = newBrush;
    activeOp = 'extrude';

    // Select the outward face of the new brush
    const dimKey = axis === 'x' ? 'w' : axis === 'y' ? 'h' : 'd';
    selectedFace = {
        brushId: newBrush.id, axis, side,
        position: side === 'max' ? newBrush[axis] + newBrush[dimKey] : newBrush[axis]
    };
    selSizeU = 0; selSizeV = 0;

    updateShell();
    rebuildCSG();
    updateHUD();
}

// ─── Scale Face: Taper the selected face ─────────────────────────────
// Adjusts the inset on the selected face, creating a frustum shape.
// delta > 0 = face gets smaller, delta < 0 = face gets larger

function scaleSelectedFace(deltaU, deltaV) {
    if (!selectedFace) return;

    const brush = brushes.find(b => b.id === selectedFace.brushId);
    if (!brush) return; // Can only scale faces on unbaked brushes

    const { axis, side } = selectedFace;
    const faceKey = `${axis}-${side}`;

    if (!brush.taper[faceKey]) {
        brush.taper[faceKey] = { u: 0, v: 0 };
    }

    const t = brush.taper[faceKey];
    const info = getFaceUVInfo(brush, axis);

    // Max inset: leave at least 1 WT on each dimension
    const maxU = Math.floor((info.uSize - 1) / 2);
    const maxV = Math.floor((info.vSize - 1) / 2);

    t.u = Math.max(0, Math.min(maxU, t.u + deltaU));
    t.v = Math.max(0, Math.min(maxV, t.v + deltaV));

    // Remove taper entry if both are 0
    if (t.u === 0 && t.v === 0) {
        delete brush.taper[faceKey];
    }

    rebuildCSG();
    updateHUD();
}

// ─── Brush Helpers ──────────────────────────────────────────────────

function ensureSelectionBounds() {
    // If selection bounds are uninitialized (all zero), compute from face info
    if (selU0 === 0 && selU1 === 0 && selV0 === 0 && selV1 === 0) {
        const info = getSelectedFaceInfo();
        if (info) {
            const sU = selSizeU <= 0 ? info.uSize : Math.min(selSizeU, info.uSize);
            const sV = selSizeV <= 0 ? info.vSize : Math.min(selSizeV, info.vSize);
            // Center on face
            selU0 = info.uMin + Math.round((info.uSize - sU) / 2);
            selV0 = info.vMin + Math.round((info.vSize - sV) / 2);
            selU1 = selU0 + sU;
            selV1 = selV0 + sV;
        }
    }
}

function createSubFaceBrush(op, depth) {
    ensureSelectionBounds();
    const { axis, side, position } = selectedFace;
    const facePos = position;

    let nx, ny, nz, nw, nh, nd;

    if (axis === 'x') {
        nz = selU0; ny = selV0;
        nd = selU1 - selU0; nh = selV1 - selV0;
        nw = depth;
        nx = side === 'max' ? facePos : facePos - depth;
    } else if (axis === 'y') {
        nx = selU0; nz = selV0;
        nw = selU1 - selU0; nd = selV1 - selV0;
        nh = depth;
        ny = side === 'max' ? facePos : facePos - depth;
    } else {
        nx = selU0; ny = selV0;
        nw = selU1 - selU0; nh = selV1 - selV0;
        nd = depth;
        nz = side === 'max' ? facePos : facePos - depth;
    }

    if (op === 'add') {
        if (axis === 'x') { nx = side === 'max' ? facePos - depth : facePos; }
        else if (axis === 'y') { ny = side === 'max' ? facePos - depth : facePos; }
        else { nz = side === 'max' ? facePos - depth : facePos; }
    }

    const newBrush = new BrushDef(op, nx, ny, nz, nw, nh, nd);
    brushes.push(newBrush);
    return newBrush;
}

function getActiveBrushOutwardFace() {
    if (!activeBrush || !activeSide) return selectedFace;
    const { axis } = selectedFace;
    const side = activeSide; // use original side, not flipped
    const dimKey = axis === 'x' ? 'w' : axis === 'y' ? 'h' : 'd';
    return {
        brushId: activeBrush.id, axis, side,
        position: side === 'max' ? activeBrush[axis] + activeBrush[dimKey] : activeBrush[axis]
    };
}

function getActiveBrushInwardFace() {
    if (!activeBrush || !activeSide) return selectedFace;
    const { axis } = selectedFace;
    const side = activeSide; // use original side, not flipped
    const dimKey = axis === 'x' ? 'w' : axis === 'y' ? 'h' : 'd';
    const inwardSide = side === 'max' ? 'min' : 'max';
    return {
        brushId: activeBrush.id, axis, side: inwardSide,
        position: inwardSide === 'max' ? activeBrush[axis] + activeBrush[dimKey] : activeBrush[axis]
    };
}

function growActiveBrush(amount) {
    if (!activeBrush || !activeSide) return;
    const { axis } = selectedFace;
    const side = activeSide; // use original side for consistent direction
    const dimKey = axis === 'x' ? 'w' : axis === 'y' ? 'h' : 'd';

    if (activeOp === 'push' || activeOp === 'extrude') {
        if (side === 'max') {
            activeBrush[dimKey] += amount;
        } else {
            activeBrush[axis] -= amount;
            activeBrush[dimKey] += amount;
        }
    } else {
        if (side === 'max') {
            activeBrush[axis] -= amount;
            activeBrush[dimKey] += amount;
        } else {
            activeBrush[dimKey] += amount;
        }
    }
}

// ─── Scroll Wheel → Selection Size ───────────────────────────────────

document.addEventListener('wheel', e => {
    if (!isLocked || !selectedFace) return;
    e.preventDefault();

    const info = getSelectedFaceInfo();
    if (!info) return;

    const delta = e.deltaY > 0 ? -1 : 1;

    if (e.shiftKey) {
        // Shift+scroll adjusts V (height)
        if (selSizeV <= 0) selSizeV = info.vSize;
        selSizeV = Math.max(1, Math.min(info.vSize, selSizeV + delta));
    } else {
        // Scroll adjusts U (width)
        if (selSizeU <= 0) selSizeU = info.uSize;
        selSizeU = Math.max(1, Math.min(info.uSize, selSizeU + delta));
    }

    activeBrush = null;
    activeOp = null;
    activeSide = null;

    updateHUD();
}, { passive: false });

// ─── Key Bindings ────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
    if (!isLocked) return;
    switch (e.code) {
        case 'Equal': case 'NumpadAdd':
            if (activeBrush && activeOp === 'extrude') {
                // Continue growing the extruded brush
                growActiveBrush(1);
                selectedFace = getActiveBrushOutwardFace();
                updateShell();
                rebuildCSG();
                updateHUD();
            } else {
                pushSelectedFace();
            }
            break;
        case 'Minus': case 'NumpadSubtract':
            pullSelectedFace(); break;
        case 'KeyB':
            bake(); break;
        case 'KeyE':
            extrudeSelectedFace(); break;
        case 'BracketLeft':
            // Scale face smaller: [ = uniform, shift+[ = U only, ctrl+[ = V only
            if (e.shiftKey) scaleSelectedFace(1, 0);
            else if (e.ctrlKey) { e.preventDefault(); scaleSelectedFace(0, 1); }
            else scaleSelectedFace(1, 1);
            break;
        case 'BracketRight':
            // Scale face larger
            if (e.shiftKey) scaleSelectedFace(-1, 0);
            else if (e.ctrlKey) { e.preventDefault(); scaleSelectedFace(0, -1); }
            else scaleSelectedFace(-1, -1);
            break;
    }
});

document.addEventListener('mousedown', e => {
    if (!isLocked || e.button !== 0) return;
    selectFaceAtCrosshair();
});

// ─── HUD ─────────────────────────────────────────────────────────────

function updateHUD() {
    let selText = 'None — click a face to select';
    if (selectedFace) {
        const axisLabel = { x: 'X', y: 'Y', z: 'Z' }[selectedFace.axis];
        const sideLabel = selectedFace.side === 'max' ? '+' : '-';
        selText = `Face: ${axisLabel}${sideLabel}`;

        const info = getSelectedFaceInfo();
        if (info) {
            const sU = selSizeU <= 0 ? info.uSize : selSizeU;
            const sV = selSizeV <= 0 ? info.vSize : selSizeV;
            const full = isFullFace() ? ' (full)' : '';
            const baked = selectedFace.brushId === 0 ? ' [baked]' : '';
            selText += ` | sel(${sU}×${sV})${full}${baked}`;
        }

        if (activeBrush) {
            selText += ` | ${activeOp}ing`;
        }

        // Show taper info for selected brush face
        const selBrush = brushes.find(b => b.id === selectedFace.brushId);
        if (selBrush) {
            const faceKey = `${selectedFace.axis}-${selectedFace.side}`;
            const t = selBrush.taper[faceKey];
            if (t) {
                selText += ` | taper(${t.u}, ${t.v})`;
            }
        }
    }
    document.getElementById('selection-info').textContent = selText;
}

// ─── Render Loop ─────────────────────────────────────────────────────

let lastTime = performance.now();

function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    updateCamera(dt);
    updateSelectionPreview();
    renderer.render(scene, camera);
}

// ─── Init ────────────────────────────────────────────────────────────

updateShell();
rebuildCSG();
updateHUD();
animate();

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});
