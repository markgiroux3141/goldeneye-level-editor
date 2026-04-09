// csgActions — stateful action handlers for the CSG brush system.
// Ported from spike/csg/main.js (lines ~1097-1575 + helper functions).
//
// All actions read/write state.csg and call rebuildAllCSG when geometry changes.
// Selection state lives in state.csg.selectedFace (with regionId added).
//
// Helpers (worldToFaceUV, getFaceUVInfo, getBakedFaceUVInfo, facesMatch) are
// inlined here to keep the action module self-contained.

import * as THREE from 'three';
import { state } from '../state.js';
import { BrushDef } from '../core/BrushDef.js';
import { csgRegionMeshes, rebuildAllCSG } from '../mesh/csgMesh.js';
import { findRoomBrushes } from '../core/csg/regions.js';
import { WORLD_SCALE, WALL_THICKNESS, WALL_SPLIT_V } from '../core/constants.js';

// ─── Constants ──────────────────────────────────────────────────────
const HOLE_WIDTH = 3;
const HOLE_HEIGHT = 3;
const DOOR_WIDTH = 3;
const DOOR_HEIGHT = 7;

// ─── Helpers ────────────────────────────────────────────────────────

export function facesMatch(a, b) {
    if (!a || !b) return false;
    return a.brushId === b.brushId && a.axis === b.axis && a.side === b.side;
}

// Get the per-face U/V bounds for a brush face
export function getFaceUVInfo(brush, axis) {
    if (axis === 'x') return { uMin: brush.z, uMax: brush.z + brush.d, vMin: brush.y, vMax: brush.y + brush.h, uSize: brush.d, vSize: brush.h };
    if (axis === 'y') return { uMin: brush.x, uMax: brush.x + brush.w, vMin: brush.z, vMax: brush.z + brush.d, uSize: brush.w, vSize: brush.d };
    return              { uMin: brush.x, uMax: brush.x + brush.w, vMin: brush.y, vMax: brush.y + brush.h, uSize: brush.w, vSize: brush.h };
}

// Convert a world-space hit point to face-local U,V (in WT units)
export function worldToFaceUV(hitPoint, axis) {
    const p = { x: hitPoint.x / WORLD_SCALE, y: hitPoint.y / WORLD_SCALE, z: hitPoint.z / WORLD_SCALE };
    if (axis === 'x') return { u: p.z, v: p.y };
    if (axis === 'y') return { u: p.x, v: p.z };
    return              { u: p.x, v: p.y };
}

