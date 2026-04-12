import * as THREE from 'three';
import { Evaluator, Brush as CSGBrush, ADDITION, SUBTRACTION } from 'three-bvh-csg';
import { scenarios } from './scenarios.js';

// ─── Constants (matching spike/csg and main editor) ──────────────────
const SCALE = 0.25;          // 1 WT = 0.25 world units
const WALL_THICKNESS = 1;

// ─── BrushDef (minimal, extracted from spike/csg/main.js) ───────────

class BrushDef {
    constructor(id, op, x, y, z, w, h, d) {
        this.id = id;
        this.op = op;
        this.x = x; this.y = y; this.z = z;
        this.w = w; this.h = h; this.d = d;
        this.taper = {};
        this.isDoorframe = false;
        this.isHoleFrame = false;
    }

    get minX() { return this.x; }  get maxX() { return this.x + this.w; }
    get minY() { return this.y; }  get maxY() { return this.y + this.h; }
    get minZ() { return this.z; }  get maxZ() { return this.z + this.d; }

    hasTaper() { return Object.keys(this.taper).length > 0; }

    toCSGBrush() {
        const geo = new THREE.BoxGeometry(this.w * SCALE, this.h * SCALE, this.d * SCALE);
        if (this.hasTaper()) applyTaperToBoxGeo(geo, this);
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
}

function applyTaperToBoxGeo(geo, brush) {
    const pos = geo.getAttribute('position');
    const hw = brush.w * SCALE / 2;
    const hh = brush.h * SCALE / 2;
    const hd = brush.d * SCALE / 2;

    for (const [faceKey, { u: tU, v: tV }] of Object.entries(brush.taper)) {
        const [axis, side] = faceKey.split('-');
        let checkAxis, target, uAxis, vAxis;
        if (axis === 'y') {
            checkAxis = 1; target = side === 'max' ? hh : -hh;
            uAxis = 0; vAxis = 2;
        } else if (axis === 'x') {
            checkAxis = 0; target = side === 'max' ? hw : -hw;
            uAxis = 2; vAxis = 1;
        } else {
            checkAxis = 2; target = side === 'max' ? hd : -hd;
            uAxis = 0; vAxis = 1;
        }
        const getComp = (i, c) => c === 0 ? pos.getX(i) : c === 1 ? pos.getY(i) : pos.getZ(i);
        for (let i = 0; i < pos.count; i++) {
            if (Math.abs(getComp(i, checkAxis) - target) < 0.001) {
                const coords = [pos.getX(i), pos.getY(i), pos.getZ(i)];
                coords[uAxis] -= Math.sign(coords[uAxis]) * tU * SCALE;
                coords[vAxis] -= Math.sign(coords[vAxis]) * tV * SCALE;
                pos.setXYZ(i, coords[0], coords[1], coords[2]);
            }
        }
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
}

// ─── Face Map (extracted from spike/csg/main.js) ────────────────────

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

    const TOL = 0.5;
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

        const cx = centroid.x / SCALE, cy = centroid.y / SCALE, cz = centroid.z / SCALE;

        let bestFace = null, bestDist = Infinity, bestVolume = Infinity;
        for (const face of allFaces) {
            if (face.axis !== axis || face.side !== side) continue;
            const dist = Math.abs(face.pos - posAlongAxis);
            if (dist > 0.5) continue;
            if (!centroidInBrush(face.brush, axis, cx, cy, cz)) continue;
            const vol = face.brush.w * face.brush.h * face.brush.d;
            if (dist < bestDist || (dist === bestDist && vol < bestVolume)) {
                bestDist = dist; bestFace = face; bestVolume = vol;
            }
        }

        if (bestFace) {
            faceIds.push({ brushId: bestFace.brushId, axis: bestFace.axis, side: bestFace.side, position: bestFace.pos });
        } else {
            faceIds.push({ brushId: 0, axis, side, position: Math.round(posAlongAxis) });
        }
    }
    return faceIds;
}

// ─── JS CSG Evaluation (matches CSGRegion.evaluateBrushes) ──────────

const csgEvaluator = new Evaluator();

