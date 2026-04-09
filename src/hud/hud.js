// HUD updates and message display

import { state } from '../state.js';
import { on } from '../systems/EventBus.js';
import { TEXTURE_SCHEMES } from '../scene/textureSchemes.js';
import { hotkeyManager } from '../input/HotkeyManager.js';

const statusEl = document.getElementById('status');
const toolInfoEl = document.getElementById('tool-info');
const messageEl = document.getElementById('message');
const stairWidthInput = document.getElementById('stair-width');
const stairStepHeightInput = document.getElementById('stair-step-height');
const stairRiseRunInput = document.getElementById('stair-rise-run');
const platformSizeXInput = document.getElementById('platform-size-x');
const platformSizeZInput = document.getElementById('platform-size-z');
const platformThicknessInput = document.getElementById('platform-thickness');
let messageTimeout = null;

// Sync HUD inputs to state
export function initHUD() {
    if (stairWidthInput) {
        stairWidthInput.addEventListener('change', () => {
            state.stairWidth = parseInt(stairWidthInput.value) || 4;
        });
    }
    if (stairStepHeightInput) {
        stairStepHeightInput.addEventListener('change', () => {
            state.stairStepHeight = Math.max(1, parseInt(stairStepHeightInput.value) || 1);
        });
    }
    if (stairRiseRunInput) {
        stairRiseRunInput.addEventListener('change', () => {
            state.stairRiseOverRun = Math.max(0.1, parseFloat(stairRiseRunInput.value) || 1);
        });
    }
    if (platformSizeXInput) {
        platformSizeXInput.addEventListener('change', () => {
            state.platformSizeX = Math.max(1, parseInt(platformSizeXInput.value) || 4);
        });
    }
    if (platformSizeZInput) {
        platformSizeZInput.addEventListener('change', () => {
            state.platformSizeZ = Math.max(1, parseInt(platformSizeZInput.value) || 4);
        });
    }
    if (platformThicknessInput) {
        platformThicknessInput.addEventListener('change', () => {
            state.platformThickness = Math.max(1, parseInt(platformThicknessInput.value) || 1);
        });
    }

    // Listen for messages via EventBus
    on('message', ({ text }) => showMessage(text));
}

export function showMessage(msg) {
    messageEl.textContent = msg;
    messageEl.style.opacity = '1';
    if (messageTimeout) clearTimeout(messageTimeout);
    messageTimeout = setTimeout(() => { messageEl.style.opacity = '0'; }, 2000);
}

// Returns the active tool's display label, taking CSG sub-modes into account.
function currentToolLabel() {
    if (state.tool === 'csg') {
        if (state.csg.holeMode) return state.csg.holeDoor ? 'DOOR' : 'HOLE';
        return 'CSG';
    }
    if (state.tool === 'platform') return 'PLATFORM';
    if (state.tool === 'light')    return 'LIGHT';
    return state.tool;
}