// Compute U/V bounds for a baked face by scanning the region's mesh geometry.
// Used when the selected face has brushId === 0 (no matching brush — it lives
// in the baked CSG geometry).
export function getBakedFaceUVInfo(face) {
    if (face.regionId == null) return null;
    const data = csgRegionMeshes.get(face.regionId);
    if (!data) return null;

    const { mesh, faceIds } = data;
    const pos = mesh.geometry.getAttribute('position');
    const idx = mesh.geometry.index;
    if (!pos) return null;

    const { axis, side, position } = face;
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    const v = new THREE.Vector3();

    for (let i = 0; i < faceIds.length; i++) {
        const f = faceIds[i];
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

// Look up a brush by id, falling back to the region's shell.
export function findBrushById(brushId, regionId) {
    if (brushId === 0) return null; // baked
    const userBrush = state.csg.brushes.find(b => b.id === brushId);
    if (userBrush) return userBrush;
    if (regionId != null) {
        const data = csgRegionMeshes.get(regionId);
        if (data && data.region.shell.id === brushId) return data.region.shell;
    }
    return null;
}

export function getSelectedFaceInfo() {
    const sel = state.csg.selectedFace;
    if (!sel) return null;
    if (sel.brushId === 0) return getBakedFaceUVInfo(sel);
    const brush = findBrushById(sel.brushId, sel.regionId);
    if (!brush) return null;
    return getFaceUVInfo(brush, sel.axis);
}

export function isFullFace() {
    const info = getSelectedFaceInfo();
    if (!info) return true;
    const { selSizeU, selSizeV } = state.csg;
    return (selSizeU <= 0 || selSizeU >= info.uSize) &&
           (selSizeV <= 0 || selSizeV >= info.vSize);
}

// ─── Selection ──────────────────────────────────────────────────────

// Called by indoorClick when the user clicks while CSG tool is active.
// `face` is the result of pickCSGFace: { regionId, brushId, axis, side, position, point }
export function selectFaceAtCrosshair(face) {
    if (!face) return;

    if (!facesMatch(state.csg.selectedFace, face)) {
        state.csg.selectedFace = face;
        state.csg.selSizeU = 0;
        state.csg.selSizeV = 0;
        state.csg.selU0 = 0; state.csg.selU1 = 0; state.csg.selV0 = 0; state.csg.selV1 = 0;
        state.csg.activeBrush = null;
        state.csg.activeOp = null;
        state.csg.activeSide = null;
    }
}

// Adjust the selection rectangle size on the current face (scroll wheel)
export function adjustSelectionSize(deltaU, deltaV) {
    if (!state.csg.selectedFace) return;
    const info = getSelectedFaceInfo();
    if (!info) return;

    if (deltaU !== 0) {
        if (state.csg.selSizeU <= 0) state.csg.selSizeU = info.uSize;
        state.csg.selSizeU = Math.max(1, Math.min(info.uSize, state.csg.selSizeU + deltaU));
    }
    if (deltaV !== 0) {
        if (state.csg.selSizeV <= 0) state.csg.selSizeV = info.vSize;
        state.csg.selSizeV = Math.max(1, Math.min(info.vSize, state.csg.selSizeV + deltaV));
    }
    state.csg.activeBrush = null;
    state.csg.activeOp = null;
    state.csg.activeSide = null;
}

// ─── Push / Pull / Extrude ───────────────────────────────────────────

function ensureSelectionBounds() {
    const csg = state.csg;
    if (csg.selU0 === 0 && csg.selU1 === 0 && csg.selV0 === 0 && csg.selV1 === 0) {
        const info = getSelectedFaceInfo();
        if (info) {
            const sU = csg.selSizeU <= 0 ? info.uSize : Math.min(csg.selSizeU, info.uSize);
            const sV = csg.selSizeV <= 0 ? info.vSize : Math.min(csg.selSizeV, info.vSize);
            csg.selU0 = info.uMin + Math.round((info.uSize - sU) / 2);
            csg.selV0 = info.vMin + Math.round((info.vSize - sV) / 2);
            csg.selU1 = csg.selU0 + sU;
            csg.selV1 = csg.selV0 + sV;
        }
    }
}

function createSubFaceBrush(op, depth) {
    ensureSelectionBounds();
    const sel = state.csg.selectedFace;
    const { axis, side, position } = sel;
    const facePos = position;
    const { selU0, selU1, selV0, selV1 } = state.csg;

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

    const newBrush = new BrushDef(state.csg.nextBrushId++, op, nx, ny, nz, nw, nh, nd);
    state.csg.brushes.push(newBrush);
    return newBrush;
}

function getActiveBrushOutwardFace() {
    const csg = state.csg;
    if (!csg.activeBrush || !csg.activeSide) return csg.selectedFace;
    const { axis, regionId } = csg.selectedFace;
    const side = csg.activeSide;
    const dimKey = axis === 'x' ? 'w' : axis === 'y' ? 'h' : 'd';
    return {
        regionId,
        brushId: csg.activeBrush.id, axis, side,
        position: side === 'max' ? csg.activeBrush[axis] + csg.activeBrush[dimKey] : csg.activeBrush[axis]
    };
}

function getActiveBrushInwardFace() {
    const csg = state.csg;
    if (!csg.activeBrush || !csg.activeSide) return csg.selectedFace;
    const { axis, regionId } = csg.selectedFace;
    const side = csg.activeSide;
    const dimKey = axis === 'x' ? 'w' : axis === 'y' ? 'h' : 'd';
    const inwardSide = side === 'max' ? 'min' : 'max';
    return {
        regionId,
        brushId: csg.activeBrush.id, axis, side: inwardSide,
        position: inwardSide === 'max' ? csg.activeBrush[axis] + csg.activeBrush[dimKey] : csg.activeBrush[axis]
    };
}

function growActiveBrush(amount) {
    const csg = state.csg;
    if (!csg.activeBrush || !csg.activeSide) return;
    const { axis } = csg.selectedFace;
    const side = csg.activeSide;
    const dimKey = axis === 'x' ? 'w' : axis === 'y' ? 'h' : 'd';

    if (csg.activeOp === 'push' || csg.activeOp === 'extrude') {
        if (side === 'max') {
            csg.activeBrush[dimKey] += amount;
        } else {
            csg.activeBrush[axis] -= amount;
            csg.activeBrush[dimKey] += amount;
            if (axis === 'y') csg.activeBrush.floorY = csg.activeBrush.y;
        }
    } else {
        if (side === 'max') {
            csg.activeBrush[axis] -= amount;
            csg.activeBrush[dimKey] += amount;
            if (axis === 'y') csg.activeBrush.floorY = csg.activeBrush.y;
        } else {
            csg.activeBrush[dimKey] += amount;
        }
    }
}

export function pushSelectedFace() {
    const csg = state.csg;
    if (!csg.selectedFace) return;

    const sel = csg.selectedFace;
    const brush = state.csg.brushes.find(b => b.id === sel.brushId);
    const isBaked = sel.brushId === 0;

    if (isFullFace() && brush && !isBaked) {
        // Full-face push on a real brush — resize directly
        const { axis, side } = sel;
        const dimKey = axis === 'x' ? 'w' : axis === 'y' ? 'h' : 'd';
        if (side === 'max') { brush[dimKey] += 1; }
        else { brush[axis] -= 1; brush[dimKey] += 1; }
        if (axis === 'y' && side === 'min') brush.floorY = brush.y;
        sel.position = side === 'max' ? brush[axis] + brush[dimKey] : brush[axis];
        csg.activeBrush = null;
        csg.activeSide = null;
    } else {
        // Sub-face push or baked-face push — create/grow a subtractive brush
        if (csg.activeBrush && csg.activeOp === 'push') {
            growActiveBrush(1);
        } else {
            csg.activeSide = sel.side;
            csg.activeBrush = createSubFaceBrush('subtract', 1);
            csg.activeOp = 'push';
        }
        csg.selectedFace = getActiveBrushOutwardFace();
        csg.selSizeU = 0; csg.selSizeV = 0;
    }

    rebuildAllCSG();
}

export function pullSelectedFace() {
    const csg = state.csg;
    if (!csg.selectedFace) return;

    const sel = csg.selectedFace;
    const brush = state.csg.brushes.find(b => b.id === sel.brushId);
    const isBaked = sel.brushId === 0;

    if (csg.activeBrush && csg.activeOp === 'pull') {
        growActiveBrush(1);
        csg.selectedFace = getActiveBrushInwardFace();
    } else if (isFullFace() && brush && !isBaked) {
        const { axis, side } = sel;
        const dimKey = axis === 'x' ? 'w' : axis === 'y' ? 'h' : 'd';
        if (brush[dimKey] <= 1) return;
        if (side === 'max') { brush[dimKey] -= 1; }
        else { brush[axis] += 1; brush[dimKey] -= 1; }
        if (axis === 'y' && side === 'min') brush.floorY = brush.y;
        sel.position = side === 'max' ? brush[axis] + brush[dimKey] : brush[axis];
        csg.activeBrush = null;
        csg.activeSide = null;
    } else {
        csg.activeSide = sel.side;
        csg.activeBrush = createSubFaceBrush('add', 1);
        csg.activeOp = 'pull';
        csg.selectedFace = getActiveBrushInwardFace();
        csg.selSizeU = 0; csg.selSizeV = 0;
    }

    rebuildAllCSG();
}

export function extrudeSelectedFace() {
    const csg = state.csg;
    if (!csg.selectedFace) return;

    const sel = csg.selectedFace;
    const brush = state.csg.brushes.find(b => b.id === sel.brushId);
    const isBaked = sel.brushId === 0;
    const { axis, side, regionId } = sel;

    let faceInfo;
    if (brush) faceInfo = getFaceUVInfo(brush, axis);
    else if (isBaked) faceInfo = getBakedFaceUVInfo(sel);
    if (!faceInfo) return;

    const depth = 1;
    let nx, ny, nz, nw, nh, nd;

    if (axis === 'x') {
        nz = faceInfo.uMin; ny = faceInfo.vMin;
        nd = faceInfo.uSize; nh = faceInfo.vSize;
        nw = depth;
        nx = side === 'max' ? sel.position : sel.position - depth;
    } else if (axis === 'y') {
        nx = faceInfo.uMin; nz = faceInfo.vMin;
        nw = faceInfo.uSize; nd = faceInfo.vSize;
        nh = depth;
        ny = side === 'max' ? sel.position : sel.position - depth;
    } else {
        nx = faceInfo.uMin; ny = faceInfo.vMin;
        nw = faceInfo.uSize; nh = faceInfo.vSize;
        nd = depth;
        nz = side === 'max' ? sel.position : sel.position - depth;
    }

    const op = brush ? brush.op : 'subtract';
    const newBrush = new BrushDef(csg.nextBrushId++, op, nx, ny, nz, nw, nh, nd);
    csg.brushes.push(newBrush);

    csg.activeSide = side;
    csg.activeBrush = newBrush;
    csg.activeOp = 'extrude';

    const dimKey = axis === 'x' ? 'w' : axis === 'y' ? 'h' : 'd';
    csg.selectedFace = {
        regionId,
        brushId: newBrush.id, axis, side,
        position: side === 'max' ? newBrush[axis] + newBrush[dimKey] : newBrush[axis]
    };
    csg.selSizeU = 0; csg.selSizeV = 0;

    rebuildAllCSG();
}

// Continue an active extrude (called when user presses + after extrude)
export function growActiveExtrude() {
    const csg = state.csg;
    if (!csg.activeBrush || csg.activeOp !== 'extrude') return false;
    growActiveBrush(1);
    csg.selectedFace = getActiveBrushOutwardFace();
    rebuildAllCSG();
    return true;
}

export function scaleSelectedFace(deltaU, deltaV) {
    const csg = state.csg;
    if (!csg.selectedFace) return;
    const sel = csg.selectedFace;

    const brush = state.csg.brushes.find(b => b.id === sel.brushId);
    if (!brush) return; // can only taper unbaked brushes

    const { axis, side } = sel;
    const faceKey = `${axis}-${side}`;

    if (!brush.taper[faceKey]) brush.taper[faceKey] = { u: 0, v: 0 };
    const t = brush.taper[faceKey];
    const info = getFaceUVInfo(brush, axis);

    const maxU = Math.floor((info.uSize - 1) / 2);
    const maxV = Math.floor((info.vSize - 1) / 2);
    t.u = Math.max(0, Math.min(maxU, t.u + deltaU));
    t.v = Math.max(0, Math.min(maxV, t.v + deltaV));

    if (t.u === 0 && t.v === 0) delete brush.taper[faceKey];

    rebuildAllCSG();
}

// ─── Hole / Door Modal Tool ──────────────────────────────────────────

// Legacy: true toggle. No callers remain after the Numpad-tool refactor;
// kept in case future code needs the toggle semantic.
export function toggleHoleMode(door) {
    const csg = state.csg;
    csg.holeDoor = !!door;
    csg.holeMode = !csg.holeMode;
    if (csg.holeMode) {
        csg.activeBrush = null;
        csg.activeOp = null;
        csg.activeSide = null;
    } else {
        csg.doorPreview = null;
    }
}

// Explicit setter — no toggle. Used by Numpad2/Numpad3 hotkeys and by the
// radial menu Hole/Door entries so the user can transition between modes
// without flicker (e.g. Hole → Door without canceling first).
export function setHoleMode(on, door) {
    const csg = state.csg;
    csg.holeMode = !!on;
    csg.holeDoor = !!door;
    csg.doorPreview = null;
    if (on) {
        csg.activeBrush = null;
        csg.activeOp = null;
        csg.activeSide = null;
    }
}

export function exitHoleMode() {
    state.csg.holeMode = false;
    state.csg.doorPreview = null;
}

// Compute the hole/door preview rectangle on the face under the crosshair.
// Called by csgPreviews.js each frame to update the yellow outline.
// Returns the preview shape or null if the face is unsuitable.
export function computeHolePreview(hitFace, hitPoint) {
    const csg = state.csg;
    if (!csg.holeMode || !hitFace || !hitPoint) return null;

    const holeW = csg.holeDoor ? DOOR_WIDTH : HOLE_WIDTH;
    const holeH = csg.holeDoor ? DOOR_HEIGHT : HOLE_HEIGHT;

    // Door mode: walls only
    if (csg.holeDoor && hitFace.axis === 'y') return null;

    const brush = findBrushById(hitFace.brushId, hitFace.regionId);
    if (!brush) return null;

    const info = getFaceUVInfo(brush, hitFace.axis);
    if (!info || info.uSize < holeW || info.vSize < holeH) return null;

    const uv = worldToFaceUV(hitPoint, hitFace.axis);

    let u0 = Math.round(uv.u - holeW / 2);
    u0 = Math.max(info.uMin, Math.min(u0, info.uMax - holeW));
    const u1 = u0 + holeW;

    let v0, v1;
    if (csg.holeDoor) {
        v0 = info.vMin;
        v1 = v0 + holeH;
    } else {
        v0 = Math.round(uv.v - holeH / 2);
        v0 = Math.max(info.vMin, Math.min(v0, info.vMax - holeH));
        v1 = v0 + holeH;
    }

    csg.doorPreview = { face: hitFace, u0, u1, v0, v1 };
    return csg.doorPreview;
}

export function confirmHolePlacement() {
    const csg = state.csg;
    if (!csg.doorPreview) return;

    const { face, u0, u1, v0, v1 } = csg.doorPreview;
    const { axis, side, position, regionId } = face;
    const t = WALL_THICKNESS;
    const uSize = u1 - u0, vSize = v1 - v0;

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

    const frame = new BrushDef(csg.nextBrushId++, 'subtract', fx, fy, fz, fw, fh, fd);
    if (csg.holeDoor) frame.isDoorframe = true;
    else frame.isHoleFrame = true;
    csg.brushes.push(frame);

    const protoroom = new BrushDef(csg.nextBrushId++, 'subtract', px, py, pz, pw, ph, pd);
    csg.brushes.push(protoroom);

    csg.holeMode = false;
    csg.doorPreview = null;

    const dimKey = axis === 'x' ? 'w' : axis === 'y' ? 'h' : 'd';
    csg.selectedFace = {
        regionId,
        brushId: protoroom.id, axis, side,
        position: side === 'max' ? protoroom[axis] + protoroom[dimKey] : protoroom[axis]
    };
    csg.selSizeU = 0; csg.selSizeV = 0;
    csg.activeBrush = null; csg.activeOp = null; csg.activeSide = null;

    rebuildAllCSG();
}

// ─── Bake / Retexture / Delete ───────────────────────────────────────

// Bake the region containing the currently selected face.
// (Or all regions if nothing is selected — equivalent to "bake all".)
export function bakeCurrentRegion() {
    const csg = state.csg;
    let bakedAny = false;

    for (const [, data] of csgRegionMeshes) {
        if (csg.selectedFace && csg.selectedFace.regionId !== data.region.id) continue;
        const count = data.region.bake();
        if (count) {
            bakedAny = true;
            csg.totalBakedBrushes += count;
        }
    }

    if (bakedAny) {
        // Bake mutates region.brushes by removing them. Sync state.csg.brushes
        // so the user-visible brush list reflects what's still un-baked.
        // Bake removed brushes from the per-region brushes array — but
        // state.csg.brushes is the source of truth. Find which brush ids were baked
        // (i.e. not present in any region's brushes array anymore) and remove them.
        const stillUnbaked = new Set();
        for (const [, data] of csgRegionMeshes) {
            for (const b of data.region.brushes) stillUnbaked.add(b.id);
        }
        state.csg.brushes = state.csg.brushes.filter(b => stillUnbaked.has(b.id));

        csg.selectedFace = null;
        csg.activeBrush = null;
        csg.activeOp = null;
        csg.activeSide = null;
        csg.selSizeU = 0;
        csg.selSizeV = 0;

        rebuildAllCSG();
    }
}

// Retexture all brushes in the same room (flood-fill stops at door/hole frames).
export function retextureRoom(schemeKey) {
    const csg = state.csg;
    const sel = csg.selectedFace;
    if (!sel || sel.brushId === 0) return;
    const startBrush = state.csg.brushes.find(b => b.id === sel.brushId);
    if (!startBrush || startBrush.isDoorframe || startBrush.isHoleFrame) return;

    const roomIds = findRoomBrushes(startBrush, state.csg.brushes);
    const roomBrushes = state.csg.brushes.filter(b => roomIds.has(b.id));
    const roomFloorY = Math.min(...roomBrushes.map(b => b.minY));
    for (const b of roomBrushes) {
        b.schemeKey = schemeKey;
        b.floorY = roomFloorY;
    }

    rebuildAllCSG();
}

// Delete the brush whose face is currently selected.
export function deleteSelectedBrush() {
    const csg = state.csg;
    const sel = csg.selectedFace;
    if (!sel || sel.brushId === 0) return;
    const idx = state.csg.brushes.findIndex(b => b.id === sel.brushId);
    if (idx < 0) return;
    state.csg.brushes.splice(idx, 1);

    csg.selectedFace = null;
    csg.activeBrush = null;
    csg.activeOp = null;
    csg.activeSide = null;

    rebuildAllCSG();
}