function evaluateJS(shell, brushDefs) {
    const t0 = performance.now();

    let result = shell.toCSGBrush();

    // Pre-merge optimization: consecutive subtractive runs of 3+
    let i = 0;
    while (i < brushDefs.length) {
        const brush = brushDefs[i];
        const op = brush.op === 'subtract' ? SUBTRACTION : ADDITION;

        if (op === SUBTRACTION) {
            let runEnd = i + 1;
            while (runEnd < brushDefs.length && brushDefs[runEnd].op === 'subtract') runEnd++;
            const runLen = runEnd - i;

            if (runLen >= 3) {
                let merged = brushDefs[i].toCSGBrush();
                for (let j = i + 1; j < runEnd; j++) {
                    merged = csgEvaluator.evaluate(merged, brushDefs[j].toCSGBrush(), ADDITION);
                }
                result = csgEvaluator.evaluate(result, merged, SUBTRACTION);
                i = runEnd;
                continue;
            }
        }

        result = csgEvaluator.evaluate(result, brush.toCSGBrush(), op);
        i++;
    }

    const csgMs = performance.now() - t0;

    const geometry = result.geometry;
    const allBrushes = [shell, ...brushDefs];

    const t1 = performance.now();
    const faceIds = buildFaceMap(geometry, allBrushes);
    const faceMapMs = performance.now() - t1;

    const triCount = geometry.index
        ? geometry.index.count / 3
        : geometry.getAttribute('position').count / 3;
    const vertCount = geometry.getAttribute('position').count;

    return { geometry, faceIds, csgMs, faceMapMs, triCount, vertCount };
}

// ─── WASM CSG Evaluation ────────────────────────────────────────────

let wasmModule = null;

async function loadWASM() {
    try {
        const mod = await import('./csg-wasm/pkg/csg_wasm.js');
        await mod.default();
        wasmModule = mod;
        document.getElementById('wasm-placeholder').style.display = 'none';
        document.getElementById('label-wasm').textContent = 'WASM (Rust BSP CSG)';
        console.log('WASM CSG module loaded');
        return true;
    } catch (e) {
        console.log('WASM CSG not available:', e.message);
        return false;
    }
}

function brushToJSON(b) {
    return {
        id: b.id, op: b.op,
        x: b.x, y: b.y, z: b.z,
        w: b.w, h: b.h, d: b.d,
        taper: b.taper || {},
    };
}

function evaluateWASM(shell, brushDefs) {
    if (!wasmModule) return null;

    const regionJSON = JSON.stringify({
        shell: brushToJSON(shell),
        brushes: brushDefs.map(b => brushToJSON(b)),
    });

    const t0 = performance.now();
    const result = wasmModule.evaluate_region(regionJSON, SCALE);
    const csgMs = performance.now() - t0;

    const positions = result.get_positions();
    const normals = result.get_normals();
    const indices = result.get_indices();
    const triCount = result.tri_count();
    const vertCount = result.vert_count();

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    result.free();

    // Face map still runs in JS (Phase 2 would move this to WASM)
    const allBrushes = [shell, ...brushDefs];
    const t1 = performance.now();
    const faceIds = buildFaceMap(geometry, allBrushes);
    const faceMapMs = performance.now() - t1;

    return { geometry, faceIds, csgMs, faceMapMs, triCount, vertCount };
}

// ─── Scenario → BrushDef conversion ─────────────────────────────────

function scenarioToBrushDefs(scenario) {
    const s = scenario.shell;
    const shell = new BrushDef(-1, 'add', s.x, s.y, s.z, s.w, s.h, s.d);

    const brushDefs = scenario.brushes.map((b, i) => {
        const def = new BrushDef(i + 1, b.op, b.x, b.y, b.z, b.w, b.h, b.d);
        if (b.taper) def.taper = b.taper;
        if (b.isDoorframe) def.isDoorframe = true;
        if (b.isHoleFrame) def.isHoleFrame = true;
        return def;
    });

    return { shell, brushDefs };
}

// ─── Three.js Viewer Setup ──────────────────────────────────────────