export function updateHUD(camera) {
    const terrainSettingsEl = document.getElementById('terrain-settings');
    if (terrainSettingsEl) terrainSettingsEl.style.display = 'none';
    const lightSettingsEl = document.getElementById('light-settings');
    if (lightSettingsEl) lightSettingsEl.style.display = 'none';
    const lines = [];

    if (state.tool === 'light') {
        if (lightSettingsEl && state.selectedLightId != null) {
            lightSettingsEl.style.display = '';
        }
        const light = state.selectedLightId != null
            ? state.pointLights.find(l => l.id === state.selectedLightId)
            : null;
        if (light) {
            const hex = '#' + ((light.color.r * 255 | 0) << 16 | (light.color.g * 255 | 0) << 8 | (light.color.b * 255 | 0)).toString(16).padStart(6, '0');
            lines.push(`Light ${light.id}: (${light.x}, ${light.y}, ${light.z})`);
            lines.push(`Color: ${hex}  Int: ${light.intensity}  Range: ${light.range}`);
            lines.push(`Click arrows to move, X=delete, Esc=deselect`);
            // Sync settings inputs to selected light values
            const colorInput = document.getElementById('light-color');
            const intensityInput = document.getElementById('light-intensity');
            const rangeInput = document.getElementById('light-range');
            if (colorInput && colorInput !== document.activeElement) colorInput.value = hex;
            if (intensityInput && intensityInput !== document.activeElement) intensityInput.value = light.intensity;
            if (rangeInput && rangeInput !== document.activeElement) rangeInput.value = light.range;
            const ambientInput = document.getElementById('light-ambient');
            if (ambientInput && ambientInput !== document.activeElement) ambientInput.value = state.bakeAmbient;
        } else {
            lines.push(`Click to place light`);
            // Still show light settings for ambient even when no light selected
            if (lightSettingsEl) lightSettingsEl.style.display = '';
        }
        lines.push(`Lights: ${state.pointLights.length}  Ambient: ${state.bakeAmbient}`);
    } else if (state.tool === 'platform') {
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
    } else if (state.tool === 'csg') {
        const sel = state.csg.selectedFace;
        if (sel) {
            const brush = state.csg.brushes.find(b => b.id === sel.brushId);
            const isBaked = sel.brushId === 0;
            const isShell = sel.brushId === -1;
            const opLabel = isBaked ? 'baked' : isShell ? 'shell' : (brush ? brush.op : '?');
            lines.push(`Brush ${sel.brushId} (${opLabel}) | region ${sel.regionId} | ${sel.axis}-${sel.side} @ ${sel.position}`);

            if (brush && !isBaked && !isShell) {
                lines.push(`Size: ${brush.w} x ${brush.h} x ${brush.d}`);
            }

            // Sub-face vs full-face indicator
            const selSizeU = state.csg.selSizeU;
            const selSizeV = state.csg.selSizeV;
            if (selSizeU > 0 || selSizeV > 0) {
                lines.push(`Sub-face selection: ${selSizeU || 'full'} x ${selSizeV || 'full'} (scroll to resize)`);
            } else {
                lines.push(`Full face (scroll to shrink)`);
            }

            // Taper for the selected face, if any
            if (brush && brush.taper) {
                const faceKey = `${sel.axis}-${sel.side}`;
                const t = brush.taper[faceKey];
                if (t && (t.u || t.v)) {
                    lines.push(`Taper: u=${t.u} v=${t.v}`);
                }
            }

            // Active operation indicator (so user knows +/- will continue an op)
            if (state.csg.activeOp) {
                lines.push(`Active: ${state.csg.activeOp} (+/- to continue, Esc to clear)`);
            }

            // Texture scheme
            const schemeKey = brush ? brush.schemeKey : null;
            const schemeName = schemeKey
                ? (TEXTURE_SCHEMES[schemeKey]?.label || schemeKey)
                : '—';
            lines.push(`Scheme: ${schemeName}`);
        } else if (state.csg.holeMode) {
            lines.push(state.csg.holeDoor ? 'DOOR mode — click a wall' : 'HOLE mode — click any face');
            const csgKey = hotkeyManager.getDisplayKey('tool_csg');
            lines.push(`${csgKey} return to CSG, Esc cancel`);
        } else {
            const holeKey = hotkeyManager.getDisplayKey('tool_hole');
            const doorKey = hotkeyManager.getDisplayKey('tool_door');
            lines.push(`Click a face to select`);
            lines.push(`+/- push/pull, E extrude, ${holeKey} hole, ${doorKey} door, B bake, [/] taper, 1-9 retexture`);
        }
    }

    lines.push(`Brushes: ${state.csg.brushes.length} (baked: ${state.csg.totalBakedBrushes}) | Platforms: ${state.platforms.length} | Stair Runs: ${state.stairRuns.length}`);
    statusEl.innerHTML = lines.join('<br>');

    const toolName = currentToolLabel();
    const p = camera.position;
    toolInfoEl.innerHTML = `Tool: ${toolName}<br>Pos: ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`;
}
