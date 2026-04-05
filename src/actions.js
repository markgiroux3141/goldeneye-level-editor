// Editor actions: push/pull, door cutting, save/load

import { Volume, WALL_THICKNESS, WORLD_SCALE } from './core/Volume.js';
import { state, saveUndoState, undo, serializeLevel, deserializeLevel } from './state.js';
import { applyPush, applyPull } from './collision.js';
import { computeDoorPlacement, connectionExistsAt, createConnection } from './core/Connection.js';
import { getVolumeFaceBounds, getFacePosition } from './core/Face.js';
import { saveToLocalStorage } from './io/LevelStorage.js';
import { downloadJson, uploadJson } from './io/LevelFileIO.js';

// ============================================================
// PUSH — unified logic based on face geometry
// ============================================================
export function pushSelectedFace(showMessage, rebuildCallback, rebuildAllCallback) {
    if (!state.selectedFace || state.tool !== 'push_pull') return;

    const face = state.selectedFace;
    const vol = state.volumes.find(v => v.id === face.volumeId);
    if (!vol) return;

    // Does this face span the full extent of the volume?
    const fullBounds = getVolumeFaceBounds(vol, face.axis);
    const isFullFace = face.bounds.u0 === fullBounds.u0 && face.bounds.u1 === fullBounds.u1 &&
                       face.bounds.v0 === fullBounds.v0 && face.bounds.v1 === fullBounds.v1;

    // Is the face at the inner position (wall face) or outer position (exit cap)?
    const innerPos = getFacePosition(vol, face.axis, face.side);
    const isAtInnerPos = face.position === innerPos;

    if (isFullFace && isAtInnerPos) {
        // Full wall face — extend the volume
        saveUndoState();
        applyPush(vol, face.axis, face.side, state.pushStep);
        // Update selectedFace to match the new geometry
        state.selectedFace = {
            volumeId: vol.id, axis: face.axis, side: face.side,
            position: getFacePosition(vol, face.axis, face.side),
            bounds: getVolumeFaceBounds(vol, face.axis),
        };
        rebuildCallback(vol);
    } else if (!isAtInnerPos) {
        // Sub-face at outer position (exit cap) — create new volume from it
        extrudeFromFace(face, vol, showMessage, rebuildCallback, rebuildAllCallback);
    }
}

function extrudeFromFace(face, parentVol, showMessage, rebuildCallback, rebuildAllCallback) {
    const t = WALL_THICKNESS;
    const { axis, side, bounds } = face;
    const { u0, u1, v0, v1 } = bounds;

    // Find the connection for this exit
    const conn = state.connections.find(c =>
        c.volAId === parentVol.id && c.axis === axis && c.sideOnA === side &&
        c.bounds.u0 === u0 && c.bounds.u1 === u1 &&
        c.bounds.v0 === v0 && c.bounds.v1 === v1
    );

    if (conn && conn.volBId !== null) {
        // Already connected — extend the connected volume's far face
        const connVol = state.volumes.find(v => v.id === conn.volBId);
        if (!connVol) return;
        saveUndoState();
        applyPush(connVol, axis, side, state.pushStep);
        // Select the far face of the connected volume so user can keep pushing
        state.selectedFace = {
            volumeId: connVol.id, axis, side,
            position: getFacePosition(connVol, axis, side),
            bounds: getVolumeFaceBounds(connVol, axis),
        };
        rebuildAllCallback();
        return;
    }

    // Create new volume from the exit
    saveUndoState();

    const step = state.pushStep;
    let nx, ny, nz, nw, nh, nd;
    if (axis === 'x') {
        nx = side === 'min' ? parentVol.x - t - step : parentVol.x + parentVol.w + t;
        ny = v0; nz = u0;
        nw = step; nh = v1 - v0; nd = u1 - u0;
    } else { // z
        nz = side === 'min' ? parentVol.z - t - step : parentVol.z + parentVol.d + t;
        nx = u0; ny = v0;
        nw = u1 - u0; nh = v1 - v0; nd = step;
    }

    const newVol = new Volume(state.nextVolumeId++, nx, ny, nz, nw, nh, nd);
    newVol.textureScheme = parentVol.textureScheme;

    // Connect
    if (conn) {
        conn.volBId = newVol.id;
    }

    state.volumes.push(newVol);

    // Select the far face of the new volume
    state.selectedFace = {
        volumeId: newVol.id, axis, side,
        position: getFacePosition(newVol, axis, side),
        bounds: getVolumeFaceBounds(newVol, axis),
    };

    rebuildAllCallback();
    showMessage('Extended');
}

