// Editor state — single source of truth

import { Volume } from './core/Volume.js';
import { Platform } from './core/Platform.js';
import { StairRun } from './core/StairRun.js';
import { TerrainMap } from './core/TerrainMap.js';
import { PointLight } from './core/PointLight.js';

export const state = {
    volumes: [],
    connections: [],        // Connection[]
    platforms: [],          // Platform[]
    stairRuns: [],          // StairRun[]
    nextVolumeId: 1,
    nextConnectionId: 1,
    nextPlatformId: 1,
    nextStairRunId: 1,
    selectedFace: null,     // { volumeId, axis, side, position, bounds: { u0, u1, v0, v1 } }
    tool: 'push_pull',      // 'push_pull' | 'door' | 'extrude' | 'platform'
    doorWidth: 3,
    doorHeight: 7,
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

    // Stair settings (shared by platform-connect stairs and simple stairs)
    stairWidth: 4,
    stairStepHeight: 1,       // height of each step in WT units
    stairRiseOverRun: 1,      // rise/run ratio for step proportions (1 = 45°)

    // Platform tool state (transient — not serialized or in undo snapshots)
    platformPhase: 'idle',    // 'idle' | 'selected' | 'moving' | 'scaling' | 'connecting_dst' | 'connecting_src' | 'simple_stair_from' | 'simple_stair_to'
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

    // Radial menu state (transient)
    radialMenuOpen: false,

    // View mode (transient — not serialized or in undo snapshots)
    viewMode: 'grid',         // 'grid' | 'textured'
    showGrid: true,           // grid helper visibility
    showWireframe: true,      // terrain mesh wireframe visibility

    // Editor mode
    editorMode: 'indoor',     // 'indoor' | 'terrain'

    // Terrain data (serialized)
    terrainMaps: [],           // TerrainMap[]
    nextTerrainMapId: 1,

    // Terrain tool state (transient — not serialized or in undo snapshots)
    terrainTool: 'boundary',   // 'boundary' | 'hole' | 'edit' | 'sculpt'
    terrainDrawingPhase: 'idle', // 'idle' | 'drawing' | 'closed'
    terrainDrawingVertices: [], // Current in-progress polygon [{x, z}]
    selectedTerrainId: null,   // ID of active terrain map
    terrainCameraMode: 'ortho', // 'ortho' | 'perspective' — camera in terrain mode

    // Brush state (transient)
    brushType: 'raise',        // 'raise' | 'noise' | 'smooth' | 'flatten'
    brushRadius: 8,            // radius in WT units
    brushStrength: 0.5,        // 0-1
    brushNoiseScale: 0.1,      // noise frequency for noise brush
    brushNoiseAmp: 2,          // noise amplitude for noise brush

    // Point lights (serialized)
    pointLights: [],           // PointLight[]
    nextPointLightId: 1,

    // Light tool state (transient)
    selectedLightId: null,
    lightPhase: 'idle',        // 'idle' | 'selected' | 'moving'

    // Baked lighting state (transient)
    bakedLighting: false,
    realtimePreview: false,   // when true, Three.js PointLights are active + scene lights dimmed
    bakeAmbient: 1.0,         // ambient light level for baking (0-1)
};

export function saveUndoState() {
    const snapshot = JSON.stringify({
        volumes: state.volumes.map(v => v.toJSON()),
        connections: state.connections,
        platforms: state.platforms.map(p => p.toJSON()),
        stairRuns: state.stairRuns.map(r => r.toJSON()),
        terrainMaps: state.terrainMaps.map(t => t.toJSON()),
        pointLights: state.pointLights.map(l => l.toJSON()),
    });
    state.undoStack.push(snapshot);
    if (state.undoStack.length > state.maxUndo) state.undoStack.shift();
}

export function undo() {
    if (state.undoStack.length === 0) return false;
    const snapshot = JSON.parse(state.undoStack.pop());
    state.volumes = snapshot.volumes.map(j => Volume.fromJSON(j));
    state.connections = snapshot.connections;
    state.platforms = (snapshot.platforms || []).map(j => Platform.fromJSON(j));
    state.stairRuns = (snapshot.stairRuns || []).map(j => StairRun.fromJSON(j));
    state.terrainMaps = (snapshot.terrainMaps || []).map(j => TerrainMap.fromJSON(j));
    state.pointLights = (snapshot.pointLights || []).map(j => PointLight.fromJSON(j));
    state.nextVolumeId = Math.max(...state.volumes.map(v => v.id), 0) + 1;
    state.nextConnectionId = Math.max(...state.connections.map(c => c.id), 0) + 1;
    state.nextPlatformId = Math.max(...state.platforms.map(p => p.id), 0) + 1;
    state.nextStairRunId = Math.max(...state.stairRuns.map(r => r.id), 0) + 1;
    state.nextTerrainMapId = Math.max(...state.terrainMaps.map(t => t.id), 0) + 1;
    state.nextPointLightId = Math.max(...state.pointLights.map(l => l.id), 0) + 1;
    state.selectedFace = null;
    state.selectedPlatformId = null;
    state.selectedStairRunId = null;
    state.selectedTerrainId = null;
    state.selectedLightId = null;
    return true;
}

export function serializeLevel() {
    return JSON.stringify({
        volumes: state.volumes.map(v => v.toJSON()),
        connections: state.connections,
        platforms: state.platforms.map(p => p.toJSON()),
        stairRuns: state.stairRuns.map(r => r.toJSON()),
        terrainMaps: state.terrainMaps.map(t => t.toJSON()),
        pointLights: state.pointLights.map(l => l.toJSON()),
        nextVolumeId: state.nextVolumeId,
        nextConnectionId: state.nextConnectionId,
        nextPlatformId: state.nextPlatformId,
        nextStairRunId: state.nextStairRunId,
        nextTerrainMapId: state.nextTerrainMapId,
        nextPointLightId: state.nextPointLightId,
    }, null, 2);
}

export function deserializeLevel(json) {
    const data = JSON.parse(json);
    state.volumes = data.volumes.map(j => Volume.fromJSON(j));
    state.connections = data.connections || [];
    state.platforms = (data.platforms || []).map(j => Platform.fromJSON(j));
    state.stairRuns = (data.stairRuns || []).map(j => StairRun.fromJSON(j));
    state.terrainMaps = (data.terrainMaps || []).map(j => TerrainMap.fromJSON(j));
    state.pointLights = (data.pointLights || []).map(j => PointLight.fromJSON(j));
    state.nextVolumeId = data.nextVolumeId || (Math.max(...state.volumes.map(v => v.id), 0) + 1);
    state.nextConnectionId = data.nextConnectionId || (Math.max(...state.connections.map(c => c.id), 0) + 1);
    state.nextPlatformId = data.nextPlatformId || (Math.max(...state.platforms.map(p => p.id), 0) + 1);
    state.nextStairRunId = data.nextStairRunId || (Math.max(...state.stairRuns.map(r => r.id), 0) + 1);
    state.nextTerrainMapId = data.nextTerrainMapId || (Math.max(...state.terrainMaps.map(t => t.id), 0) + 1);
    state.nextPointLightId = data.nextPointLightId || (Math.max(...state.pointLights.map(l => l.id), 0) + 1);
    state.selectedFace = null;
    state.selectedPlatformId = null;
    state.selectedStairRunId = null;
    state.selectedTerrainId = null;
    state.selectedLightId = null;
    state.undoStack = [];
}
