// Indoor mode key handler

import { state, saveUndoState } from '../state.js';
import { isPointerLocked } from '../input/input.js';
import { showMessage } from '../hud/hud.js';
import { scene, gridHelper } from '../scene/setup.js';
import { TEXTURE_SCHEMES, getSchemeByKey } from '../scene/textureSchemes.js';
import { hotkeyManager } from '../input/HotkeyManager.js';
import {
    undoAction,
    saveLevel, loadLevel,
} from '../actions.js';
import * as csgActions from '../csg/csgActions.js';
import { rebuildCsgStair } from '../mesh/csgStairMesh.js';
import {
    stairRunMeshes,
    rebuildPlatform, rebuildStairRun, rebuildConnectedStairRuns,
    rebuildAllPlatforms, rebuildAllStairRuns,
    rebuildAll, removePlatformMesh,
    rebuildLight, removeLightMesh, updateLightSelection,
    setAllWireframeVisible,
    rebuildAllCSG,
} from '../mesh/MeshManager.js';
import { toggleEditorMode, setTool, clearPlatformToolState, clearLightToolState } from './ToolManager.js';

export function handleIndoorKey(e, { gizmo, camera }) {
    // ─── Tool/mode entry hotkeys (Numpad 1-6) ───────────────────────
    // These fire from any current tool, so users can jump directly to any
    // mode without cycling. Each switches state.tool (and any sub-mode flags).
    if (isPointerLocked()) {
        if (hotkeyManager.matches('tool_csg', e)) {
            e.preventDefault();
            setTool('csg');
            return;
        }
        if (hotkeyManager.matches('tool_hole', e)) {
            e.preventDefault();
            setTool('csg');
            csgActions.setHoleMode(true, false);
            showMessage('HOLE mode — click any face');
            return;
        }
        if (hotkeyManager.matches('tool_door', e)) {
            e.preventDefault();
            setTool('csg');
            csgActions.setHoleMode(true, true);
            showMessage('DOOR mode — click a wall');
            return;
        }
        if (hotkeyManager.matches('tool_platform', e)) {
            e.preventDefault();
            setTool('platform');
            return;
        }
        if (hotkeyManager.matches('tool_simple_stairs', e)) {
            e.preventDefault();
            setTool('platform');
            state.platformPhase = 'simple_stair_from';
            state.simpleStairFrom = null;
            showMessage('Click first stair endpoint — Esc to cancel');
            return;
        }
        if (hotkeyManager.matches('tool_light', e)) {
            e.preventDefault();
            setTool('light');
            return;
        }
        if (hotkeyManager.matches('tool_brace', e)) {
            e.preventDefault();
            setTool('csg');
            csgActions.setBraceMode(true);
            showMessage('BRACE mode — aim at a wall, click to place arch');
            return;
        }
        if (hotkeyManager.matches('tool_pillar', e)) {
            e.preventDefault();
            setTool('csg');
            csgActions.setPillarMode(true);
            showMessage('PILLAR mode — aim at floor, scroll to size, click to place');
            return;
        }
    }

    // M key to switch to terrain
    if (hotkeyManager.matches('toggle_mode', e) && isPointerLocked()) {
        e.preventDefault();
        toggleEditorMode();
        return;
    }

    // ─── CSG tool keys ──────────────────────────────────────────────
    if (state.tool === 'csg' && isPointerLocked()) {
        // Push/pull (also handles extrude continuation when activeOp === 'extrude')
        if (hotkeyManager.matches('push', e)) {
            e.preventDefault();
            if (!csgActions.growActiveExtrude()) {
                saveUndoState();
                csgActions.pushSelectedFace();
            }
            return;
        }
        if (hotkeyManager.matches('pull', e)) {
            e.preventDefault();
            saveUndoState();
            csgActions.pullSelectedFace();
            return;
        }
        // Arrow keys: adjust pending stair counter (no CSG rebuild yet)
        if (hotkeyManager.matches('stair_down', e)) {
            e.preventDefault();
            csgActions.pushSelectedFaceAsStairs('down');
            if (state.csg.pendingStairOp) {
                const op = state.csg.pendingStairOp;
                showMessage(`Stairs: ${op.stepCount} step${op.stepCount > 1 ? 's' : ''} ${op.direction} \u2014 Enter to confirm, Esc to cancel`);
            }
            return;
        }
        if (hotkeyManager.matches('stair_up', e)) {
            e.preventDefault();
            csgActions.pushSelectedFaceAsStairs('up');
            if (state.csg.pendingStairOp) {
                const op = state.csg.pendingStairOp;
                showMessage(`Stairs: ${op.stepCount} step${op.stepCount > 1 ? 's' : ''} ${op.direction} \u2014 Enter to confirm, Esc to cancel`);
            }
            return;
        }
        // Enter: confirm pending stair op
        if (e.code === 'Enter' && state.csg.pendingStairOp) {
            e.preventDefault();
            saveUndoState();
            const desc = csgActions.confirmStairOp();
            if (desc) {
                rebuildCsgStair(desc);
                showMessage(`Stairs confirmed: ${desc.stepCount} steps ${desc.direction}`);
            }
            return;
        }
        // E = extrude selected face
        if (e.code === 'KeyE') {
            e.preventDefault();
            saveUndoState();
            csgActions.extrudeSelectedFace();
            return;
        }
        // B = bake current region
        if (e.code === 'KeyB') {
            e.preventDefault();
            saveUndoState();
            csgActions.bakeCurrentRegion();
            showMessage('Baked');
            return;
        }
        // [ / ] = scale (taper) selected face
        if (e.code === 'BracketLeft') {
            e.preventDefault();
            saveUndoState();
            if (e.shiftKey) csgActions.scaleSelectedFace(1, 0);
            else if (e.ctrlKey) csgActions.scaleSelectedFace(0, 1);
            else csgActions.scaleSelectedFace(1, 1);
            return;
        }
        if (e.code === 'BracketRight') {
            e.preventDefault();
            saveUndoState();
            if (e.shiftKey) csgActions.scaleSelectedFace(-1, 0);
            else if (e.ctrlKey) csgActions.scaleSelectedFace(0, -1);
            else csgActions.scaleSelectedFace(-1, -1);
            return;
        }
        // Main-row digit keys (Digit1..Digit9): retexture room.
        // Use e.code, NOT e.key, so numpad numbers (Numpad1..Numpad6 — used
        // for tool switching above) don't trigger retexture when NumLock is on.
        if (e.code >= 'Digit1' && e.code <= 'Digit9') {
            const digit = e.code.slice(5); // 'Digit1' → '1'
            const schemeName = getSchemeByKey(digit);
            if (schemeName && state.csg.selectedFace) {
                e.preventDefault();
                saveUndoState();
                csgActions.retextureRoom(schemeName);
                showMessage('Scheme: ' + (TEXTURE_SCHEMES[schemeName]?.label || schemeName));
                return;
            }
        }
        // Delete = remove selected brush
        if ((hotkeyManager.matches('delete', e) || e.key === 'Delete') && state.csg.selectedFace) {
            e.preventDefault();
            saveUndoState();
            csgActions.deleteSelectedBrush();
            return;
        }
        // Escape = cancel pending stair / hole / brace mode or deselect
        if (hotkeyManager.matches('escape', e)) {
            e.preventDefault();
            if (state.csg.pendingStairOp) {
                csgActions.cancelStairOp();
                showMessage('Stair cancelled');
            } else if (state.csg.holeMode) {
                csgActions.exitHoleMode();
                showMessage('Hole mode cancelled');
            } else if (state.csg.braceMode) {
                csgActions.exitBraceMode();
                showMessage('Brace mode cancelled');
            } else if (state.csg.pillarMode) {
                csgActions.exitPillarMode();
                showMessage('Pillar mode cancelled');
            } else {
                state.csg.selectedFace = null;
                state.csg.activeBrush = null;
                state.csg.activeOp = null;
                state.csg.activeSide = null;
                state.csg.activeStairOp = null;
            }
            return;
        }
        // Fall through to global keys (undo, save, load, view toggles)
    }

    // Platform tool keys
    if (state.tool === 'platform' && isPointerLocked()) {
        const selectedPlat = state.selectedPlatformId != null
            ? state.platforms.find(p => p.id === state.selectedPlatformId)
            : null;

        // Escape = cancel gizmo drag, cancel connect, or deselect
        if (hotkeyManager.matches('escape', e)) {
            e.preventDefault();
            if (gizmo.isDragging()) {
                gizmo.cancelDrag();
                rebuildPlatform(selectedPlat);
                rebuildConnectedStairRuns(selectedPlat.id);
                showMessage('Cancelled');
            } else if (state.platformPhase === 'simple_stair_from' || state.platformPhase === 'simple_stair_to') {
                state.platformPhase = 'idle';
                state.simpleStairFrom = null;
                showMessage('Cancelled');
            } else if (state.platformPhase === 'connecting_src' || state.platformPhase === 'connecting_dst') {
                state.platformPhase = 'selected';
                state.platformConnectFrom = null;
                state.platformConnectTo = null;
                showMessage('Cancelled');
            } else {
                clearPlatformToolState();
                gizmo.update(null, camera);
                showMessage('Platform deselected');
            }
            return;
        }

        // Connect mode
        if (hotkeyManager.matches('connect_stairs', e) && selectedPlat && state.platformPhase === 'selected') {
            e.preventDefault();
            state.platformConnectFrom = { platformId: selectedPlat.id, edge: null, offset: 0.5 };
            state.platformConnectTo = null;
            state.platformPhase = 'connecting_dst';
            showMessage(`Click destination platform or floor — Esc to cancel`);
            return;
        }

        // Simple stair mode
        if (hotkeyManager.matches('simple_stairs', e) && state.platformPhase === 'idle') {
            e.preventDefault();
            state.platformPhase = 'simple_stair_from';
            state.simpleStairFrom = null;
            showMessage('Click first stair endpoint — Esc to cancel');
            return;
        }

        // Toggle grounded on platform + connected stairs
        if (hotkeyManager.matches('toggle_grounded', e) && selectedPlat && state.platformPhase === 'selected') {
            e.preventDefault();
            saveUndoState();
            const newGrounded = !selectedPlat.grounded;
            selectedPlat.grounded = newGrounded;
            rebuildPlatform(selectedPlat);
            const connectedRuns = state.stairRuns.filter(
                r => r.fromPlatformId === selectedPlat.id || r.toPlatformId === selectedPlat.id
            );
            for (const run of connectedRuns) {
                run.grounded = newGrounded;
                rebuildStairRun(run);
            }
            const count = connectedRuns.length;
            const label = newGrounded ? 'grounded' : 'floating';
            showMessage(count > 0
                ? `Platform + ${count} stair run${count > 1 ? 's' : ''} ${label}`
                : `Platform ${label}`);
            return;
        }

        // Toggle railings on platform + connected stairs
        if (hotkeyManager.matches('toggle_railings', e) && selectedPlat && state.platformPhase === 'selected') {
            e.preventDefault();
            saveUndoState();
            const newRailings = !selectedPlat.railings;
            selectedPlat.railings = newRailings;
            rebuildPlatform(selectedPlat);
            const connectedRuns = state.stairRuns.filter(
                r => r.fromPlatformId === selectedPlat.id || r.toPlatformId === selectedPlat.id
            );
            for (const run of connectedRuns) {
                run.railings = newRailings;
                rebuildStairRun(run);
            }
            const count = connectedRuns.length;
            const label = newRailings ? 'ON' : 'OFF';
            showMessage(count > 0
                ? `Railings ${label} (platform + ${count} stair run${count > 1 ? 's' : ''})`
                : `Railings ${label}`);
            return;
        }

        // Delete selected platform
        if ((hotkeyManager.matches('delete', e) || e.key === 'Delete') && selectedPlat && state.platformPhase === 'selected') {
            e.preventDefault();
            saveUndoState();
            const connectedRuns = state.stairRuns.filter(r => r.fromPlatformId === selectedPlat.id || r.toPlatformId === selectedPlat.id);
            for (const run of connectedRuns) {
                const mesh = stairRunMeshes.get(run.id);
                if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); stairRunMeshes.delete(run.id); }
            }
            state.stairRuns = state.stairRuns.filter(r => r.fromPlatformId !== selectedPlat.id && r.toPlatformId !== selectedPlat.id);
            state.platforms = state.platforms.filter(p => p.id !== selectedPlat.id);
            removePlatformMesh(selectedPlat.id);
            clearPlatformToolState();
            showMessage('Platform deleted');
            return;
        }

        // --- Selected stair run keys (F/R/X) ---
        const selectedRun = state.selectedStairRunId != null
            ? state.stairRuns.find(r => r.id === state.selectedStairRunId)
            : null;

        if (hotkeyManager.matches('toggle_grounded', e) && selectedRun && state.platformPhase === 'selected') {
            e.preventDefault();
            saveUndoState();
            selectedRun.grounded = !selectedRun.grounded;
            rebuildStairRun(selectedRun);
            showMessage(`Stair run ${selectedRun.grounded ? 'grounded' : 'floating'}`);
            return;
        }

        if (hotkeyManager.matches('toggle_railings', e) && selectedRun && state.platformPhase === 'selected') {
            e.preventDefault();
            saveUndoState();
            selectedRun.railings = !selectedRun.railings;
            rebuildStairRun(selectedRun);
            showMessage(`Stair run railings ${selectedRun.railings ? 'ON' : 'OFF'}`);
            return;
        }

        if ((hotkeyManager.matches('delete', e) || e.key === 'Delete') && selectedRun && state.platformPhase === 'selected') {
            e.preventDefault();
            saveUndoState();
            const mesh = stairRunMeshes.get(selectedRun.id);
            if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); stairRunMeshes.delete(selectedRun.id); }
            state.stairRuns = state.stairRuns.filter(r => r.id !== selectedRun.id);
            clearPlatformToolState();
            showMessage('Stair run deleted');
            return;
        }
    }

    // Light tool keys
    if (state.tool === 'light' && isPointerLocked()) {
        const selectedLight = state.selectedLightId != null
            ? state.pointLights.find(l => l.id === state.selectedLightId)
            : null;

        // Escape = cancel gizmo drag or deselect
        if (hotkeyManager.matches('escape', e)) {
            e.preventDefault();
            if (gizmo.isDragging()) {
                gizmo.cancelDrag();
                if (selectedLight) rebuildLight(selectedLight);
                showMessage('Cancelled');
            } else {
                clearLightToolState();
                updateLightSelection();
                showMessage('Light deselected');
            }
            return;
        }

        // Delete selected light
        if ((hotkeyManager.matches('delete', e) || e.key === 'Delete') && selectedLight) {
            e.preventDefault();
            saveUndoState();
            state.pointLights = state.pointLights.filter(l => l.id !== selectedLight.id);
            removeLightMesh(selectedLight.id);
            clearLightToolState();
            updateLightSelection();
            showMessage('Light deleted');
            return;
        }
    }

    if (hotkeyManager.matches('toggle_view', e) && isPointerLocked()) {
        e.preventDefault();
        state.viewMode = state.viewMode === 'grid' ? 'textured' : 'grid';
        showMessage('View: ' + (state.viewMode === 'grid' ? 'Grid' : 'Textured'));
        rebuildAllCSG();
        rebuildAllPlatforms();
        rebuildAllStairRuns();
        return;
    }

    if (hotkeyManager.matches('toggle_grid', e)) {
        e.preventDefault();
        state.showGrid = !state.showGrid;
        if (gridHelper) gridHelper.visible = state.showGrid;
        showMessage('Grid: ' + (state.showGrid ? 'ON' : 'OFF'));
        return;
    }

    // Wireframe toggle (was E in legacy code; CSG tool consumed E for extrude above).
    // Use Backslash so it doesn't conflict with CSG extrude.
    if (e.code === 'Backslash' && isPointerLocked()) {
        e.preventDefault();
        state.showWireframe = !state.showWireframe;
        setAllWireframeVisible(state.showWireframe);
        showMessage('Wireframe: ' + (state.showWireframe ? 'ON' : 'OFF'));
        return;
    }

    if (hotkeyManager.matches('undo', e)) {
        e.preventDefault();
        clearPlatformToolState();
        undoAction(showMessage, rebuildAll);
        return;
    }

    if (hotkeyManager.matches('save', e)) {
        e.preventDefault();
        saveLevel(showMessage);
        return;
    }

    if (hotkeyManager.matches('load', e)) {
        e.preventDefault();
        loadLevel(showMessage, rebuildAll);
        return;
    }
}