// ============================================================
// PULL
// ============================================================
export function pullSelectedFace(showMessage, rebuildCallback) {
    if (!state.selectedFace || state.tool !== 'push_pull') return;
    const face = state.selectedFace;
    const vol = state.volumes.find(v => v.id === face.volumeId);
    if (!vol) return;

    // Only allow pull on full wall faces at inner position
    const innerPos = getFacePosition(vol, face.axis, face.side);
    if (face.position !== innerPos) return;

    saveUndoState();
    if (!applyPull(vol, face.axis, face.side, state.pushStep)) {
        state.undoStack.pop();
        showMessage('Minimum size reached');
    } else {
        state.selectedFace = {
            volumeId: vol.id, axis: face.axis, side: face.side,
            position: getFacePosition(vol, face.axis, face.side),
            bounds: getVolumeFaceBounds(vol, face.axis),
        };
        rebuildCallback(vol);
    }
}

// ============================================================
// DOOR CUTTING
// ============================================================
export function placeDoorOnFace(volumeId, axis, side, hitPoint, showMessage, rebuildCallback) {
    if (axis === 'y') {
        showMessage('Doors can only be placed on walls');
        return;
    }

    const vol = state.volumes.find(v => v.id === volumeId);
    if (!vol) return;

    const doorBounds = computeDoorPlacement(vol, axis, side, hitPoint, state.doorWidth, state.doorHeight);
    if (!doorBounds) {
        showMessage('Wall too small for a door');
        return;
    }

    if (connectionExistsAt(state.connections, volumeId, axis, side, doorBounds)) {
        showMessage('Opening already exists here');
        return;
    }

    saveUndoState();

    // Check if another volume is adjacent on the other side of this wall
    const adjVol = findAdjacentVolume(vol, axis, side, doorBounds);

    const conn = createConnection(
        state.nextConnectionId++, volumeId, axis, side, doorBounds,
        adjVol ? adjVol.id : null
    );
    state.connections.push(conn);

    // Switch back to push/pull tool
    state.tool = 'push_pull';

    if (adjVol) {
        // Bridged — no exit cap, just deselect
        state.selectedFace = null;
        rebuildCallback(vol);
        rebuildCallback(adjVol);
        showMessage('Door cut — connected!');
    } else {
        // Select the exit cap face so user can immediately push
        const t = WALL_THICKNESS;
        const outerPos = side === 'min'
            ? getFacePosition(vol, axis, side) - t
            : getFacePosition(vol, axis, side) + t;
        state.selectedFace = {
            volumeId: volumeId, axis, side,
            position: outerPos,
            bounds: doorBounds,
        };
        rebuildCallback(vol);
        showMessage('Door cut — push to extend');
    }
}

// ============================================================
// ADJACENCY DETECTION
// ============================================================
function findAdjacentVolume(vol, axis, side, doorBounds) {
    const t = WALL_THICKNESS;
    const { u0, u1, v0, v1 } = doorBounds;

    for (const other of state.volumes) {
        if (other.id === vol.id) continue;

        // The other volume's face on the opposite side must be within wall thickness
        // of this volume's outer wall position
        if (axis === 'x') {
            const outerX = side === 'min' ? vol.x - t : vol.x + vol.w + t;
            const otherFace = side === 'min' ? other.x + other.w : other.x;
            if (Math.abs(outerX - otherFace) > t) continue;

            // Door bounds (u=z, v=y) must fit within the other volume
            if (u0 >= other.z && u1 <= other.z + other.d &&
                v0 >= other.y && v1 <= other.y + other.h) {
                return other;
            }
        } else { // z
            const outerZ = side === 'min' ? vol.z - t : vol.z + vol.d + t;
            const otherFace = side === 'min' ? other.z + other.d : other.z;
            if (Math.abs(outerZ - otherFace) > t) continue;

            // Door bounds (u=x, v=y) must fit within the other volume
            if (u0 >= other.x && u1 <= other.x + other.w &&
                v0 >= other.y && v1 <= other.y + other.h) {
                return other;
            }
        }
    }
    return null;
}

