import * as THREE from 'three';
import { Evaluator, Brush as CSGBrush, ADDITION, SUBTRACTION } from 'three-bvh-csg';

// ─── Constants ───────────────────────────────────────────────────────

const SCALE = 0.25;
const MOVE_SPEED = 8;
const LOOK_SPEED = 0.002;
const WALL_THICKNESS = 1;
const WALL_SPLIT_V = 4; // WT height where lower wall meets upper wall

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
        this.isDoorframe = false;  // true for door frame brushes (zone 5 walls + zone 6 floor)
        this.isHoleFrame = false;  // true for generic hole frame brushes (zone 5 all sides)
        this.schemeKey = 'facility_white_tile'; // texture scheme for this brush
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

// Door tool state
let holeMode = false;      // T toggles hole placement mode
let holeDoor = false;      // true = door preset (floor-anchored, zone 6 floor)
const HOLE_WIDTH = 3;      // default hole width in WT
const HOLE_HEIGHT = 3;     // default hole height in WT
const DOOR_WIDTH = 3;      // door width in WT
const DOOR_HEIGHT = 7;     // door height in WT
let doorPreviewU0 = 0, doorPreviewU1 = 0, doorPreviewV0 = 0, doorPreviewV1 = 0;
let doorPreviewFace = null; // the face the door preview is on

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

// ─── Texture Loading & Material Array ────────────────────────────────

let texturedMode = false;
let textureSchemes = {};
let textureMap = new Map();

// Cached material arrays: schemeKey → [7 materials for zones 0-6]
// Zones 5,6 are shared (fixed tunnel textures) across all schemes.
const schemeMaterialCache = new Map();
let fixedTunnelWallMat = null;  // zone 5 — always stair_gradient
let fixedTunnelFloorMat = null; // zone 6 — always floor_doorframe

// Zone indices: 0=floor, 1=ceiling, 2=lower wall, 3=upper wall, 5=tunnel wall, 6=tunnel floor
async function loadTextures() {
    const resp = await fetch('../../public/textureSchemes.json');
    textureSchemes = await resp.json();

    const names = new Set();
    for (const scheme of Object.values(textureSchemes)) {
        for (const zone of Object.values(scheme.zones)) {
            if (zone.texture) names.add(zone.texture);
        }
    }

    const loader = new THREE.TextureLoader();
    const promises = [];
    for (const name of names) {
        promises.push(new Promise(resolve => {
            loader.load(`../../public/textures/${name}.bmp`, tex => {
                tex.wrapS = THREE.RepeatWrapping;
                tex.wrapT = THREE.RepeatWrapping;
                tex.magFilter = THREE.NearestFilter;
                tex.minFilter = THREE.NearestMipMapLinearFilter;
                textureMap.set(name, tex);
                resolve();
            }, undefined, () => resolve());
        }));
    }
    await Promise.all(promises);

    // Build fixed tunnel materials (never change with scheme)
    fixedTunnelWallMat = makeZoneMaterial('stair_gradient', 1.0);
    fixedTunnelFloorMat = makeZoneMaterial('floor_doorframe', 0.7);

    // Pre-build material arrays for all schemes
    for (const key of Object.keys(textureSchemes)) {
        schemeMaterialCache.set(key, buildSchemeMaterials(key));
    }
}

function makeZoneMaterial(textureName, repeat) {
    const baseTex = textureMap.get(textureName);
    if (!baseTex) return new THREE.MeshLambertMaterial({ color: 0xff00ff, side: THREE.FrontSide });
    const t = baseTex.clone();
    t.repeat.set(repeat, repeat);
    t.needsUpdate = true;
    return new THREE.MeshLambertMaterial({ map: t, side: THREE.FrontSide });
}

