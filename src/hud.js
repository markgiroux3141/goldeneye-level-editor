// HUD updates and message display

import { state } from './state.js';

const statusEl = document.getElementById('status');
const toolInfoEl = document.getElementById('tool-info');
const messageEl = document.getElementById('message');
const doorWidthInput = document.getElementById('door-width');
const doorHeightInput = document.getElementById('door-height');
const pushStepInput = document.getElementById('push-step');
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
}

export function showMessage(msg) {
    messageEl.textContent = msg;
    messageEl.style.opacity = '1';
    if (messageTimeout) clearTimeout(messageTimeout);
    messageTimeout = setTimeout(() => { messageEl.style.opacity = '0'; }, 2000);
}

export function updateHUD(camera) {
    const lines = [];

    if (state.selectedFace) {
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

    lines.push(`Volumes: ${state.volumes.length} | Connections: ${state.connections.length}`);
    statusEl.innerHTML = lines.join('<br>');

    const toolName = state.tool === 'push_pull' ? 'PUSH/PULL' : 'DOOR';
    const p = camera.position;
    toolInfoEl.innerHTML = `Tool: ${toolName}<br>Pos: ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`;
}
