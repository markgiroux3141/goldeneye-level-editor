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
        this.clipPlanes = []; // Array of { nx, ny, nz, d } — plane normal + distance
    }

    toCSGBrush() {
        let geo;
        if (this.clipPlanes.length === 0) {
            // Fast path: no clip planes, use standard box
            geo = new THREE.BoxGeometry(this.w * SCALE, this.h * SCALE, this.d * SCALE);
            const cx = (this.x + this.w / 2) * SCALE;
            const cy = (this.y + this.h / 2) * SCALE;
            const cz = (this.z + this.d / 2) * SCALE;
            const brush = new CSGBrush(geo);
            brush.position.set(cx, cy, cz);
            brush.updateMatrixWorld();
            return brush;
        }
        // Clipped path: build geometry from clipped polygons
        geo = buildClippedGeometry(this);
        const brush = new CSGBrush(geo);
        brush.updateMatrixWorld();
        return brush;
    }

    getFaces() {
        const faces = [
            { brushId: this.id, axis: 'x', side: 'min', pos: this.x },
            { brushId: this.id, axis: 'x', side: 'max', pos: this.x + this.w },
            { brushId: this.id, axis: 'y', side: 'min', pos: this.y },
            { brushId: this.id, axis: 'y', side: 'max', pos: this.y + this.h },
            { brushId: this.id, axis: 'z', side: 'min', pos: this.z },
            { brushId: this.id, axis: 'z', side: 'max', pos: this.z + this.d },
        ];
        // Add clip-plane faces
        for (let i = 0; i < this.clipPlanes.length; i++) {
            const cp = this.clipPlanes[i];
            faces.push({
                brushId: this.id,
                type: 'clip',
                planeIndex: i,
                nx: cp.nx, ny: cp.ny, nz: cp.nz, d: cp.d
            });
        }
        return faces;
    }

    get minX() { return this.x; }  get maxX() { return this.x + this.w; }
    get minY() { return this.y; }  get maxY() { return this.y + this.h; }
    get minZ() { return this.z; }  get maxZ() { return this.z + this.d; }
}

// ─── Sutherland-Hodgman Polygon Clipping ────────────────────────────
// Clips a polygon (array of {x,y,z} vertices) against a half-plane.
// Keeps vertices on the side where dot(normal, v) + d <= 0.

function clipPolygonByPlane(polygon, nx, ny, nz, d) {
    if (polygon.length === 0) return [];
    const out = [];
    for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i];
        const b = polygon[(i + 1) % polygon.length];
        const da = nx * a.x + ny * a.y + nz * a.z + d;
        const db = nx * b.x + ny * b.y + nz * b.z + d;
        if (da <= 0) {
            // A is inside
            out.push(a);
            if (db > 0) {
                // B is outside — add intersection
                out.push(lerpVertex(a, b, da / (da - db)));
            }
        } else if (db <= 0) {
            // A is outside, B is inside — add intersection
            out.push(lerpVertex(a, b, da / (da - db)));
        }
    }
    return out;
}

function lerpVertex(a, b, t) {
    return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
    };
}

// ─── Clipped Geometry Builder ───────────────────────────────────────
// Builds a BufferGeometry from a box brush with clip planes applied.