function buildSchemeMaterials(schemeName) {
    const scheme = textureSchemes[schemeName];
    if (!scheme) return null;

    const mats = [];
    for (let i = 0; i <= 6; i++) {
        if (i === 5) { mats.push(fixedTunnelWallMat); continue; }
        if (i === 6) { mats.push(fixedTunnelFloorMat); continue; }

        const zone = scheme.zones[String(i)];
        if (!zone || zone.texture === null) {
            const color = zone ? parseInt((zone.color || '#8B7355').slice(1), 16) : 0x8B7355;
            mats.push(new THREE.MeshLambertMaterial({ color, side: THREE.FrontSide }));
        } else {
            mats.push(makeZoneMaterial(zone.texture, zone.repeat));
        }
    }
    return mats;
}

// Get material array for a scheme (cached)
function getMaterialsForScheme(schemeName) {
    if (!schemeMaterialCache.has(schemeName)) {
        schemeMaterialCache.set(schemeName, buildSchemeMaterials(schemeName));
    }
    return schemeMaterialCache.get(schemeName);
}

// ─── Room Detection ─────────────────────────────────────────────────
// Flood fill from a brush through touching subtractive brushes,
// stopping at doorframe brushes. Returns set of brush IDs in the room.

function brushesTouching(a, b) {
    // Two brushes touch if they share a face (overlap on 2 axes, adjacent on 1)
    const axes = ['x', 'y', 'z'];
    const dims = ['w', 'h', 'd'];
    let sharedFace = false;
    for (let i = 0; i < 3; i++) {
        const aMin = a[axes[i]], aMax = a[axes[i]] + a[dims[i]];
        const bMin = b[axes[i]], bMax = b[axes[i]] + b[dims[i]];
        if (aMax === bMin || bMax === aMin) {
            // Adjacent on this axis — check overlap on other two
            let overlap = true;
            for (let j = 0; j < 3; j++) {
                if (j === i) continue;
                const a0 = a[axes[j]], a1 = a[axes[j]] + a[dims[j]];
                const b0 = b[axes[j]], b1 = b[axes[j]] + b[dims[j]];
                if (a1 <= b0 || b1 <= a0) { overlap = false; break; }
            }
            if (overlap) { sharedFace = true; break; }
        }
    }
    return sharedFace;
}

function findRoomBrushes(startBrush) {
    const room = new Set();
    const queue = [startBrush];
    room.add(startBrush.id);

    while (queue.length > 0) {
        const current = queue.pop();
        for (const other of brushes) {
            if (room.has(other.id)) continue;
            if (other.op !== 'subtract') continue;
            if (other.isDoorframe || other.isHoleFrame) continue; // frames are boundaries
            if (brushesTouching(current, other)) {
                room.add(other.id);
                queue.push(other);
            }
        }
    }
    return room;
}

function retextureRoom(schemeName) {
    if (!selectedFace || selectedFace.brushId === 0) return;
    const startBrush = brushes.find(b => b.id === selectedFace.brushId);
    if (!startBrush || startBrush.isDoorframe || startBrush.isHoleFrame) return;

    const roomIds = findRoomBrushes(startBrush);
    for (const b of brushes) {
        if (roomIds.has(b.id)) b.schemeKey = schemeName;
    }
    rebuildCSG();
}

loadTextures();

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

// ─── Post-CSG: Assign UVs and material zones to CSG output ──────────
// CSG output is a triangle soup with no UVs or zones. We classify each
// triangle by normal direction to determine its zone, then compute UVs
// from world-space positions projected onto the face's tangent plane.