function createViewer(canvas) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e);

    const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 100);

    // Lighting
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 0.6));
    const dir1 = new THREE.DirectionalLight(0xffffff, 0.9);
    dir1.position.set(5, 10, 7);
    scene.add(dir1);
    const dir2 = new THREE.DirectionalLight(0xffffff, 0.3);
    dir2.position.set(-5, -2, -5);
    scene.add(dir2);
    scene.add(new THREE.AmbientLight(0xffffff, 0.3));

    const grid = new THREE.GridHelper(20, 80, 0x333355, 0x222244);
    scene.add(grid);

    let currentMesh = null;
    let currentWire = null;

    return {
        renderer, scene, camera,

        setGeometry(geometry, color) {
            if (currentMesh) { scene.remove(currentMesh); currentMesh.geometry.dispose(); }
            if (currentWire) { scene.remove(currentWire); currentWire.geometry.dispose(); }

            const mat = new THREE.MeshStandardMaterial({
                color, side: THREE.DoubleSide, flatShading: true,
                vertexColors: false, roughness: 0.8, metalness: 0.1,
            });
            currentMesh = new THREE.Mesh(geometry, mat);
            scene.add(currentMesh);

            const edges = new THREE.EdgesGeometry(geometry, 20);
            currentWire = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x000000, opacity: 0.3, transparent: true }));
            scene.add(currentWire);

            // Auto-frame camera
            const box = new THREE.Box3().setFromObject(currentMesh);
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z);
            const dist = maxDim * 1.8;
            camera.position.set(center.x + dist * 0.6, center.y + dist * 0.5, center.z + dist * 0.6);
            camera.lookAt(center);
        },

        resize(w, h) {
            renderer.setSize(w, h, false);
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
        },

        render() {
            renderer.render(scene, camera);
        },

        // Orbit the camera slowly
        orbit(time) {
            if (!currentMesh) return;
            const box = new THREE.Box3().setFromObject(currentMesh);
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z);
            const dist = maxDim * 1.8;
            const angle = time * 0.0003;
            camera.position.set(
                center.x + Math.cos(angle) * dist * 0.7,
                center.y + dist * 0.45,
                center.z + Math.sin(angle) * dist * 0.7
            );
            camera.lookAt(center);
        },
    };
}

// ─── Results Display ────────────────────────────────────────────────

const resultsBody = document.getElementById('results-body');
const historyList = document.getElementById('history-list');

function displayResults(scenarioName, jsResult, wasmResult) {
    resultsBody.innerHTML = '';

    const rows = [
        ['CSG eval', fmt(jsResult.csgMs, 'ms'), wasmResult ? fmt(wasmResult.csgMs, 'ms') : '—', jsResult.csgMs, wasmResult?.csgMs],
        ['Face map', fmt(jsResult.faceMapMs, 'ms'), wasmResult ? fmt(wasmResult.faceMapMs, 'ms') : '—', jsResult.faceMapMs, wasmResult?.faceMapMs],
        ['Total', fmt(jsResult.csgMs + jsResult.faceMapMs, 'ms'), wasmResult ? fmt(wasmResult.csgMs + wasmResult.faceMapMs, 'ms') : '—', jsResult.csgMs + jsResult.faceMapMs, wasmResult ? wasmResult.csgMs + wasmResult.faceMapMs : null],
        ['Triangles', jsResult.triCount, wasmResult ? wasmResult.triCount : '—', null, null],
        ['Vertices', jsResult.vertCount, wasmResult ? wasmResult.vertCount : '—', null, null],
        ['Face IDs', jsResult.faceIds.length, wasmResult ? wasmResult.faceIds.length : '—', null, null],
    ];

    for (const [label, jsVal, wasmVal, jsNum, wasmNum] of rows) {
        const tr = document.createElement('tr');
        const speedup = (jsNum != null && wasmNum != null && wasmNum > 0)
            ? (jsNum / wasmNum)
            : null;
        const speedupStr = speedup != null
            ? `${speedup.toFixed(1)}x`
            : '—';
        const speedupClass = speedup == null ? 'neutral' : speedup > 1 ? 'faster' : 'slower';

        tr.innerHTML = `
            <td>${label}</td>
            <td class="num">${jsVal}</td>
            <td class="num">${wasmVal}</td>
            <td class="num ${speedupClass}">${speedupStr}</td>
        `;
        resultsBody.appendChild(tr);
    }

    // Add to history
    const entry = document.createElement('div');
    entry.className = 'run-entry';
    const total = jsResult.csgMs + jsResult.faceMapMs;
    entry.innerHTML = `
        <span class="label">${scenarioName}</span> —
        JS: ${fmt(total, 'ms')} (${jsResult.triCount} tris)
        ${wasmResult ? `| WASM: ${fmt(wasmResult.csgMs + wasmResult.faceMapMs, 'ms')}` : ''}
    `;
    historyList.prepend(entry);
}

function fmt(val, unit) {
    return typeof val === 'number' ? `${val.toFixed(2)} ${unit}` : val;
}

// ─── Benchmark Runner ───────────────────────────────────────────────

const WARMUP_RUNS = 2;
const BENCH_RUNS = 5;