function buildClippedGeometry(brush) {
    const x0 = brush.x * SCALE, x1 = (brush.x + brush.w) * SCALE;
    const y0 = brush.y * SCALE, y1 = (brush.y + brush.h) * SCALE;
    const z0 = brush.z * SCALE, z1 = (brush.z + brush.d) * SCALE;

    // 6 box faces as polygons (wound CCW when viewed from outside)
    let facePolygons = [
        // -X face (normal pointing -X)
        [{ x: x0, y: y0, z: z1 }, { x: x0, y: y1, z: z1 }, { x: x0, y: y1, z: z0 }, { x: x0, y: y0, z: z0 }],
        // +X face (normal pointing +X)
        [{ x: x1, y: y0, z: z0 }, { x: x1, y: y1, z: z0 }, { x: x1, y: y1, z: z1 }, { x: x1, y: y0, z: z1 }],
        // -Y face (normal pointing -Y)
        [{ x: x0, y: y0, z: z0 }, { x: x1, y: y0, z: z0 }, { x: x1, y: y0, z: z1 }, { x: x0, y: y0, z: z1 }],
        // +Y face (normal pointing +Y)
        [{ x: x0, y: y1, z: z1 }, { x: x1, y: y1, z: z1 }, { x: x1, y: y1, z: z0 }, { x: x0, y: y1, z: z0 }],
        // -Z face (normal pointing -Z)
        [{ x: x1, y: y0, z: z0 }, { x: x0, y: y0, z: z0 }, { x: x0, y: y1, z: z0 }, { x: x1, y: y1, z: z0 }],
        // +Z face (normal pointing +Z)
        [{ x: x0, y: y0, z: z1 }, { x: x1, y: y0, z: z1 }, { x: x1, y: y1, z: z1 }, { x: x0, y: y1, z: z1 }],
    ];

    // Clip each box face by all clip planes
    // Clip planes are defined in world-tile space; convert d to account for SCALE
    const scaledPlanes = brush.clipPlanes.map(cp => ({
        nx: cp.nx, ny: cp.ny, nz: cp.nz,
        d: cp.d * SCALE  // d is in WT, scale to world
    }));

    for (const sp of scaledPlanes) {
        facePolygons = facePolygons.map(poly => clipPolygonByPlane(poly, sp.nx, sp.ny, sp.nz, sp.d));
    }

    // Generate cap faces along each clip plane
    // Collect all edges that lie on the clip plane from all clipped polygons
    const capPolygons = [];
    for (const sp of scaledPlanes) {
        const capPoly = buildCapPolygon(sp, facePolygons);
        if (capPoly && capPoly.length >= 3) {
            capPolygons.push(capPoly);
        }
    }

    // Triangulate all polygons
    const triangles = [];
    const allPolygons = [...facePolygons, ...capPolygons];
    for (const poly of allPolygons) {
        if (poly.length < 3) continue;
        // Fan triangulation (works for convex polygons)
        for (let i = 1; i < poly.length - 1; i++) {
            triangles.push(poly[0], poly[i], poly[i + 1]);
        }
    }

    // Build BufferGeometry
    const positions = new Float32Array(triangles.length * 3);
    for (let i = 0; i < triangles.length; i++) {
        positions[i * 3] = triangles[i].x;
        positions[i * 3 + 1] = triangles[i].y;
        positions[i * 3 + 2] = triangles[i].z;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    return geo;
}

// Build a cap polygon for a clip plane by collecting intersection edges
function buildCapPolygon(scaledPlane, clippedFacePolygons) {
    const { nx, ny, nz, d } = scaledPlane;
    const EPS = 1e-6;

    // Collect all edges that lie on the clip plane
    const edgePoints = [];
    for (const poly of clippedFacePolygons) {
        if (poly.length < 2) continue;
        for (let i = 0; i < poly.length; i++) {
            const v = poly[i];
            const dist = nx * v.x + ny * v.y + nz * v.z + d;
            if (Math.abs(dist) < EPS) {
                edgePoints.push(v);
            }
        }
    }

    if (edgePoints.length < 3) return null;

    // Remove near-duplicate points
    const unique = [edgePoints[0]];
    for (let i = 1; i < edgePoints.length; i++) {
        const p = edgePoints[i];
        let isDup = false;
        for (const u of unique) {
            if (Math.abs(p.x - u.x) < EPS && Math.abs(p.y - u.y) < EPS && Math.abs(p.z - u.z) < EPS) {
                isDup = true; break;
            }
        }
        if (!isDup) unique.push(p);
    }

    if (unique.length < 3) return null;

    // Sort points into a convex polygon by projecting onto the clip plane's 2D space
    // Pick two tangent axes for the plane
    let uAxis, vAxis;
    if (Math.abs(ny) > Math.abs(nx) && Math.abs(ny) > Math.abs(nz)) {
        uAxis = { x: 1, y: 0, z: 0 };
    } else {
        uAxis = { x: 0, y: 1, z: 0 };
    }
    // Gram-Schmidt: make uAxis perpendicular to normal
    const dotNU = nx * uAxis.x + ny * uAxis.y + nz * uAxis.z;
    uAxis = { x: uAxis.x - nx * dotNU, y: uAxis.y - ny * dotNU, z: uAxis.z - nz * dotNU };
    const uLen = Math.sqrt(uAxis.x ** 2 + uAxis.y ** 2 + uAxis.z ** 2);
    uAxis = { x: uAxis.x / uLen, y: uAxis.y / uLen, z: uAxis.z / uLen };
    vAxis = {
        x: ny * uAxis.z - nz * uAxis.y,
        y: nz * uAxis.x - nx * uAxis.z,
        z: nx * uAxis.y - ny * uAxis.x,
    };

    // Project to 2D, compute centroid, sort by angle
    const cx = unique.reduce((s, p) => s + p.x, 0) / unique.length;
    const cy = unique.reduce((s, p) => s + p.y, 0) / unique.length;
    const cz = unique.reduce((s, p) => s + p.z, 0) / unique.length;

    unique.sort((a, b) => {
        const au = uAxis.x * (a.x - cx) + uAxis.y * (a.y - cy) + uAxis.z * (a.z - cz);
        const av = vAxis.x * (a.x - cx) + vAxis.y * (a.y - cy) + vAxis.z * (a.z - cz);
        const bu = uAxis.x * (b.x - cx) + uAxis.y * (b.y - cy) + uAxis.z * (b.z - cz);
        const bv = vAxis.x * (b.x - cx) + vAxis.y * (b.y - cy) + vAxis.z * (b.z - cz);
        return Math.atan2(av, au) - Math.atan2(bv, bu);
    });

    return unique;
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

    // Scan all triangles that belong to this baked face
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

    // Snap to grid
    uMin = Math.round(uMin / SCALE) * SCALE; // already in WT from worldToFaceUV
    // Actually worldToFaceUV divides by SCALE internally so values are in WT
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

// Active push/pull tracking
let activeBrush = null;   // the brush being grown by consecutive +/- presses
let activeOp = null;       // 'push' or 'pull'

// ─── Shell Auto-Resize ───────────────────────────────────────────────

// Track the baked geometry's bounding box so the shell can wrap it
let bakedBounds = null; // { minX, minY, minZ, maxX, maxY, maxZ } or null

function updateShell() {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    // Include baked bounds
    if (bakedBounds) {
        minX = bakedBounds.minX; minY = bakedBounds.minY; minZ = bakedBounds.minZ;
        maxX = bakedBounds.maxX; maxY = bakedBounds.maxY; maxZ = bakedBounds.maxZ;
    }

    // Include new subtractive brushes
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

// Baked brushes — consolidated into a single list entry.
// Shell stays live and is never baked. The bake just collapses all current
// brushes into one pre-evaluated CSGBrush that acts as a single "brush" in
// the evaluation chain. This keeps things simple: shell is always fresh,
// baked block is one CSG step, new brushes follow after.
let bakedCSGBrush = null;   // pre-evaluated CSGBrush of all baked interior ops
let totalBakedBrushes = 0;

function evaluateBrushes() {
    const t0 = performance.now();

    // Always start from a fresh shell
    let result = shell.toCSGBrush();

    // Apply baked operations as a single subtraction (if any)
    if (bakedCSGBrush) {
        result = csgEvaluator.evaluate(result, bakedCSGBrush, SUBTRACTION);
    }

    // Apply new brushes on top
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

    // Build the "void shape" — the union of all carved spaces.
    // We combine all subtractive brushes (rooms) via ADDITION (they're all voids),
    // and apply additive brushes (pillars/notches) via SUBTRACTION (they remove void).

    let interior = bakedCSGBrush; // start from previous bake, if any

    for (const brush of brushes) {
        const csgBrush = brush.toCSGBrush();
        if (brush.op === 'subtract') {
            // Room carving → add to the void shape
            if (!interior) {
                interior = csgBrush;
            } else {
                interior = csgEvaluator.evaluate(interior, csgBrush, ADDITION);
            }
        } else {
            // Fill/pillar → remove from the void shape
            if (interior) {
                interior = csgEvaluator.evaluate(interior, csgBrush, SUBTRACTION);
            }
        }
    }

    const bakedCount = brushes.length;
    totalBakedBrushes += bakedCount;

    bakedCSGBrush = interior;

    // Compute baked bounds from the interior geometry for shell sizing
    if (interior && interior.geometry) {
        interior.geometry.computeBoundingBox();
        const bb = interior.geometry.boundingBox;
        // Convert from world space back to WT
        bakedBounds = {
            minX: Math.round(bb.min.x / SCALE), minY: Math.round(bb.min.y / SCALE), minZ: Math.round(bb.min.z / SCALE),
            maxX: Math.round(bb.max.x / SCALE), maxY: Math.round(bb.max.y / SCALE), maxZ: Math.round(bb.max.z / SCALE),
        };
    }

    brushes.length = 0;

    // Reset selection
    selectedFace = null;
    activeBrush = null;
    activeOp = null;
    selSizeU = 0;
    selSizeV = 0;

    // Shell stays live — updateShell will be called on next operation
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

        // First try to match clip-plane faces (by normal alignment)
        let bestFace = null, bestScore = Infinity;
        for (const face of allFaces) {
            if (face.type === 'clip') {
                // Compare triangle normal with clip plane normal
                const dot = normal.x * face.nx + normal.y * face.ny + normal.z * face.nz;
                // Clip plane normal points outward from kept geometry,
                // triangle normal should be close to opposite (or same, depending on winding)
                const alignment = Math.abs(Math.abs(dot) - 1);
                if (alignment < 0.1) {
                    // Check distance of centroid to clip plane
                    const planeDist = Math.abs(face.nx * centroid.x + face.ny * centroid.y + face.nz * centroid.z + face.d * SCALE);
                    if (planeDist < bestScore && planeDist < 0.1) {
                        bestScore = planeDist;
                        bestFace = face;
                    }
                }
                continue;
            }
            if (face.axis !== axis || face.side !== side) continue;
            const dist = Math.abs(face.pos - posAlongAxis);
            if (dist < bestScore) { bestScore = dist; bestFace = face; }
        }

        if (bestFace && bestFace.type === 'clip') {
            faceIds.push({
                brushId: bestFace.brushId, type: 'clip',
                planeIndex: bestFace.planeIndex,
                nx: bestFace.nx, ny: bestFace.ny, nz: bestFace.nz, d: bestFace.d
            });
        } else if (bestFace && bestScore < 0.5) {
            faceIds.push({
                brushId: bestFace.brushId, axis: bestFace.axis,
                side: bestFace.side, position: bestFace.pos
            });
        } else {
            // No brush match — this is a baked surface. Use brushId 0.
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
    // Remove old preview
    if (previewMesh) { scene.remove(previewMesh); previewMesh.geometry.dispose(); previewMesh = null; }
    if (!selectedFace || !csgMesh || !isLocked) return;
    // Clip faces don't have axis-aligned preview
    if (selectedFace.type === 'clip') return;

    const faceInfo = getSelectedFaceInfo();
    if (!faceInfo) return;

    // Raycast to find where crosshair hits
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const hits = raycaster.intersectObject(csgMesh);
    if (hits.length === 0) return;

    // Check if we're still looking at the same face
    const hitFace = currentFaceIds[hits[0].faceIndex];
    if (!facesMatch(hitFace, selectedFace)) {
        // Still show the selection at its last position
        renderPreviewQuadFromUV(selectedFace, selU0, selU1, selV0, selV1);
        return;
    }

    const { axis } = selectedFace;
    const uv = worldToFaceUV(hits[0].point, axis);

    // Determine selection size (0 = full face)
    const sU = selSizeU <= 0 ? faceInfo.uSize : Math.min(selSizeU, faceInfo.uSize);
    const sV = selSizeV <= 0 ? faceInfo.vSize : Math.min(selSizeV, faceInfo.vSize);

    // Center on crosshair, clamp to face bounds, snap to grid
    let u0 = Math.round(uv.u - sU / 2);
    let v0 = Math.round(uv.v - sV / 2);
    u0 = Math.max(faceInfo.uMin, Math.min(u0, faceInfo.uMax - sU));
    v0 = Math.max(faceInfo.vMin, Math.min(v0, faceInfo.vMax - sV));
    const u1 = u0 + sU;
    const v1 = v0 + sV;

    // Store for push/pull to use
    selU0 = u0; selU1 = u1; selV0 = v0; selV1 = v1;

    renderPreviewQuadFromUV(selectedFace, u0, u1, v0, v1);
}

function renderPreviewQuadFromUV(face, u0, u1, v0, v1) {
    const { axis, side, position } = face;
    // Face position is in WT units — convert to world
    const pos = position * SCALE;

    // Small offset to prevent z-fighting (push slightly into the room)
    const offset = side === 'min' ? 0.002 : -0.002;

    // Convert UV bounds to world positions
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
    if (a.brushId !== b.brushId) return false;
    if (a.type === 'clip' || b.type === 'clip') {
        return a.type === b.type && a.planeIndex === b.planeIndex;
    }
    return a.axis === b.axis && a.side === b.side;
}

function selectFaceAtCrosshair() {
    const face = pickFace();
    if (!face) return;

    // If clicking a different face, reset selection size to full
    if (!facesMatch(selectedFace, face)) {
        selectedFace = face;
        selSizeU = 0; // 0 = full face
        selSizeV = 0;
        activeBrush = null;
        activeOp = null;
    }
    updateHUD();
}

// Get face UV info — works for both brush faces and baked faces (brushId 0)
function getSelectedFaceInfo() {
    if (!selectedFace || selectedFace.type === 'clip') return null;
    if (selectedFace.brushId === 0) {
        return getBakedFaceUVInfo(selectedFace);
    }
    const brush = brushes.find(b => b.id === selectedFace.brushId);
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
    if (!selectedFace || selectedFace.type === 'clip') return;

    const brush = brushes.find(b => b.id === selectedFace.brushId);
    const isBaked = selectedFace.brushId === 0;

    if (isFullFace() && brush && !isBaked) {
        // Full face push on a real brush — resize it directly
        const { axis, side } = selectedFace;
        const dimKey = axis === 'x' ? 'w' : axis === 'y' ? 'h' : 'd';
        if (side === 'max') { brush[dimKey] += 1; }
        else { brush[axis] -= 1; brush[dimKey] += 1; }
        selectedFace.position = side === 'max' ? brush[axis] + brush[dimKey] : brush[axis];
        activeBrush = null;
    } else {
        // Sub-face push OR baked face push — create/grow a subtractive brush
        if (activeBrush && activeOp === 'push') {
            growActiveBrush(1);
        } else {
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
    if (!selectedFace || selectedFace.type === 'clip') return;

    const brush = brushes.find(b => b.id === selectedFace.brushId);
    const isBaked = selectedFace.brushId === 0;

    if (isFullFace() && brush && !isBaked) {
        // Full face pull on a real brush — shrink it
        const { axis, side } = selectedFace;
        const dimKey = axis === 'x' ? 'w' : axis === 'y' ? 'h' : 'd';
        if (brush[dimKey] <= 1) return;
        if (side === 'max') { brush[dimKey] -= 1; }
        else { brush[axis] += 1; brush[dimKey] -= 1; }
        selectedFace.position = side === 'max' ? brush[axis] + brush[dimKey] : brush[axis];
        activeBrush = null;
    } else {
        // Sub-face pull OR baked face pull — create/grow an additive brush
        if (activeBrush && activeOp === 'pull') {
            growActiveBrush(1);
        } else {
            activeBrush = createSubFaceBrush('add', 1);
            activeOp = 'pull';
        }
        selectedFace = getActiveBrushInwardFace();
        selSizeU = 0; selSizeV = 0;
    }

    updateShell();
    rebuildCSG();
    updateHUD();
}

function createSubFaceBrush(op, depth) {
    const { axis, side, position } = selectedFace;

    // The face position in WT tells us where the wall surface is
    const facePos = position;

    // Map selection UV back to world coordinates
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

    // For 'add' (notch/pull), position inside the room instead of outside
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
    // The outward face of an extrusion — the face furthest from the original wall
    if (!activeBrush || !selectedFace) return selectedFace;
    const { axis, side } = selectedFace;
    const dimKey = axis === 'x' ? 'w' : axis === 'y' ? 'h' : 'd';
    return {
        brushId: activeBrush.id, axis, side,
        position: side === 'max' ? activeBrush[axis] + activeBrush[dimKey] : activeBrush[axis]
    };
}

function getActiveBrushInwardFace() {
    // The inward face of a notch — the face deepest into the room
    if (!activeBrush || !selectedFace) return selectedFace;
    const { axis, side } = selectedFace;
    const dimKey = axis === 'x' ? 'w' : axis === 'y' ? 'h' : 'd';
    // For a notch (add brush), the "interesting" face is the one facing into the room
    // which is the opposite side from the original wall
    const inwardSide = side === 'max' ? 'min' : 'max';
    return {
        brushId: activeBrush.id, axis, side: inwardSide,
        position: inwardSide === 'max' ? activeBrush[axis] + activeBrush[dimKey] : activeBrush[axis]
    };
}

function growActiveBrush(amount) {
    if (!activeBrush || !selectedFace) return;
    const { axis, side } = selectedFace;
    const dimKey = axis === 'x' ? 'w' : axis === 'y' ? 'h' : 'd';

    if (activeOp === 'push') {
        // Grow outward
        if (side === 'max') {
            activeBrush[dimKey] += amount;
        } else {
            activeBrush[axis] -= amount;
            activeBrush[dimKey] += amount;
        }
    } else {
        // Grow inward (notch gets deeper)
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

    // Initialize to full face width if not set
    if (selSizeU <= 0) selSizeU = info.uSize;

    const delta = e.deltaY > 0 ? -1 : 1; // scroll down = shrink
    selSizeU = Math.max(1, Math.min(info.uSize, selSizeU + delta));
    // selSizeV stays at 0 (full height) — only horizontal resizing

    // Reset active brush when selection changes
    activeBrush = null;
    activeOp = null;

    updateHUD();
}, { passive: false });

// ─── Clip Plane Actions ─────────────────────────────────────────────

// Current clip mode cycles through: XY-45, XZ-45, YZ-45, and diagonal
let clipModeIndex = 0;
const clipModes = [
    { label: 'Ramp +Y→+Z (45°)', fn: (b) => ({ nx: 0, ny: -1, nz: -1, d: (b.y + b.h) + (b.z + b.d) }) },
    { label: 'Ramp +Y→-Z (45°)', fn: (b) => ({ nx: 0, ny: -1, nz: 1, d: (b.y + b.h) - b.z }) },
    { label: 'Ramp +Y→+X (45°)', fn: (b) => ({ nx: -1, ny: -1, nz: 0, d: (b.x + b.w) + (b.y + b.h) }) },
    { label: 'Ramp +Y→-X (45°)', fn: (b) => ({ nx: 1, ny: -1, nz: 0, d: (b.y + b.h) - b.x }) },
    { label: 'Wedge +X→+Z (45°)', fn: (b) => ({ nx: -1, ny: 0, nz: -1, d: (b.x + b.w) + (b.z + b.d) }) },
    { label: 'Wedge +X→-Z (45°)', fn: (b) => ({ nx: -1, ny: 0, nz: 1, d: (b.x + b.w) - b.z }) },
];

function addClipPlaneToSelectedBrush() {
    if (!selectedFace) return;

    // Find the brush for the selected face
    let brush = brushes.find(b => b.id === selectedFace.brushId);
    if (!brush) {
        // If no brush selected, create a new subtractive brush from the initial room
        // so user can clip it
        return;
    }

    const mode = clipModes[clipModeIndex];
    const plane = mode.fn(brush);

    // Normalize the plane normal
    const len = Math.sqrt(plane.nx ** 2 + plane.ny ** 2 + plane.nz ** 2);
    plane.nx /= len; plane.ny /= len; plane.nz /= len;
    plane.d /= len;

    brush.clipPlanes.push(plane);

    console.log(`Added clip: ${mode.label} to brush ${brush.id}`);
    updateShell();
    rebuildCSG();
    updateHUD();
}

function cycleClipMode(delta) {
    clipModeIndex = (clipModeIndex + delta + clipModes.length) % clipModes.length;
    updateHUD();
}

function removeLastClipPlane() {
    if (!selectedFace) return;
    const brush = brushes.find(b => b.id === selectedFace.brushId);
    if (!brush || brush.clipPlanes.length === 0) return;
    brush.clipPlanes.pop();
    console.log(`Removed clip plane from brush ${brush.id}`);
    updateShell();
    rebuildCSG();
    updateHUD();
}

// ─── Key Bindings ────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
    if (!isLocked) return;
    switch (e.code) {
        case 'Equal': case 'NumpadAdd':
            pushSelectedFace(); break;
        case 'Minus': case 'NumpadSubtract':
            pullSelectedFace(); break;
        case 'KeyB':
            bake(); break;
        case 'KeyC':
            addClipPlaneToSelectedBrush(); break;
        case 'KeyX':
            removeLastClipPlane(); break;
        case 'BracketLeft':
            cycleClipMode(-1); break;
        case 'BracketRight':
            cycleClipMode(1); break;
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
        if (selectedFace.type === 'clip') {
            selText = `Face: Clip plane`;
        } else {
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
        }
        if (activeBrush) {
            selText += ` | ${activeOp}ing`;
        }
        // Show clip plane count for selected brush
        const selBrush = brushes.find(b => b.id === selectedFace.brushId);
        if (selBrush && selBrush.clipPlanes.length > 0) {
            selText += ` | clips: ${selBrush.clipPlanes.length}`;
        }
    }
    selText += ` | Clip: ${clipModes[clipModeIndex].label}`;
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
