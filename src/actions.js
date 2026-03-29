// Editor actions: push/pull, door cutting, save/load

import * as THREE from 'three';
import { Volume, WALL_THICKNESS } from './volume.js';
import { state, saveUndoState, undo, serializeLevel, deserializeLevel } from './state.js';
import { canExtendVolume, canPlaceVolume, applyPush, applyPull } from './collision.js';
import { computeDoorPlacement, connectionExistsAt, createConnection } from './connection.js';

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
        if (canExtendVolume(state.volumes, vol, face.axis, face.side)) {
            saveUndoState();
            applyPush(vol, face.axis, face.side);
            // Update selectedFace to match the new geometry
            state.selectedFace = {
                volumeId: vol.id, axis: face.axis, side: face.side,
                position: getFacePosition(vol, face.axis, face.side),
                bounds: getVolumeFaceBounds(vol, face.axis),
            };
            rebuildCallback(vol);
        } else {
            showMessage('Blocked — collision!');
        }
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
        if (canExtendVolume(state.volumes, connVol, axis, side)) {
            saveUndoState();
            applyPush(connVol, axis, side);
            // Select the far face of the connected volume so user can keep pushing
            state.selectedFace = {
                volumeId: connVol.id, axis, side,
                position: getFacePosition(connVol, axis, side),
                bounds: getVolumeFaceBounds(connVol, axis),
            };
            rebuildAllCallback();
        } else {
            showMessage('Blocked — collision!');
        }
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

    if (!canPlaceVolume(state.volumes, newVol)) {
        state.undoStack.pop();
        state.nextVolumeId--;
        showMessage('Blocked — collision!');
        return;
    }

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
    if (!applyPull(vol, face.axis, face.side)) {
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

    const doorBounds = computeDoorPlacement(vol, axis, side, hitPoint);
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
        const t = 1; // WALL_THICKNESS
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
    const t = 1; // WALL_THICKNESS in WT units
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
    localStorage.setItem('goldeneye-level', json);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'level.json'; a.click();
    URL.revokeObjectURL(url);
    showMessage('Level saved');
}

export function loadLevel(showMessage, rebuildAllCallback) {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                deserializeLevel(ev.target.result);
                rebuildAllCallback();
                showMessage('Level loaded');
            } catch (err) { showMessage('Error loading level'); }
        };
        reader.readAsText(file);
    };
    input.click();
}

// ============================================================
// HELPERS (duplicated from geometry.js to avoid circular deps)
// ============================================================
function getVolumeFaceBounds(vol, axis) {
    if (axis === 'x') return { u0: vol.z, u1: vol.z + vol.d, v0: vol.y, v1: vol.y + vol.h };
    if (axis === 'y') return { u0: vol.x, u1: vol.x + vol.w, v0: vol.z, v1: vol.z + vol.d };
    return { u0: vol.x, u1: vol.x + vol.w, v0: vol.y, v1: vol.y + vol.h };
}

function getFacePosition(vol, axis, side) {
    if (axis === 'x') return side === 'min' ? vol.x : vol.x + vol.w;
    if (axis === 'y') return side === 'min' ? vol.y : vol.y + vol.h;
    return side === 'min' ? vol.z : vol.z + vol.d;
}