function runBenchmark(scenario) {
    const { shell, brushDefs } = scenarioToBrushDefs(scenario);

    // Warmup — let BVH caches settle
    for (let i = 0; i < WARMUP_RUNS; i++) evaluateJS(shell, brushDefs);

    // Timed runs
    const jsRuns = [];
    let lastResult = null;
    for (let i = 0; i < BENCH_RUNS; i++) {
        lastResult = evaluateJS(shell, brushDefs);
        jsRuns.push({ csgMs: lastResult.csgMs, faceMapMs: lastResult.faceMapMs });
    }

    // Use median of timed runs
    jsRuns.sort((a, b) => (a.csgMs + a.faceMapMs) - (b.csgMs + b.faceMapMs));
    const median = jsRuns[Math.floor(jsRuns.length / 2)];
    const jsResult = {
        ...lastResult,
        csgMs: median.csgMs,
        faceMapMs: median.faceMapMs,
    };

    // WASM path
    let wasmResult = null;
    if (wasmModule) {
        // Warmup
        for (let i = 0; i < WARMUP_RUNS; i++) evaluateWASM(shell, brushDefs);

        const wasmRuns = [];
        let lastWasm = null;
        for (let i = 0; i < BENCH_RUNS; i++) {
            lastWasm = evaluateWASM(shell, brushDefs);
            if (lastWasm) wasmRuns.push({ csgMs: lastWasm.csgMs, faceMapMs: lastWasm.faceMapMs });
        }

        if (wasmRuns.length > 0) {
            wasmRuns.sort((a, b) => (a.csgMs + a.faceMapMs) - (b.csgMs + b.faceMapMs));
            const wMedian = wasmRuns[Math.floor(wasmRuns.length / 2)];
            wasmResult = { ...lastWasm, csgMs: wMedian.csgMs, faceMapMs: wMedian.faceMapMs };
        }
    }

    return { jsResult, wasmResult };
}

// ─── Init ───────────────────────────────────────────────────────────

const canvasJS = document.getElementById('canvas-js');
const canvasWASM = document.getElementById('canvas-wasm');
const viewerJS = createViewer(canvasJS);
const viewerWASM = createViewer(canvasWASM);

const select = document.getElementById('scenario-select');
const btnRun = document.getElementById('btn-run');
const btnRunAll = document.getElementById('btn-run-all');
const statusEl = document.getElementById('status');

// Populate scenario dropdown
for (let i = 0; i < scenarios.length; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `${i + 1}. ${scenarios[i].name}`;
    select.appendChild(opt);
}

// Resize viewers
function resizeViewers() {
    const container = document.getElementById('viewers');
    const w = container.clientWidth;
    const h = Math.floor((container.clientHeight - 1) / 2); // -1 for divider
    viewerJS.resize(w, h);
    viewerWASM.resize(w, h);
}
window.addEventListener('resize', resizeViewers);
resizeViewers();

// Run single benchmark
btnRun.addEventListener('click', () => {
    const idx = parseInt(select.value);
    const scenario = scenarios[idx];
    statusEl.textContent = `Running: ${scenario.name}...`;

    // Defer to allow UI update
    requestAnimationFrame(() => {
        const { jsResult, wasmResult } = runBenchmark(scenario);

        viewerJS.setGeometry(jsResult.geometry, 0x6699cc);
        if (wasmResult) {
            viewerWASM.setGeometry(wasmResult.geometry, 0xcc8844);
        } else {
            // Mirror JS result in bottom viewer (for visual reference)
            viewerWASM.setGeometry(jsResult.geometry.clone(), 0x886644);
        }

        displayResults(scenario.name, jsResult, wasmResult);
        statusEl.textContent = `Done: ${scenario.name} — JS ${fmt(jsResult.csgMs + jsResult.faceMapMs, 'ms')}`;
    });
});

// Run all benchmarks
btnRunAll.addEventListener('click', async () => {
    btnRunAll.disabled = true;
    for (let i = 0; i < scenarios.length; i++) {
        const scenario = scenarios[i];
        select.value = i;
        statusEl.textContent = `Running ${i + 1}/${scenarios.length}: ${scenario.name}...`;

        // Yield to UI
        await new Promise(r => requestAnimationFrame(r));
        await new Promise(r => setTimeout(r, 50));

        const { jsResult, wasmResult } = runBenchmark(scenario);

        viewerJS.setGeometry(jsResult.geometry, 0x6699cc);
        if (wasmResult) {
            viewerWASM.setGeometry(wasmResult.geometry, 0xcc8844);
        } else {
            viewerWASM.setGeometry(jsResult.geometry.clone(), 0x886644);
        }

        displayResults(scenario.name, jsResult, wasmResult);
    }
    statusEl.textContent = `All ${scenarios.length} scenarios complete`;
    btnRunAll.disabled = false;
});

// Attempt WASM load
loadWASM();

// Render loop with orbit
function animate(time) {
    requestAnimationFrame(animate);
    viewerJS.orbit(time);
    viewerWASM.orbit(time);
    viewerJS.render();
    viewerWASM.render();
}
animate(0);

// Auto-run first scenario on load
requestAnimationFrame(() => {
    btnRun.click();
});
