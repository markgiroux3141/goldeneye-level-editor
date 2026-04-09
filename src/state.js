// Editor state — single source of truth

import { Platform } from './core/Platform.js';
import { StairRun } from './core/StairRun.js';
import { TerrainMap } from './core/TerrainMap.js';
import { PointLight } from './core/PointLight.js';
import { BrushDef } from './core/BrushDef.js';
import {
    DEFAULT_PLATFORM_SIZE_X, DEFAULT_PLATFORM_SIZE_Z, DEFAULT_PLATFORM_THICKNESS,
    DEFAULT_STAIR_WIDTH, DEFAULT_STAIR_STEP_HEIGHT, DEFAULT_STAIR_RISE_OVER_RUN,
    DEFAULT_BRUSH_RADIUS, DEFAULT_BRUSH_STRENGTH, DEFAULT_BRUSH_NOISE_SCALE, DEFAULT_BRUSH_NOISE_AMP,
    DEFAULT_BAKE_AMBIENT, MAX_UNDO,
    DEFAULT_BRACE_WIDTH, DEFAULT_BRACE_DEPTH, DEFAULT_PILLAR_SIZE,
} from './core/constants.js';

export const state = {
    platforms: [],          // Platform[]
    stairRuns: [],          // StairRun[]
    nextPlatformId: 1,
    nextStairRunId: 1,

    // ─── CSG brush system ─────────────────────────────────────────────
    csg: {
        brushes: [],            // BrushDef[] (un-baked)
        nextBrushId: 1,
        totalBakedBrushes: 0,
        // Selection
        selectedFace: null,     // { regionId, brushId, axis, side, position }
        selSizeU: 0, selSizeV: 0,  // 0 = full face
        selU0: 0, selU1: 0, selV0: 0, selV1: 0,  // computed each frame
        // Active push/pull/extrude tracking
        activeBrush: null,      // BrushDef being grown by consecutive +/- presses
        activeOp: null,         // 'push' | 'pull' | 'extrude'
        activeSide: null,       // 'min' | 'max' — original face side
        // Hole/door modal tool state
        holeMode: false,
        holeDoor: false,
        doorPreview: null,      // { face, u0, u1, v0, v1 }
        // Brace modal tool state
        braceMode: false,
        bracePreview: null,     // { regionId, wall1, ceiling, wall2 }
        braceWidth: DEFAULT_BRACE_WIDTH,
        braceDepth: DEFAULT_BRACE_DEPTH,
        // Pillar modal tool state
        pillarMode: false,
        pillarPreview: null,    // { regionId, roomBrushId, box }
        pillarSize: DEFAULT_PILLAR_SIZE,
    },

    tool: 'csg',            // 'csg' | 'platform' | 'light'
    undoStack: [],
    maxUndo: MAX_UNDO,

    // Stair settings (shared by platform-connect stairs and simple stairs)
    stairWidth: DEFAULT_STAIR_WIDTH,
    stairStepHeight: DEFAULT_STAIR_STEP_HEIGHT,
    stairRiseOverRun: DEFAULT_STAIR_RISE_OVER_RUN,

    // Platform tool state (transient — not serialized or in undo snapshots)
    platformPhase: 'idle',    // 'idle' | 'selected' | 'moving' | 'scaling' | 'connecting_dst' | 'connecting_src' | 'simple_stair_from' | 'simple_stair_to'
    selectedPlatformId: null, // ID of currently selected platform
    selectedStairRunId: null, // ID of currently selected stair run
    platformMoveAxis: null,   // 'x' | 'y' | 'z' — constrained axis during move
    platformScaleAxis: null,  // 'x' | 'z' — constrained axis during scale
    platformConnectFrom: null, // { platformId, edge, offset } — source edge when connecting
    platformConnectTo: null,   // { type: 'ground' } | { type: 'platform', platformId, edge } — destination
    simpleStairFrom: null,     // { x, y, z } — first click point for simple stairs
    platformSizeX: DEFAULT_PLATFORM_SIZE_X,
    platformSizeZ: DEFAULT_PLATFORM_SIZE_Z,
    platformThickness: DEFAULT_PLATFORM_THICKNESS,

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
    brushRadius: DEFAULT_BRUSH_RADIUS,
    brushStrength: DEFAULT_BRUSH_STRENGTH,
    brushNoiseScale: DEFAULT_BRUSH_NOISE_SCALE,
    brushNoiseAmp: DEFAULT_BRUSH_NOISE_AMP,

    // Point lights (serialized)
    pointLights: [],           // PointLight[]
    nextPointLightId: 1,

    // Light tool state (transient)
    selectedLightId: null,
    lightPhase: 'idle',        // 'idle' | 'selected' | 'moving'

    // Baked lighting state (transient)
    bakedLighting: false,
    realtimePreview: false,   // when true, Three.js PointLights are active + scene lights dimmed
    bakeAmbient: DEFAULT_BAKE_AMBIENT,
};