function assignUVsAndZones(geometry, faceIds) {
    const pos = geometry.getAttribute('position');
    const idx = geometry.index;
    const triCount = idx ? idx.count / 3 : pos.count / 3;

    // We need per-vertex UVs. CSG may share vertices between triangles,
    // so we un-index the geometry to allow per-triangle UV assignment.
    const newPos = [];
    const newNormals = [];
    const newUVs = [];
    const newFaceIds = [];
    const triZones = [];

    const splitY = WALL_SPLIT_V * SCALE; // absolute world-space split height

    // Helper: compute UV from world position for a given face axis
    function vertexUV(v, axis, rotated = false) {
        const wx = v.x / SCALE, wy = v.y / SCALE, wz = v.z / SCALE;
        if (rotated) {
            if (axis === 'x') return [wy, wz];
            if (axis === 'z') return [wy, wx];
            return [wz, wx];
        }
        if (axis === 'x') return [wz, wy];
        if (axis === 'y') return [wx, wz];
        return [wx, wy];
    }

    // Per-triangle data: zone + schemeKey (for multi-scheme material lookup)
    const triSchemes = [];

    // Helper: emit a triangle with a given zone, axis, normal, faceId, and scheme.
    // Checks winding matches the intended normal — swaps B/C if flipped.
    const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _cross = new THREE.Vector3();
    function emitTri(pA, pB, pC, nx, ny, nz, axis, zone, faceId, schemeKey, rotated = false) {
        _e1.subVectors(pB, pA);
        _e2.subVectors(pC, pA);
        _cross.crossVectors(_e1, _e2);
        const dot = _cross.x * nx + _cross.y * ny + _cross.z * nz;
        const [vB, vC] = dot < 0 ? [pC, pB] : [pB, pC];

        triZones.push(zone);
        triSchemes.push(schemeKey);
        newFaceIds.push(faceId);
        for (const v of [pA, vB, vC]) {
            newPos.push(v.x, v.y, v.z);
            newNormals.push(nx, ny, nz);
            const [u, uv_v] = vertexUV(v, axis, rotated);
            newUVs.push(u, uv_v);
        }
    }

    // Helper: interpolate between two Vector3s at a given y
    function lerpAtY(a, b, y) {
        const t = (y - a.y) / (b.y - a.y);
        return new THREE.Vector3(
            a.x + (b.x - a.x) * t,
            y,
            a.z + (b.z - a.z) * t
        );
    }

    // Helper: interpolate between two Vector3s at a given axis value (x, y, or z)
    function lerpAtAxis(a, b, splitAxis, val) {
        const av = splitAxis === 'x' ? a.x : splitAxis === 'y' ? a.y : a.z;
        const bv = splitAxis === 'x' ? b.x : splitAxis === 'y' ? b.y : b.z;
        const t = (val - av) / (bv - av);
        return new THREE.Vector3(
            a.x + (b.x - a.x) * t,
            a.y + (b.y - a.y) * t,
            a.z + (b.z - a.z) * t
        );
    }

    // Helper: split an array of triangles along an axis=value plane.
    // Each triangle is {a, b, c} of Vector3. Returns expanded array.
    function splitTrisAtAxis(tris, splitAxis, val) {
        const result = [];
        const getVal = splitAxis === 'x' ? v => v.x : splitAxis === 'y' ? v => v.y : v => v.z;
        for (const tri of tris) {
            const verts = [tri.a, tri.b, tri.c];
            const vals = verts.map(getVal);
            const minV = Math.min(...vals), maxV = Math.max(...vals);
            if (maxV <= val + 1e-6 || minV >= val - 1e-6) {
                // Fully on one side
                result.push(tri);
                continue;
            }
            // Sort by axis value
            const sorted = verts.slice().sort((a, b) => getVal(a) - getVal(b));
            const [lo, mid, hi] = sorted;
            const pLoHi = lerpAtAxis(lo, hi, splitAxis, val);
            if (getVal(mid) <= val) {
                const pMidHi = lerpAtAxis(mid, hi, splitAxis, val);
                result.push({ a: lo, b: mid, c: pLoHi });
                result.push({ a: mid, b: pMidHi, c: pLoHi });
                result.push({ a: pLoHi, b: pMidHi, c: hi });
            } else {
                const pLoMid = lerpAtAxis(lo, mid, splitAxis, val);
                result.push({ a: lo, b: pLoMid, c: pLoHi });
                result.push({ a: pLoMid, b: mid, c: pLoHi });
                result.push({ a: mid, b: hi, c: pLoHi });
            }
        }
        return result;
    }

    // Collect frame (door + hole) 3D AABBs in world-space for boundary splitting
    const frameAABBs = brushes
        .filter(b => b.isDoorframe || b.isHoleFrame)
        .map(b => ({
            minX: b.minX * SCALE, maxX: b.maxX * SCALE,
            minY: b.minY * SCALE, maxY: b.maxY * SCALE,
            minZ: b.minZ * SCALE, maxZ: b.maxZ * SCALE,
            brush: b
        }));

    const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
    const edge1 = new THREE.Vector3(), edge2 = new THREE.Vector3();
    const normal = new THREE.Vector3();

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

        const ax = Math.abs(normal.x), ay = Math.abs(normal.y), az = Math.abs(normal.z);
        const faceId = faceIds[t] || { brushId: 0, axis: 'x', side: 'min', position: 0 };
        const nx = normal.x, ny = normal.y, nz = normal.z;

        const ownerBrush = (faceId.brushId !== 0) ? brushes.find(b => b.id === faceId.brushId) : null;
        const scheme = ownerBrush ? ownerBrush.schemeKey : 'facility_white_tile';

        if (ay >= ax && ay >= az) {
            // Floor or ceiling
            const axis = 'y';
            if (normal.y > 0) {
                // Floor — split along doorframe XZ boundaries, classify inside/outside
                let floorTris = [{ a: vA.clone(), b: vB.clone(), c: vC.clone() }];
                for (const db of frameAABBs) {
                    floorTris = splitTrisAtAxis(floorTris, 'x', db.minX);
                    floorTris = splitTrisAtAxis(floorTris, 'x', db.maxX);
                    floorTris = splitTrisAtAxis(floorTris, 'z', db.minZ);
                    floorTris = splitTrisAtAxis(floorTris, 'z', db.maxZ);
                }
                for (const tri of floorTris) {
                    const cx = (tri.a.x + tri.b.x + tri.c.x) / 3;
                    const cy = (tri.a.y + tri.b.y + tri.c.y) / 3;
                    const cz = (tri.a.z + tri.b.z + tri.c.z) / 3;
                    let dfBrush = null;
                    for (const db of frameAABBs) {
                        if (cx >= db.minX && cx <= db.maxX && cy >= db.minY && cy <= db.maxY && cz >= db.minZ && cz <= db.maxZ) {
                            dfBrush = db.brush; break;
                        }
                    }
                    if (dfBrush) {
                        const floorZone = dfBrush.isDoorframe ? 6 : 5; // door = tunnel floor, hole = wall texture
                        emitTri(tri.a, tri.b, tri.c, nx, ny, nz, axis, floorZone, faceId, scheme, dfBrush.w === WALL_THICKNESS);
                    } else {
                        emitTri(tri.a, tri.b, tri.c, nx, ny, nz, axis, 0, faceId, scheme);
                    }
                }
            } else {
                // Ceiling — split along frame XZ boundaries, classify lintel vs room ceiling
                let ceilTris = [{ a: vA.clone(), b: vB.clone(), c: vC.clone() }];
                for (const db of frameAABBs) {
                    ceilTris = splitTrisAtAxis(ceilTris, 'x', db.minX);
                    ceilTris = splitTrisAtAxis(ceilTris, 'x', db.maxX);
                    ceilTris = splitTrisAtAxis(ceilTris, 'z', db.minZ);
                    ceilTris = splitTrisAtAxis(ceilTris, 'z', db.maxZ);
                }
                for (const tri of ceilTris) {
                    const cx = (tri.a.x + tri.b.x + tri.c.x) / 3;
                    const cy = (tri.a.y + tri.b.y + tri.c.y) / 3;
                    const cz = (tri.a.z + tri.b.z + tri.c.z) / 3;
                    let dfBrush = null;
                    for (const db of frameAABBs) {
                        if (cx >= db.minX && cx <= db.maxX && cy >= db.minY && cy <= db.maxY && cz >= db.minZ && cz <= db.maxZ) {
                            dfBrush = db.brush; break;
                        }
                    }
                    if (dfBrush) {
                        emitTri(tri.a, tri.b, tri.c, nx, ny, nz, axis, 5, faceId, scheme, dfBrush.w === WALL_THICKNESS);
                    } else {
                        emitTri(tri.a, tri.b, tri.c, nx, ny, nz, axis, 1, faceId, scheme);
                    }
                }
            }
        } else {
            // Wall — split along doorframe boundaries on tangent axes, classify inside/outside
            const axis = ax >= az ? 'x' : 'z';

            let wallTris = [{ a: vA.clone(), b: vB.clone(), c: vC.clone() }];
            for (const db of frameAABBs) {
                if (axis === 'x') {
                    wallTris = splitTrisAtAxis(wallTris, 'z', db.minZ);
                    wallTris = splitTrisAtAxis(wallTris, 'z', db.maxZ);
                } else {
                    wallTris = splitTrisAtAxis(wallTris, 'x', db.minX);
                    wallTris = splitTrisAtAxis(wallTris, 'x', db.maxX);
                }
                wallTris = splitTrisAtAxis(wallTris, 'y', db.minY);
                wallTris = splitTrisAtAxis(wallTris, 'y', db.maxY);
            }
            for (const tri of wallTris) {
                const cx = (tri.a.x + tri.b.x + tri.c.x) / 3;
                const cy = (tri.a.y + tri.b.y + tri.c.y) / 3;
                const cz = (tri.a.z + tri.b.z + tri.c.z) / 3;
                let dfBrush = null;
                for (const db of frameAABBs) {
                    if (cx >= db.minX && cx <= db.maxX && cy >= db.minY && cy <= db.maxY && cz >= db.minZ && cz <= db.maxZ) {
                        dfBrush = db.brush; break;
                    }
                }
                if (dfBrush) {
                    // Frame wall — zone 5, rotate UVs only for wall-axis holes (not Y-axis)
                    const rotateWall = dfBrush.h !== WALL_THICKNESS;
                    emitTri(tri.a, tri.b, tri.c, nx, ny, nz, axis, 5, faceId, scheme, rotateWall);
                } else {
                    // Room wall — split at WALL_SPLIT_V for zone 2/3
                    const minY = Math.min(tri.a.y, tri.b.y, tri.c.y);
                    const maxY = Math.max(tri.a.y, tri.b.y, tri.c.y);

                    if (maxY <= splitY) {
                        emitTri(tri.a, tri.b, tri.c, nx, ny, nz, axis, 2, faceId, scheme);
                    } else if (minY >= splitY) {
                        emitTri(tri.a, tri.b, tri.c, nx, ny, nz, axis, 3, faceId, scheme);
                    } else {
                        // Triangle crosses the split — clip into sub-triangles
                        const verts = [tri.a, tri.b, tri.c];
                        verts.sort((a, b) => a.y - b.y);
                        const [lo, mid, hi] = verts;
                        const pLoHi = lerpAtY(lo, hi, splitY);

                        if (mid.y <= splitY) {
                            const pMidHi = lerpAtY(mid, hi, splitY);
                            emitTri(lo, mid, pLoHi, nx, ny, nz, axis, 2, faceId, scheme);
                            emitTri(mid, pMidHi, pLoHi, nx, ny, nz, axis, 2, faceId, scheme);
                            emitTri(pLoHi, pMidHi, hi, nx, ny, nz, axis, 3, faceId, scheme);
                        } else {
                            const pLoMid = lerpAtY(lo, mid, splitY);
                            emitTri(lo, pLoMid, pLoHi, nx, ny, nz, axis, 2, faceId, scheme);
                            emitTri(pLoMid, mid, pLoHi, nx, ny, nz, axis, 3, faceId, scheme);
                            emitTri(mid, hi, pLoHi, nx, ny, nz, axis, 3, faceId, scheme);
                        }
                    }
                }
            }
        }
    }

    // Build new un-indexed geometry
    const newGeo = new THREE.BufferGeometry();
    newGeo.setAttribute('position', new THREE.Float32BufferAttribute(newPos, 3));
    newGeo.setAttribute('normal', new THREE.Float32BufferAttribute(newNormals, 3));
    newGeo.setAttribute('uv', new THREE.Float32BufferAttribute(newUVs, 2));

    // Build combined material array for all schemes in use.
    // Layout: for each scheme, zones 0-3 get unique materials.
    //         Zones 5,6 are shared (fixed tunnel textures) across all schemes.
    // Material index = schemeIndex * 7 + zone
    const uniqueSchemes = [...new Set(triSchemes)].sort();
    const schemeIndexMap = {};
    const combinedMaterials = [];

    for (let si = 0; si < uniqueSchemes.length; si++) {
        schemeIndexMap[uniqueSchemes[si]] = si;
        const mats = getMaterialsForScheme(uniqueSchemes[si]);
        if (mats) {
            for (let z = 0; z <= 6; z++) combinedMaterials.push(mats[z]);
        } else {
            // Fallback: 7 magenta materials
            for (let z = 0; z <= 6; z++) {
                combinedMaterials.push(new THREE.MeshLambertMaterial({ color: 0xff00ff, side: THREE.FrontSide }));
            }
        }
    }

    // Compute material index per triangle
    const triMatIndices = triZones.map((zone, i) => {
        const si = schemeIndexMap[triSchemes[i]] || 0;
        return si * 7 + zone;
    });

    // Sort triangles by material index and emit groups
    const triOrder = triMatIndices.map((matIdx, i) => ({ matIdx, idx: i }));
    triOrder.sort((a, b) => a.matIdx - b.matIdx);

    const sortedIndices = [];
    const sortedFaceIds = [];
    for (const { idx: ti } of triOrder) {
        const base = ti * 3;
        sortedIndices.push(base, base + 1, base + 2);
        sortedFaceIds.push(newFaceIds[ti]);
    }
    newGeo.setIndex(sortedIndices);

    // Emit groups
    let groupStart = 0, currentMatIdx = triOrder[0]?.matIdx, groupCount = 0;
    for (const { matIdx } of triOrder) {
        if (matIdx !== currentMatIdx) {
            newGeo.addGroup(groupStart, groupCount, currentMatIdx);
            groupStart += groupCount;
            groupCount = 0;
            currentMatIdx = matIdx;
        }
        groupCount += 3;
    }
    if (groupCount > 0) newGeo.addGroup(groupStart, groupCount, currentMatIdx);

    return { geometry: newGeo, faceIds: sortedFaceIds, materials: combinedMaterials };
}

