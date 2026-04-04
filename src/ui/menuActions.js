// Menu action dispatcher — maps action IDs to editor operations
// Listens on EventBus for 'menu:action' events dispatched by RadialMenu

import { on } from '../systems/EventBus.js';
import { state } from '../state.js';
import { TEXTURE_SCHEMES } from '../scene/textureSchemes.js';
import { gridHelper } from '../scene/setup.js';

// Callbacks set during init to avoid circular imports with main.js
let callbacks = {};

export function initMenuActions(cbs) {
    callbacks = cbs;

    on('menu:action', ({ actionId }) => {
        if (actionId.startsWith('tool:')) {
            handleToolAction(actionId.slice(5));
        } else if (actionId.startsWith('texture:')) {
            handleTextureAction(actionId.slice(8));
        } else if (actionId.startsWith('view:')) {
            handleViewAction(actionId.slice(5));
        } else if (actionId.startsWith('lighting:')) {
            handleLightingAction(actionId.slice(9));
        }
    });
}

function handleToolAction(toolName) {
    if (toolName === 'simple_stairs') {
        state.tool = 'platform';
        if (callbacks.clearExtrudeState) callbacks.clearExtrudeState();
        state.platformPhase = 'simple_stair_from';
        state.simpleStairFrom = null;
        callbacks.showMessage('Click first stair endpoint — Esc to cancel');
        return;
    }

    const validTools = ['push_pull', 'door', 'extrude', 'platform', 'light'];
    if (!validTools.includes(toolName)) return;

    state.tool = toolName;
    if (toolName !== 'extrude' && callbacks.clearExtrudeState) callbacks.clearExtrudeState();
    if (toolName !== 'platform' && callbacks.clearPlatformToolState) callbacks.clearPlatformToolState();
    if (toolName !== 'light' && callbacks.clearLightToolState) callbacks.clearLightToolState();

    const names = { push_pull: 'Push/Pull', door: 'Door', extrude: 'Extrude', platform: 'Platform', light: 'Light' };
    callbacks.showMessage('Tool: ' + names[toolName]);
}

function handleLightingAction(action) {
    if (action === 'bake') {
        if (callbacks.bakeLighting) {
            callbacks.bakeLighting();
        } else {
            callbacks.showMessage('Bake not yet available');
        }
    } else if (action === 'clear') {
        if (callbacks.clearBake) {
            callbacks.clearBake();
        } else {
            callbacks.showMessage('Clear bake not yet available');
        }
    } else if (action === 'toggle_realtime') {
        if (callbacks.toggleRealtimePreview) {
            callbacks.toggleRealtimePreview();
        } else {
            callbacks.showMessage('Toggle not yet available');
        }
    }
}

function handleTextureAction(schemeName) {
    if (!TEXTURE_SCHEMES[schemeName]) return;
    if (!state.selectedFace) {
        callbacks.showMessage('Select a face first to apply texture');
        return;
    }
    const vol = state.volumes.find(v => v.id === state.selectedFace.volumeId);
    if (!vol) return;

    vol.textureScheme = schemeName;
    if (callbacks.rebuildVolume) callbacks.rebuildVolume(vol);
    callbacks.showMessage('Scheme: ' + TEXTURE_SCHEMES[schemeName].label);
}

function handleViewAction(mode) {
    if (mode === 'toggle_grid') {
        state.showGrid = !state.showGrid;
        if (gridHelper) gridHelper.visible = state.showGrid;
        callbacks.showMessage('Grid: ' + (state.showGrid ? 'ON' : 'OFF'));
        return;
    }
    if (mode !== 'grid' && mode !== 'textured') return;
    state.viewMode = mode;
    callbacks.showMessage('View: ' + (mode === 'grid' ? 'Grid' : 'Textured'));
    if (callbacks.rebuildAll) callbacks.rebuildAll();
}
