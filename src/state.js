// Editor state — single source of truth

import { Volume } from './volume.js';

export const state = {
    volumes: [],
    connections: [],        // Connection[]
    nextVolumeId: 1,
    nextConnectionId: 1,
    selectedFace: null,     // { volumeId, axis, side, position, bounds: { u0, u1, v0, v1 } }
    tool: 'push_pull',      // 'push_pull' | 'door'
    doorWidth: 6,
    doorHeight: 8,
    pushStep: 4,
    undoStack: [],
    maxUndo: 50,
};

export function saveUndoState() {
    const snapshot = JSON.stringify({
        volumes: state.volumes.map(v => v.toJSON()),
        connections: state.connections,
    });
    state.undoStack.push(snapshot);
    if (state.undoStack.length > state.maxUndo) state.undoStack.shift();
}

export function undo() {
    if (state.undoStack.length === 0) return false;
    const snapshot = JSON.parse(state.undoStack.pop());
    state.volumes = snapshot.volumes.map(j => Volume.fromJSON(j));
    state.connections = snapshot.connections;
    state.nextVolumeId = Math.max(...state.volumes.map(v => v.id), 0) + 1;
    state.nextConnectionId = Math.max(...state.connections.map(c => c.id), 0) + 1;
    state.selectedFace = null;
    return true;
}

export function serializeLevel() {
    return JSON.stringify({
        volumes: state.volumes.map(v => v.toJSON()),
        connections: state.connections,
        nextVolumeId: state.nextVolumeId,
        nextConnectionId: state.nextConnectionId,
    }, null, 2);
}

export function deserializeLevel(json) {
    const data = JSON.parse(json);
    state.volumes = data.volumes.map(j => Volume.fromJSON(j));
    state.connections = data.connections || [];
    state.nextVolumeId = data.nextVolumeId || (Math.max(...state.volumes.map(v => v.id), 0) + 1);
    state.nextConnectionId = data.nextConnectionId || (Math.max(...state.connections.map(c => c.id), 0) + 1);
    state.selectedFace = null;
    state.undoStack = [];
}