function rebuildCSG() {
    if (csgMesh) { scene.remove(csgMesh); csgMesh.geometry.dispose(); }
    if (wireMesh) { scene.remove(wireMesh); wireMesh.geometry.dispose(); }

    const { geometry: rawGeo, timeMs, faceIds: rawFaceIds } = evaluateBrushes();

    let finalGeo, finalFaceIds, material;

    if (texturedMode && fixedTunnelWallMat) {
        const result = assignUVsAndZones(rawGeo, rawFaceIds);
        finalGeo = result.geometry;
        finalFaceIds = result.faceIds;
        material = result.materials;
        rawGeo.dispose();
    } else {
        finalGeo = rawGeo;
        finalFaceIds = rawFaceIds;
        material = mainMaterial;
    }

    currentFaceIds = finalFaceIds;

    csgMesh = new THREE.Mesh(finalGeo, material);
    scene.add(csgMesh);

    if (texturedMode) {
        // In textured mode, use edge lines instead of wireframe mesh
        const edgesGeo = new THREE.EdgesGeometry(finalGeo, 30);
        const edgesMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.15 });
        wireMesh = new THREE.LineSegments(edgesGeo, edgesMat);
    } else {
        wireMesh = new THREE.Mesh(finalGeo, wireMaterial);
    }
    scene.add(wireMesh);

    const mode = texturedMode ? ' [textured]' : '';
    const bakeInfo = totalBakedBrushes > 0 ? ` | baked: ${totalBakedBrushes}` : '';
    document.getElementById('timing').textContent =
        `CSG: ${timeMs.toFixed(1)}ms | ${finalFaceIds.length} tris | ${brushes.length} brushes${bakeInfo}${mode}`;
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