export function saveUndoState() {
    const snapshot = JSON.stringify({
        platforms: state.platforms.map(p => p.toJSON()),
        stairRuns: state.stairRuns.map(r => r.toJSON()),
        terrainMaps: state.terrainMaps.map(t => t.toJSON()),
        pointLights: state.pointLights.map(l => l.toJSON()),
        csgBrushes: state.csg.brushes.map(b => b.toJSON()),
        nextBrushId: state.csg.nextBrushId,
        totalBakedBrushes: state.csg.totalBakedBrushes,
    });
    state.undoStack.push(snapshot);
    if (state.undoStack.length > state.maxUndo) state.undoStack.shift();
}

export function undo() {
    if (state.undoStack.length === 0) return false;
    let snapshot;
    try {
        snapshot = JSON.parse(state.undoStack.pop());
    } catch (e) {
        console.warn('Failed to parse undo snapshot:', e.message);
        return false;
    }
    state.platforms = (snapshot.platforms || []).map(j => Platform.fromJSON(j));
    state.stairRuns = (snapshot.stairRuns || []).map(j => StairRun.fromJSON(j));
    state.terrainMaps = (snapshot.terrainMaps || []).map(j => TerrainMap.fromJSON(j));
    state.pointLights = (snapshot.pointLights || []).map(j => PointLight.fromJSON(j));
    state.csg.brushes = (snapshot.csgBrushes || []).map(j => BrushDef.fromJSON(j));
    state.csg.nextBrushId = snapshot.nextBrushId || (Math.max(...state.csg.brushes.map(b => b.id), 0) + 1);
    state.csg.totalBakedBrushes = snapshot.totalBakedBrushes || 0;
    state.csg.selectedFace = null;
    state.csg.activeBrush = null;
    state.csg.activeOp = null;
    state.csg.activeSide = null;
    state.nextPlatformId = Math.max(...state.platforms.map(p => p.id), 0) + 1;
    state.nextStairRunId = Math.max(...state.stairRuns.map(r => r.id), 0) + 1;
    state.nextTerrainMapId = Math.max(...state.terrainMaps.map(t => t.id), 0) + 1;
    state.nextPointLightId = Math.max(...state.pointLights.map(l => l.id), 0) + 1;
    state.selectedPlatformId = null;
    state.selectedStairRunId = null;
    state.selectedTerrainId = null;
    state.selectedLightId = null;
    return true;
}

export function serializeLevel() {
    return JSON.stringify({
        version: 2,
        platforms: state.platforms.map(p => p.toJSON()),
        stairRuns: state.stairRuns.map(r => r.toJSON()),
        terrainMaps: state.terrainMaps.map(t => t.toJSON()),
        pointLights: state.pointLights.map(l => l.toJSON()),
        csgBrushes: state.csg.brushes.map(b => b.toJSON()),
        nextBrushId: state.csg.nextBrushId,
        totalBakedBrushes: state.csg.totalBakedBrushes,
        nextPlatformId: state.nextPlatformId,
        nextStairRunId: state.nextStairRunId,
        nextTerrainMapId: state.nextTerrainMapId,
        nextPointLightId: state.nextPointLightId,
    }, null, 2);
}

export function deserializeLevel(json) {
    const data = JSON.parse(json);
    if (!data) throw new Error('Invalid level data');
    const version = data.version || 0;
    if (version !== 2) throw new Error('Save v1 no longer supported (Phase 6 dropped legacy Volume/Connection format)');
    state.platforms = (data.platforms || []).map(j => Platform.fromJSON(j));
    state.stairRuns = (data.stairRuns || []).map(j => StairRun.fromJSON(j));
    state.terrainMaps = (data.terrainMaps || []).map(j => TerrainMap.fromJSON(j));
    state.pointLights = (data.pointLights || []).map(j => PointLight.fromJSON(j));
    state.csg.brushes = (data.csgBrushes || []).map(j => BrushDef.fromJSON(j));
    state.csg.nextBrushId = data.nextBrushId || (Math.max(...state.csg.brushes.map(b => b.id), 0) + 1);
    state.csg.totalBakedBrushes = data.totalBakedBrushes || 0;
    state.csg.selectedFace = null;
    state.csg.activeBrush = null;
    state.csg.activeOp = null;
    state.csg.activeSide = null;
    state.nextPlatformId = data.nextPlatformId || (Math.max(...state.platforms.map(p => p.id), 0) + 1);
    state.nextStairRunId = data.nextStairRunId || (Math.max(...state.stairRuns.map(r => r.id), 0) + 1);
    state.nextTerrainMapId = data.nextTerrainMapId || (Math.max(...state.terrainMaps.map(t => t.id), 0) + 1);
    state.nextPointLightId = data.nextPointLightId || (Math.max(...state.pointLights.map(l => l.id), 0) + 1);
    state.selectedPlatformId = null;
    state.selectedStairRunId = null;
    state.selectedTerrainId = null;
    state.selectedLightId = null;
    state.undoStack = [];
}
