// UI: level selector, display mode dropdown, and analysis controls

const LEVELS = [
    '01 - Dam',
    '02 - Facility',
    '03 - Runway',
    '04 - Surface1',
    '05 - Bunker1',
    '06 - Silo',
    '07 - Frigate',
    '08 - Surface2',
    '09 - Bunker2',
    '10 - Statue',
    '11 - Archives',
    '12 - Streets',
    '13 - Depot',
    '14 - Train',
    '15 - Jungle',
    '16 - Control',
    '17 - Caverns',
    '18 - Cradle',
    '19 - Aztec',
    '20 - Egyptian',
    '21 - Complex'
];

const MODE_NAMES = [
    'Textured',
    'Flat Shaded',
    'Vertex Colors',
    'Lit + VColors',
    'Wireframe',
    '--- Analysis ---',
    'Normal Direction',
    'Predicted Lighting',
    'Predicted + Textured',
    'Error Map',
    'AO Estimate',
    'NN Vertex Colors',
    'NN + Textured',
];

// Modes at index >= FIRST_ANALYSIS_MODE show the analysis panel
const FIRST_ANALYSIS_MODE = 6;
// The separator at index 5 is not selectable (disabled)
const SEPARATOR_INDEX = 5;

export function initUI({ onLevelChange, onToggleMode, onParamsChange, onComputeAO, onComputeHeights, onComputeNN }) {
    const levelSelect = document.getElementById('level-select');
    const modeSelect = document.getElementById('mode-select');
    const analysisPanel = document.getElementById('analysis-panel');
    const statsEl = document.getElementById('analysis-stats');

    // Populate level dropdown
    for (const name of LEVELS) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        levelSelect.appendChild(opt);
    }

    // Populate mode dropdown
    for (let i = 0; i < MODE_NAMES.length; i++) {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = MODE_NAMES[i];
        if (i === SEPARATOR_INDEX) {
            opt.disabled = true;
        }
        modeSelect.appendChild(opt);
    }
    modeSelect.value = 0;

    levelSelect.addEventListener('change', () => {
        onLevelChange(levelSelect.value);
    });

    modeSelect.addEventListener('change', () => {
        const idx = parseInt(modeSelect.value);
        updateAnalysisPanelVisibility(idx);
        onToggleMode(idx);
    });

    function updateAnalysisPanelVisibility(idx) {
        analysisPanel.style.display = idx >= FIRST_ANALYSIS_MODE ? 'block' : 'none';
    }

    // --- Analysis sliders ---
    const slAmbient = document.getElementById('sl-ambient');
    const slIntensity = document.getElementById('sl-intensity');
    const slHeight = document.getElementById('sl-height');
    const valAmbient = document.getElementById('val-ambient');
    const valIntensity = document.getElementById('val-intensity');
    const valHeight = document.getElementById('val-height');
    const slAoRadius = document.getElementById('sl-ao-radius');
    const valAoRadius = document.getElementById('val-ao-radius');
    const aoSamplesSelect = document.getElementById('ao-samples');

    function getParams() {
        return {
            ambient: parseInt(slAmbient.value) / 100,
            intensity: parseInt(slIntensity.value) / 100,
            heightFalloff: parseInt(slHeight.value) / 100,
            aoSamples: parseInt(aoSamplesSelect.value),
            aoRadius: parseInt(slAoRadius.value),
        };
    }

    function onSliderInput() {
        const p = getParams();
        valAmbient.textContent = p.ambient.toFixed(2);
        valIntensity.textContent = p.intensity.toFixed(2);
        valHeight.textContent = p.heightFalloff.toFixed(2);
        valAoRadius.textContent = p.aoRadius;
        if (onParamsChange) onParamsChange(p);
    }

    slAmbient.addEventListener('input', onSliderInput);
    slIntensity.addEventListener('input', onSliderInput);
    slHeight.addEventListener('input', onSliderInput);
    slAoRadius.addEventListener('input', onSliderInput);

    document.getElementById('btn-compute-ao').addEventListener('click', (e) => {
        e.stopPropagation();
        if (onComputeAO) onComputeAO(getParams());
    });

    document.getElementById('btn-compute-heights').addEventListener('click', (e) => {
        e.stopPropagation();
        if (onComputeHeights) onComputeHeights();
    });

    // NN compute button
    document.getElementById('btn-compute-nn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (onComputeNN) onComputeNN();
    });

    return {
        getModeIndex() { return parseInt(modeSelect.value); },
        getSelectedLevel() { return levelSelect.value; },
        getParams,
        showLoading(show) {
            document.getElementById('loading').style.display = show ? 'block' : 'none';
        },
        setLoadingText(text) {
            document.getElementById('loading').textContent = text;
        },
        showStats(stats) {
            if (!stats) {
                statsEl.textContent = '';
                return;
            }
            statsEl.innerHTML =
                `Mean error: ${(stats.meanError * 100).toFixed(1)}%<br>` +
                `Within 10%: ${(stats.within10Pct * 100).toFixed(1)}%<br>` +
                `Within 20%: ${(stats.within20Pct * 100).toFixed(1)}%`;
        }
    };
}