// ─── Hole / Door Tool ───────────────────────────────────────────────
// T toggles hole mode (free-positioned rectangular cutout on any face).
// Shift+T toggles door mode (floor-anchored on walls only).
// Both create two subtractive brushes:
//   1. Frame: cuts through the wall/floor/ceiling (WALL_THICKNESS deep)
//   2. Protoroom: same footprint on the far side, user can push to expand

let holePreviewMesh = null;
const holePreviewMat = new THREE.MeshBasicMaterial({
    color: 0xffcc00, transparent: true, opacity: 0.4,
    side: THREE.DoubleSide, depthTest: true,
    polygonOffset: true, polygonOffsetFactor: -2,
});

function updateHolePreview() {
    if (holePreviewMesh) { scene.remove(holePreviewMesh); holePreviewMesh.geometry.dispose(); holePreviewMesh = null; }
    if (!holeMode || !csgMesh || !isLocked) return;

    const holeW = holeDoor ? DOOR_WIDTH : HOLE_WIDTH;
    const holeH = holeDoor ? DOOR_HEIGHT : HOLE_HEIGHT;

    // Raycast to find which face we're looking at
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const hits = raycaster.intersectObject(csgMesh);
    if (hits.length === 0) { doorPreviewFace = null; return; }

    const hitFaceId = currentFaceIds[hits[0].faceIndex];
    if (!hitFaceId) { doorPreviewFace = null; return; }

    // Door mode: walls only. Hole mode: any face.
    if (holeDoor && hitFaceId.axis === 'y') { doorPreviewFace = null; return; }

    // Get face info for bounds checking
    const brush = brushes.find(b => b.id === hitFaceId.brushId)
        || (shell.id === hitFaceId.brushId ? shell : null);
    if (!brush) { doorPreviewFace = null; return; }

    const info = getFaceUVInfo(brush, hitFaceId.axis);
    if (!info || info.uSize < holeW || info.vSize < holeH) { doorPreviewFace = null; return; }

    const uv = worldToFaceUV(hits[0].point, hitFaceId.axis);

    // Center U on crosshair, clamp to face bounds
    let u0 = Math.round(uv.u - holeW / 2);
    u0 = Math.max(info.uMin, Math.min(u0, info.uMax - holeW));
    const u1 = u0 + holeW;

    let v0, v1;
    if (holeDoor) {
        // Door: floor-anchored
        v0 = info.vMin;
        v1 = v0 + holeH;
    } else {
        // Hole: center V on crosshair, clamp to face bounds
        v0 = Math.round(uv.v - holeH / 2);
        v0 = Math.max(info.vMin, Math.min(v0, info.vMax - holeH));
        v1 = v0 + holeH;
    }

    doorPreviewU0 = u0; doorPreviewU1 = u1;
    doorPreviewV0 = v0; doorPreviewV1 = v1;
    doorPreviewFace = hitFaceId;

    // Render yellow outline
    renderHolePreviewQuad(hitFaceId, u0, u1, v0, v1);
}

