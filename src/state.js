// Editor state — single source of truth

import { Volume } from './core/Volume.js';
import { Staircase } from './core/Staircase.js';

export const state = {
    volumes: [],
    connections: [],        // Connection[]
    staircases: [],         // Staircase[]
    nextVolumeId: 1,
    nextConnectionId: 1,
    nextStaircaseId: 1,
    selectedFace: null,     // { volumeId, axis, side, position, bounds: { u0, u1, v0, v1 } }
    tool: 'push_pull',      // 'push_pull' | 'door' | 'extrude' | 'stair'
    doorWidth: 6,
    doorHeight: 8,
    pushStep: 4,
    undoStack: [],
    maxUndo: 50,

    // Extrude tool state (transient — not serialized or in undo snapshots)
    extrudeSelections: [],    // Array of { volumeId, axis, side, bounds, position }
    extrudeDirection: null,   // { axis, side } — locked after first selection
    extrudedVolumes: [],      // Array of volumeId — tracks created volumes for re-push
    extrudeParentIds: [],     // Array of volumeId — parent volumes (excluded from collision)
    extrudeGrowSide: null,    // 'min' | 'max' — the side to push when extending protrusions
    extrudeVolumeParentMap: {},  // { [protrusionId]: parentId }
    extrudePhase: 'idle',     // 'idle' | 'selecting' | 'extruded'
    extrudeWidth: 1,
    extrudeHeight: 1,

    // Stair tool state (transient — not serialized or in undo snapshots)
    stairPhase: 'idle',       // 'idle' | 'placing'
    stairWaypoints: [],       // [{x, y, z}, ...] in WT units — committed waypoints
    stairWidth: 4,
    stairStepHeight: 1,       // height of each step in WT units
    stairSide: 'right',      // 'left' | 'right'
};

export function saveUndoState() {
    const snapshot = JSON.stringify({
        volumes: state.volumes.map(v => v.toJSON()),
        connections: state.connections,
        staircases: state.staircases.map(s => s.toJSON()),
    });
    state.undoStack.push(snapshot);
    if (state.undoStack.length > state.maxUndo) state.undoStack.shift();
}

export function undo() {
    if (state.undoStack.length === 0) return false;
    const snapshot = JSON.parse(state.undoStack.pop());
    state.volumes = snapshot.volumes.map(j => Volume.fromJSON(j));
    state.connections = snapshot.connections;
    state.staircases = (snapshot.staircases || []).map(j => Staircase.fromJSON(j));
    state.nextVolumeId = Math.max(...state.volumes.map(v => v.id), 0) + 1;
    state.nextConnectionId = Math.max(...state.connections.map(c => c.id), 0) + 1;
    state.nextStaircaseId = Math.max(...state.staircases.map(s => s.id), 0) + 1;
    state.selectedFace = null;
    return true;
}

export function serializeLevel() {
    return JSON.stringify({
        volumes: state.volumes.map(v => v.toJSON()),
        connections: state.connections,
        staircases: state.staircases.map(s => s.toJSON()),
        nextVolumeId: state.nextVolumeId,
        nextConnectionId: state.nextConnectionId,
        nextStaircaseId: state.nextStaircaseId,
    }, null, 2);
}

export function deserializeLevel(json) {
    const data = JSON.parse(json);
    state.volumes = data.volumes.map(j => Volume.fromJSON(j));
    state.connections = data.connections || [];
    state.staircases = (data.staircases || []).map(j => Staircase.fromJSON(j));
    state.nextVolumeId = data.nextVolumeId || (Math.max(...state.volumes.map(v => v.id), 0) + 1);
    state.nextConnectionId = data.nextConnectionId || (Math.max(...state.connections.map(c => c.id), 0) + 1);
    state.nextStaircaseId = data.nextStaircaseId || (Math.max(...state.staircases.map(s => s.id), 0) + 1);
    state.selectedFace = null;
    state.undoStack = [];
}
