// Editor state — single source of truth

import { Volume } from './core/Volume.js';
import { Staircase, getSegmentInfo } from './core/Staircase.js';
import { Platform } from './core/Platform.js';
import { StairRun } from './core/StairRun.js';

export const state = {
    volumes: [],
    connections: [],        // Connection[]
    staircases: [],         // Staircase[] (legacy — migrated to platforms/stairRuns on load)
    platforms: [],          // Platform[]
    stairRuns: [],          // StairRun[]
    nextVolumeId: 1,
    nextConnectionId: 1,
    nextStaircaseId: 1,
    nextPlatformId: 1,
    nextStairRunId: 1,
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

    // Stair tool state (legacy — transient, not serialized or in undo snapshots)
    stairPhase: 'idle',       // 'idle' | 'placing'
    stairWaypoints: [],       // [{x, y, z}, ...] in WT units — committed waypoints
    stairWidth: 4,
    stairStepHeight: 1,       // height of each step in WT units
    stairSide: 'right',      // 'left' | 'right'
    stairRiseOverRun: 1,      // rise/run ratio for step proportions (1 = 45°)

    // Platform tool state (transient — not serialized or in undo snapshots)
    platformPhase: 'idle',    // 'idle' | 'selected' | 'moving' | 'scaling' | 'connecting_dst' | 'connecting_src'
    selectedPlatformId: null, // ID of currently selected platform
    selectedStairRunId: null, // ID of currently selected stair run
    platformMoveAxis: null,   // 'x' | 'y' | 'z' — constrained axis during move
    platformScaleAxis: null,  // 'x' | 'z' — constrained axis during scale
    platformConnectFrom: null, // { platformId, edge, offset } — source edge when connecting
    platformConnectTo: null,   // { type: 'ground' } | { type: 'platform', platformId, edge } — destination
    simpleStairFrom: null,     // { x, y, z } — first click point for simple stairs
    platformSizeX: 4,         // default platform X size for placement
    platformSizeZ: 4,         // default platform Z size for placement
    platformThickness: 1,     // default platform thickness

    // View mode (transient — not serialized or in undo snapshots)
    viewMode: 'grid',         // 'grid' | 'textured'
};

export function saveUndoState() {
    const snapshot = JSON.stringify({
        volumes: state.volumes.map(v => v.toJSON()),
        connections: state.connections,
        staircases: state.staircases.map(s => s.toJSON()),
        platforms: state.platforms.map(p => p.toJSON()),
        stairRuns: state.stairRuns.map(r => r.toJSON()),
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
    state.platforms = (snapshot.platforms || []).map(j => Platform.fromJSON(j));
    state.stairRuns = (snapshot.stairRuns || []).map(j => StairRun.fromJSON(j));
    state.nextVolumeId = Math.max(...state.volumes.map(v => v.id), 0) + 1;
    state.nextConnectionId = Math.max(...state.connections.map(c => c.id), 0) + 1;
    state.nextStaircaseId = Math.max(...state.staircases.map(s => s.id), 0) + 1;
    state.nextPlatformId = Math.max(...state.platforms.map(p => p.id), 0) + 1;
    state.nextStairRunId = Math.max(...state.stairRuns.map(r => r.id), 0) + 1;
    state.selectedFace = null;
    state.selectedPlatformId = null;
    state.selectedStairRunId = null;
    return true;
}

export function serializeLevel() {
    return JSON.stringify({
        volumes: state.volumes.map(v => v.toJSON()),
        connections: state.connections,
        staircases: state.staircases.map(s => s.toJSON()),
        platforms: state.platforms.map(p => p.toJSON()),
        stairRuns: state.stairRuns.map(r => r.toJSON()),
        nextVolumeId: state.nextVolumeId,
        nextConnectionId: state.nextConnectionId,
        nextStaircaseId: state.nextStaircaseId,
        nextPlatformId: state.nextPlatformId,
        nextStairRunId: state.nextStairRunId,
    }, null, 2);
}

export function deserializeLevel(json) {
    const data = JSON.parse(json);
    state.volumes = data.volumes.map(j => Volume.fromJSON(j));
    state.connections = data.connections || [];
    state.staircases = (data.staircases || []).map(j => Staircase.fromJSON(j));
    state.platforms = (data.platforms || []).map(j => Platform.fromJSON(j));
    state.stairRuns = (data.stairRuns || []).map(j => StairRun.fromJSON(j));
    state.nextVolumeId = data.nextVolumeId || (Math.max(...state.volumes.map(v => v.id), 0) + 1);
    state.nextConnectionId = data.nextConnectionId || (Math.max(...state.connections.map(c => c.id), 0) + 1);
    state.nextStaircaseId = data.nextStaircaseId || (Math.max(...state.staircases.map(s => s.id), 0) + 1);
    state.nextPlatformId = data.nextPlatformId || (Math.max(...state.platforms.map(p => p.id), 0) + 1);
    state.nextStairRunId = data.nextStairRunId || (Math.max(...state.stairRuns.map(r => r.id), 0) + 1);
    state.selectedFace = null;
    state.selectedPlatformId = null;
    state.selectedStairRunId = null;
    state.undoStack = [];

    // Migrate legacy staircases to platforms + stairRuns
    if (state.staircases.length > 0 && state.platforms.length === 0 && state.stairRuns.length === 0) {
        migrateLegacyStaircases();
    }
}

/**
 * Convert legacy Staircase objects (waypoint-based) to Platform + StairRun entities.
 * Each waypoint becomes a platform, each segment becomes a stair run.
 */
function migrateLegacyStaircases() {
    for (const stair of state.staircases) {
        const wps = stair.waypoints;
        if (wps.length < 2) continue;

        const platIds = [];

        // Create a platform at each waypoint
        for (let i = 0; i < wps.length; i++) {
            const wp = wps[i];
            const halfW = Math.floor(stair.width / 2);
            const plat = new Platform(
                state.nextPlatformId++,
                wp.x - halfW, wp.y, wp.z - halfW,
                stair.width, stair.width, 1,
            );
            state.platforms.push(plat);
            platIds.push(plat.id);
        }

        // Create stair runs between consecutive platforms
        for (let i = 0; i < wps.length - 1; i++) {
            // Determine edge based on direction between waypoints
            const seg = getSegmentInfo(wps[i], wps[i + 1], stair.stepHeight);
            let fromEdge, toEdge;
            if (seg.runAxis === 'x') {
                fromEdge = seg.runSign > 0 ? 'xMax' : 'xMin';
                toEdge = seg.runSign > 0 ? 'xMin' : 'xMax';
            } else {
                fromEdge = seg.runSign > 0 ? 'zMax' : 'zMin';
                toEdge = seg.runSign > 0 ? 'zMin' : 'zMax';
            }

            // Higher platform is 'from', lower is 'to' for the run
            const fromIsHigher = wps[i].y >= wps[i + 1].y;
            const run = new StairRun(
                state.nextStairRunId++,
                fromIsHigher ? platIds[i] : platIds[i + 1],
                fromIsHigher ? platIds[i + 1] : platIds[i],
                { edge: fromIsHigher ? fromEdge : toEdge },
                { edge: fromIsHigher ? toEdge : fromEdge },
                stair.width,
                stair.stepHeight,
                stair.riseOverRun,
            );
            state.stairRuns.push(run);
        }
    }

    // Clear legacy staircases after migration
    state.staircases = [];
}
