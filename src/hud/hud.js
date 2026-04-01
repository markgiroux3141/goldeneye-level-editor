// HUD updates and message display

import { state } from './state.js';
import { on } from './systems/EventBus.js';
import { TEXTURE_SCHEMES } from './textureSchemes.js';

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
const platformSizeXInput = document.getElementById('platform-size-x');
const platformSizeZInput = document.getElementById('platform-size-z');
const platformThicknessInput = document.getElementById('platform-thickness');
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
    platformSizeXInput.addEventListener('change', () => {
        state.platformSizeX = Math.max(1, parseInt(platformSizeXInput.value) || 4);
    });
    platformSizeZInput.addEventListener('change', () => {
        state.platformSizeZ = Math.max(1, parseInt(platformSizeZInput.value) || 4);
    });
    platformThicknessInput.addEventListener('change', () => {
        state.platformThickness = Math.max(1, parseInt(platformThicknessInput.value) || 1);
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

const TOOL_LABELS = { push_pull: 'PUSH/PULL', door: 'DOOR', extrude: 'EXTRUDE', platform: 'PLATFORM' };

export function updateHUD(camera) {
    const terrainSettingsEl = document.getElementById('terrain-settings');
    if (terrainSettingsEl) terrainSettingsEl.style.display = 'none';
    const lines = [];

    if (state.tool === 'platform') {
        if (state.platformPhase === 'idle') {
            lines.push(`Click to place or select platform`);
            lines.push(`N=simple stairs`);
        } else if (state.platformPhase === 'selected') {
            const plat = state.platforms.find(p => p.id === state.selectedPlatformId);
            if (plat) {
                const grLabel = plat.grounded ? ' [grounded]' : '';
                lines.push(`Platform ${plat.id}: ${plat.sizeX}x${plat.sizeZ} at Y=${plat.y}${grLabel}`);
                lines.push(`Click arrows to move, edge handles to scale`);
                lines.push(`X=delete  C=connect stairs  F=ground  R=railings`);
            }
            const run = state.selectedStairRunId != null
                ? state.stairRuns.find(r => r.id === state.selectedStairRunId)
                : null;
            if (run) {
                const grLabel = run.grounded ? ' [grounded]' : '';
                const rlLabel = run.railings ? ' [railings]' : '';
                lines.push(`Stair run ${run.id}${grLabel}${rlLabel}`);
                lines.push(`X=delete  F=ground  R=railings`);
            }
        } else if (state.platformPhase === 'simple_stair_from') {
            lines.push(`Click first stair endpoint (any surface)`);
            lines.push(`Esc=cancel`);
        } else if (state.platformPhase === 'simple_stair_to') {
            lines.push(`Click second stair endpoint`);
            lines.push(`Esc=cancel`);
        } else if (state.platformPhase === 'connecting_dst') {
            lines.push(`Click destination platform or floor`);
        } else if (state.platformPhase === 'connecting_src') {
            lines.push(`Slide along edge — click to place stairs`);
        }
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
            const scheme = TEXTURE_SCHEMES[vol.textureScheme];
            const schemeName = scheme ? scheme.label : vol.textureScheme;
            lines.push(`Vol ${vol.id} | ${f.axis}-${f.side} @ ${f.position}`);
            lines.push(`Face: ${bw} x ${bh}`);
            lines.push(`Volume: ${vol.w} x ${vol.h} x ${vol.d}`);
            lines.push(`Scheme: ${schemeName}`);
        }
    }

    lines.push(`Volumes: ${state.volumes.length} | Connections: ${state.connections.length} | Platforms: ${state.platforms.length} | Stair Runs: ${state.stairRuns.length}`);
    statusEl.innerHTML = lines.join('<br>');

    const toolName = TOOL_LABELS[state.tool] || state.tool;
    const p = camera.position;
    toolInfoEl.innerHTML = `Tool: ${toolName}<br>Pos: ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`;
}