function renderHolePreviewQuad(face, u0, u1, v0, v1) {
    const { axis, side, position } = face;
    const pos = position * SCALE;
    const offset = side === 'min' ? 0.003 : -0.003;

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

    let positions;
    if (axis === 'x') {
        positions = new Float32Array([
            x0, y0, z0,  x0, y1, z0,  x0, y1, z1,
            x0, y0, z0,  x0, y1, z1,  x0, y0, z1,
        ]);
    } else if (axis === 'y') {
        positions = new Float32Array([
            x0, y0, z0,  x1, y0, z0,  x1, y0, z1,
            x0, y0, z0,  x1, y0, z1,  x0, y0, z1,
        ]);
    } else {
        positions = new Float32Array([
            x0, y0, z0,  x0, y1, z0,  x1, y1, z0,
            x0, y0, z0,  x1, y1, z0,  x1, y0, z0,
        ]);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    holePreviewMesh = new THREE.Mesh(geo, holePreviewMat);
    scene.add(holePreviewMesh);
}

function confirmHolePlacement() {
    if (!doorPreviewFace) return;

    const { axis, side, position } = doorPreviewFace;
    const t = WALL_THICKNESS;
    const u0 = doorPreviewU0, u1 = doorPreviewU1;
    const v0 = doorPreviewV0, v1 = doorPreviewV1;
    const uSize = u1 - u0, vSize = v1 - v0;

    // Build frame and protoroom boxes for any axis.
    // The frame cuts through the wall (t deep along axis).
    // The protoroom sits on the far side, also t deep.
    let fx, fy, fz, fw, fh, fd;
    let px, py, pz, pw, ph, pd;

    if (axis === 'x') {
        fz = u0; fy = v0; fd = uSize; fh = vSize; fw = t;
        fx = side === 'max' ? position : position - t;
        pz = u0; py = v0; pd = uSize; ph = vSize; pw = t;
        px = side === 'max' ? position + t : position - 2 * t;
    } else if (axis === 'y') {
        fx = u0; fz = v0; fw = uSize; fd = vSize; fh = t;
        fy = side === 'max' ? position : position - t;
        px = u0; pz = v0; pw = uSize; pd = vSize; ph = t;
        py = side === 'max' ? position + t : position - 2 * t;
    } else {
        fx = u0; fy = v0; fw = uSize; fh = vSize; fd = t;
        fz = side === 'max' ? position : position - t;
        px = u0; py = v0; pw = uSize; ph = vSize; pd = t;
        pz = side === 'max' ? position + t : position - 2 * t;
    }

    const frame = new BrushDef('subtract', fx, fy, fz, fw, fh, fd);
    if (holeDoor) {
        frame.isDoorframe = true;
    } else {
        frame.isHoleFrame = true;
    }
    brushes.push(frame);

    const protoroom = new BrushDef('subtract', px, py, pz, pw, ph, pd);
    brushes.push(protoroom);

    // Exit hole mode, select protoroom far face for immediate push
    holeMode = false;
    const dimKey = axis === 'x' ? 'w' : axis === 'y' ? 'h' : 'd';
    selectedFace = {
        brushId: protoroom.id, axis, side,
        position: side === 'max' ? protoroom[axis] + protoroom[dimKey] : protoroom[axis]
    };
    selSizeU = 0; selSizeV = 0;
    activeBrush = null; activeOp = null; activeSide = null;

    updateShell();
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
        case 'KeyT':
            if (e.shiftKey) {
                // Shift+T = door mode (floor-anchored, walls only)
                holeDoor = true;
                holeMode = !holeMode;
            } else {
                // T = generic hole mode (any face, free position)
                holeDoor = false;
                holeMode = !holeMode;
            }
            if (holeMode) { activeBrush = null; activeOp = null; activeSide = null; }
            updateHUD();
            break;
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
        case 'KeyV':
            texturedMode = !texturedMode;
            rebuildCSG();
            updateHUD();
            break;
        case 'Digit1': case 'Digit2': case 'Digit3':
            if (texturedMode && selectedFace) {
                const schemeNames = Object.keys(textureSchemes);
                const idx = parseInt(e.code.slice(-1)) - 1;
                if (idx < schemeNames.length) {
                    retextureRoom(schemeNames[idx]);
                }
            }
            break;
    }
});

document.addEventListener('mousedown', e => {
    if (!isLocked || e.button !== 0) return;
    if (holeMode) {
        confirmHolePlacement();
    } else {
        selectFaceAtCrosshair();
    }
});

// ─── HUD ─────────────────────────────────────────────────────────────

function updateHUD() {
    let selText = holeMode
        ? (holeDoor ? '[DOOR MODE] Look at wall, click to place — T to cancel' : '[HOLE MODE] Look at any face, click to place — T to cancel')
        : 'None — click a face to select';
    if (!holeMode && selectedFace) {
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
    updateHolePreview();
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