// ============================================================
// DELETE VOLUME
// ============================================================
export function deleteSelectedVolume(showMessage, rebuildAllCallback) {
    if (!state.selectedFace) return;
    const volId = state.selectedFace.volumeId;

    saveUndoState();
    state.volumes = state.volumes.filter(v => v.id !== volId);
    // Remove connections referencing this volume
    state.connections = state.connections.filter(c => c.volAId !== volId && c.volBId !== volId);
    // Disconnect any connections that had this as volB
    for (const c of state.connections) {
        if (c.volBId === volId) c.volBId = null;
    }
    state.selectedFace = null;
    rebuildAllCallback();
    showMessage('Volume deleted');
    return volId;
}

// ============================================================
// UNDO
// ============================================================
export function undoAction(showMessage, rebuildAllCallback) {
    if (undo()) {
        rebuildAllCallback();
        showMessage('Undo');
    } else {
        showMessage('Nothing to undo');
    }
}

// ============================================================
// SAVE / LOAD
// ============================================================
export function saveLevel(showMessage) {
    const json = serializeLevel();
    saveToLocalStorage(json);
    downloadJson(json);
    showMessage('Level saved');
}

export function loadLevel(showMessage, rebuildAllCallback) {
    uploadJson().then((json) => {
        try {
            deserializeLevel(json);
            rebuildAllCallback();
            showMessage('Level loaded');
        } catch (err) { showMessage('Error loading level'); }
    }).catch(() => { /* user cancelled */ });
}

// ============================================================
// EXTRUDE TOOL
// ============================================================

// Compute a placement rectangle centered on hitPoint in both U and V,
// clamped to wall bounds. Unlike computeDoorPlacement which is floor-anchored.
export function computeExtrudePlacement(vol, axis, side, hitPoint, width, height) {
    const hx = hitPoint.x / WORLD_SCALE;
    const hy = hitPoint.y / WORLD_SCALE;
    const hz = hitPoint.z / WORLD_SCALE;

    let faceW, faceH, localU, localV;
    if (axis === 'x') {
        faceW = vol.d; faceH = vol.h;
        localU = hz - vol.z;
        localV = hy - vol.y;
    } else if (axis === 'y') {
        faceW = vol.w; faceH = vol.d;
        localU = hx - vol.x;
        localV = hz - vol.z;
    } else { // z
        faceW = vol.w; faceH = vol.h;
        localU = hx - vol.x;
        localV = hy - vol.y;
    }

    if (faceW < width || faceH < height) return null;

    // Center on hit point, clamp to face bounds
    let du = Math.round(localU - width / 2);
    du = Math.max(0, Math.min(faceW - width, du));

    let dv = Math.round(localV - height / 2);
    dv = Math.max(0, Math.min(faceH - height, dv));

    let u0, u1, v0, v1;
    if (axis === 'x') {
        u0 = vol.z + du; u1 = u0 + width;
        v0 = vol.y + dv; v1 = v0 + height;
    } else if (axis === 'y') {
        u0 = vol.x + du; u1 = u0 + width;
        v0 = vol.z + dv; v1 = v0 + height;
    } else { // z
        u0 = vol.x + du; u1 = u0 + width;
        v0 = vol.y + dv; v1 = v0 + height;
    }

    return { u0, u1, v0, v1 };
}

export function addExtrudeSelection(volumeId, axis, side, hitPoint, showMessage) {
    // Reset if we were in extruded phase
    if (state.extrudePhase === 'extruded') {
        clearExtrudeState();
    }

    const vol = state.volumes.find(v => v.id === volumeId);
    if (!vol) return false;

    const bounds = computeExtrudePlacement(vol, axis, side, hitPoint, state.extrudeWidth, state.extrudeHeight);
    if (!bounds) {
        showMessage('Wall too small for extrusion');
        return false;
    }

    // Lock direction on first selection
    if (state.extrudeSelections.length === 0) {
        state.extrudeDirection = { axis, side };
    } else if (state.extrudeDirection.axis !== axis || state.extrudeDirection.side !== side) {
        showMessage('All selections must face the same direction');
        return false;
    }

    const position = getFacePosition(vol, axis, side);
    state.extrudeSelections.push({ volumeId, axis, side, bounds, position });
    state.extrudePhase = 'selecting';
    return true;
}

// Find the room that contains a volume (returns null if it IS a room)
function findContainingRoom(vol) {
    for (const other of state.volumes) {
        if (other.id === vol.id) continue;
        if (vol.x >= other.x && vol.x + vol.w <= other.x + other.w &&
            vol.y >= other.y && vol.y + vol.h <= other.y + other.h &&
            vol.z >= other.z && vol.z + vol.d <= other.z + other.d) {
            return other;
        }
    }
    return null;
}

