// Indoor mode key handler

import { state, saveUndoState } from '../state.js';
import { isPointerLocked } from '../input/input.js';
import { showMessage } from '../hud/hud.js';
import { scene, gridHelper } from '../scene/setup.js';
import { TEXTURE_SCHEMES, getSchemeByKey } from '../scene/textureSchemes.js';
import { hotkeyManager } from '../input/HotkeyManager.js';
import {
    pushSelectedFace, pullSelectedFace,
    deleteSelectedVolume, undoAction,
    saveLevel, loadLevel,
    executeExtrude, reExtrudeVolumes,
    extrudeUntilBlocked, clearExtrudeState,
} from '../actions.js';
import {
    volumeMeshes, stairRunMeshes,
    rebuildVolume, rebuildAllVolumes, removeVolumeMesh,
    rebuildPlatform, rebuildStairRun, rebuildConnectedStairRuns,
    rebuildAllPlatforms, rebuildAllStairRuns,
    rebuildAll, removePlatformMesh,
    rebuildLight, removeLightMesh, updateLightSelection,
    setAllWireframeVisible,
} from '../mesh/MeshManager.js';
import { toggleEditorMode, cycleToolForward, clearPlatformToolState, clearLightToolState } from './ToolManager.js';

export function handleIndoorKey(e, { gizmo, camera }) {
    // M key to switch to terrain
    if (hotkeyManager.matches('toggle_mode', e) && isPointerLocked()) {
        e.preventDefault();
        toggleEditorMode();
        return;
    }

    // Extrude tool: +/- for extrude/shrink, Shift++ for extrude until blocked
    if (state.tool === 'extrude') {
        if (hotkeyManager.matches('push', e)) {
            e.preventDefault();
            if (e.shiftKey && state.extrudePhase === 'extruded') {
                extrudeUntilBlocked(showMessage, rebuildAllVolumes);
            } else if (state.extrudePhase === 'selecting') {
                executeExtrude(showMessage, rebuildAllVolumes);
            } else if (state.extrudePhase === 'extruded') {
                reExtrudeVolumes('push', showMessage, rebuildAllVolumes);
            }
            return;
        }
        if (hotkeyManager.matches('pull', e)) {
            e.preventDefault();
            if (state.extrudePhase === 'extruded') {
                reExtrudeVolumes('pull', showMessage, rebuildAllVolumes);
            }
            return;
        }
    }

    // Push/Pull tool: +/- for push/pull
    if (hotkeyManager.matches('push', e) && state.selectedFace && state.tool === 'push_pull') {
        e.preventDefault();
        pushSelectedFace(showMessage, rebuildVolume, rebuildAllVolumes);
        return;
    }

    if (hotkeyManager.matches('pull', e) && state.selectedFace && state.tool === 'push_pull') {
        e.preventDefault();
        pullSelectedFace(showMessage, rebuildVolume);
        return;
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
        rebuildAllVolumes();
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

    // E = toggle wireframe edges
    if (e.code === 'KeyE' && isPointerLocked()) {
        e.preventDefault();
        state.showWireframe = !state.showWireframe;
        setAllWireframeVisible(state.showWireframe);
        showMessage('Wireframe: ' + (state.showWireframe ? 'ON' : 'OFF'));
        return;
    }

    // Number keys: set texture scheme on selected volume
    if (e.key >= '1' && e.key <= '9' && isPointerLocked() && state.selectedFace) {
        const schemeName = getSchemeByKey(e.key);
        if (schemeName) {
            e.preventDefault();
            const vol = state.volumes.find(v => v.id === state.selectedFace.volumeId);
            if (vol) {
                vol.textureScheme = schemeName;
                rebuildVolume(vol);
                showMessage('Scheme: ' + TEXTURE_SCHEMES[schemeName].label);
            }
            return;
        }
    }

    if (hotkeyManager.matches('cycle_tool', e) && isPointerLocked()) {
        e.preventDefault();
        cycleToolForward();
        return;
    }

    if ((hotkeyManager.matches('delete', e) || e.key === 'Delete') && state.selectedFace && isPointerLocked()) {
        e.preventDefault();
        const deletedId = deleteSelectedVolume(showMessage, rebuildAllVolumes);
        if (deletedId) removeVolumeMesh(deletedId);
        return;
    }

    if (hotkeyManager.matches('undo', e)) {
        e.preventDefault();
        clearExtrudeState();
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

    if (hotkeyManager.matches('escape', e) && state.tool !== 'platform' && state.tool !== 'light') {
        if (state.tool === 'extrude') {
            clearExtrudeState();
        }
        state.selectedFace = null;
        rebuildAllVolumes();
    }
}
