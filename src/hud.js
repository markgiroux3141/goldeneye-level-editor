// HUD updates and message display

import { state } from './state.js';
import { on } from './systems/EventBus.js';

const statusEl = document.getElementById('status');
const toolInfoEl = document.getElementById('tool-info');
const messageEl = document.getElementById('message');
const doorWidthInput = document.getElementById('door-width');
const doorHeightInput = document.getElementById('door-height');
const pushStepInput = document.getElementById('push-step');
const extrudeWidthInput = document.getElementById('extrude-width');
const extrudeHeightInput = document.getElementById('extrude-height');
const stairWidthInput = document.getElementById('stair-width');
const stairStepHeightInput = document.getElementById('stair-step-height');
const stairRiseRunInput = document.getElementById('stair-rise-run');
let messageTimeout = null;

// Sync HUD inputs to state
export function initHUD() {
    doorWidthInput.addEventListener('change', () => {
        state.doorWidth = parseFloat(doorWidthInput.value) || 2;
    });
    doorHeightInput.addEventListener('change', () => {
        state.doorHeight = parseFloat(doorHeightInput.value) || 3;
    });
    pushStepInput.addEventListener('change', () => {
        state.pushStep = parseFloat(pushStepInput.value) || 1;
    });
    extrudeWidthInput.addEventListener('change', () => {
        state.extrudeWidth = parseFloat(extrudeWidthInput.value) || 2;
    });
    extrudeHeightInput.addEventListener('change', () => {
        state.extrudeHeight = parseFloat(extrudeHeightInput.value) || 2;
    });
    stairWidthInput.addEventListener('change', () => {
        state.stairWidth = parseInt(stairWidthInput.value) || 4;
    });
    stairStepHeightInput.addEventListener('change', () => {
        state.stairStepHeight = Math.max(1, parseInt(stairStepHeightInput.value) || 1);
    });
    stairRiseRunInput.addEventListener('change', () => {
        state.stairRiseOverRun = Math.max(0.1, parseFloat(stairRiseRunInput.value) || 1);
    });

    // Listen for messages via EventBus
    on('message', ({ text }) => showMessage(text));
}

export function showMessage(msg) {
    messageEl.textContent = msg;
    messageEl.style.opacity = '1';
    if (messageTimeout) clearTimeout(messageTimeout);
    messageTimeout = setTimeout(() => { messageEl.style.opacity = '0'; }, 2000);
}

const TOOL_LABELS = { push_pull: 'PUSH/PULL', door: 'DOOR', extrude: 'EXTRUDE', stair: 'STAIR' };

export function updateHUD(camera) {
    const lines = [];

    if (state.tool === 'stair') {
        if (state.stairPhase === 'placing') {
            lines.push(`Waypoints: ${state.stairWaypoints.length}`);
            lines.push(`Click to add, Enter to finalize`);
            lines.push(`Backspace to undo last point`);
        } else {
            lines.push(`Click first waypoint`);
        }
        lines.push(`Side: ${state.stairSide.toUpperCase()} (R to toggle)`);
    } else if (state.tool === 'extrude') {
        // Extrude tool status
        if (state.extrudePhase === 'selecting') {
            lines.push(`Selections: ${state.extrudeSelections.length}`);
            lines.push(`Shift+Click for more, + to extrude`);
        } else if (state.extrudePhase === 'extruded') {
            lines.push(`Extruded: ${state.extrudedVolumes.length} volume${state.extrudedVolumes.length > 1 ? 's' : ''}`);
            lines.push(`+/- to extend/shrink`);
        } else {
            lines.push(`Click a wall to select region`);
        }
    } else if (state.selectedFace) {
        const f = state.selectedFace;
        const vol = state.volumes.find(v => v.id === f.volumeId);
        if (vol) {
            const bw = f.bounds.u1 - f.bounds.u0;
            const bh = f.bounds.v1 - f.bounds.v0;
            lines.push(`Vol ${vol.id} | ${f.axis}-${f.side} @ ${f.position}`);
            lines.push(`Face: ${bw} x ${bh}`);
            lines.push(`Volume: ${vol.w} x ${vol.h} x ${vol.d}`);
        }
    }

    lines.push(`Volumes: ${state.volumes.length} | Connections: ${state.connections.length} | Stairs: ${state.staircases.length}`);
    statusEl.innerHTML = lines.join('<br>');

    const toolName = TOOL_LABELS[state.tool] || state.tool;
    const p = camera.position;
    toolInfoEl.innerHTML = `Tool: ${toolName}<br>Pos: ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`;
}