export function executeExtrude(showMessage, rebuildAllCallback) {
    if (state.extrudePhase !== 'selecting' || state.extrudeSelections.length === 0) return;

    const { axis, side } = state.extrudeDirection;
    const step = state.pushStep;

    // Determine grow direction based on face normal:
    // - Room face (invertNormals=false): normal points into room, growSide = opposite of side
    // - Protrusion face (invertNormals=true): normal points outward, growSide = same as side
    const firstVol = state.volumes.find(v => v.id === state.extrudeSelections[0].volumeId);
    const isFromProtrusion = firstVol && firstVol.invertNormals;
    const growSide = isFromProtrusion ? side : (side === 'min' ? 'max' : 'min');

    const selectionData = [];

    for (const sel of state.extrudeSelections) {
        const clickedVol = state.volumes.find(v => v.id === sel.volumeId);
        if (!clickedVol) continue;

        // Resolve the containing room for bounds checking
        const room = clickedVol.invertNormals ? findContainingRoom(clickedVol) : clickedVol;
        if (!room) continue;

        // Place new volume starting at the face position, extending in growSide direction
        const facePos = sel.position;
        const { u0, u1, v0, v1 } = sel.bounds;
        let nx, ny, nz, nw, nh, nd;

        if (axis === 'x') {
            nx = growSide === 'max' ? facePos : facePos - step;
            ny = v0; nz = u0;
            nw = step; nh = v1 - v0; nd = u1 - u0;
        } else if (axis === 'y') {
            ny = growSide === 'max' ? facePos : facePos - step;
            nx = u0; nz = v0;
            nw = u1 - u0; nh = step; nd = v1 - v0;
        } else { // z
            nz = growSide === 'max' ? facePos : facePos - step;
            nx = u0; ny = v0;
            nw = u1 - u0; nh = v1 - v0; nd = step;
        }

        const newVol = new Volume(0, nx, ny, nz, nw, nh, nd);
        newVol.invertNormals = true; // protrusions have outward-facing normals
        newVol.textureScheme = room.textureScheme;
        selectionData.push({ newVol, room });
    }

    if (selectionData.length === 0) return;

    // Commit
    saveUndoState();
    state.extrudedVolumes = [];
    state.extrudeGrowSide = growSide;
    state.extrudeVolumeParentMap = {};

    for (const { newVol, room } of selectionData) {
        newVol.id = state.nextVolumeId++;
        state.volumes.push(newVol);
        state.extrudedVolumes.push(newVol.id);
        state.extrudeVolumeParentMap[newVol.id] = room.id;
    }

    state.extrudeSelections = [];
    state.extrudePhase = 'extruded';
    state.selectedFace = null;
    rebuildAllCallback();
    showMessage(`Extruded ${selectionData.length} region${selectionData.length > 1 ? 's' : ''}`);
}

export function reExtrudeVolumes(pushOrPull, showMessage, rebuildAllCallback) {
    if (state.extrudePhase !== 'extruded' || state.extrudedVolumes.length === 0) return;

    const { axis } = state.extrudeDirection;
    const growSide = state.extrudeGrowSide;

    if (pushOrPull === 'push') {
        saveUndoState();
        for (const volId of state.extrudedVolumes) {
            const vol = state.volumes.find(v => v.id === volId);
            if (vol) applyPush(vol, axis, growSide, state.pushStep);
        }
        rebuildAllCallback();
    } else { // pull — shrink protrusions back toward wall
        saveUndoState();
        let anyPulled = false;
        for (const volId of state.extrudedVolumes) {
            const vol = state.volumes.find(v => v.id === volId);
            if (vol && applyPull(vol, axis, growSide, state.pushStep)) {
                anyPulled = true;
            }
        }
        if (!anyPulled) {
            state.undoStack.pop();
            showMessage('Minimum size reached');
            return;
        }
        rebuildAllCallback();
    }
}

export function clearExtrudeState() {
    state.extrudeSelections = [];
    state.extrudeDirection = null;
    state.extrudedVolumes = [];
    state.extrudeGrowSide = null;
    state.extrudeVolumeParentMap = {};
    state.extrudePhase = 'idle';
}

// ============================================================
// STAIRCASE TOOL
// ============================================================

/** Snap a hit point (world coords) to WT grid coordinates. */
export function snapToWTGrid(hitPoint) {
    return {
        x: Math.round(hitPoint.x / WORLD_SCALE),
        y: Math.round(hitPoint.y / WORLD_SCALE),
        z: Math.round(hitPoint.z / WORLD_SCALE),
    };
}



