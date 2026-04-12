// UI: level selector dropdown and display mode toggle

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

const MODE_NAMES = ['Textured', 'Flat Shaded', 'Vertex Colors', 'Lit + VColors', 'Wireframe'];

export function initUI({ onLevelChange, onToggleMode }) {
    const select = document.getElementById('level-select');
    const toggleBtn = document.getElementById('toggle-mode');
    let modeIndex = 0;

    // Populate level dropdown
    for (const name of LEVELS) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
    }

    select.addEventListener('change', () => {
        onLevelChange(select.value);
    });

    function cycleMode() {
        modeIndex = (modeIndex + 1) % MODE_NAMES.length;
        toggleBtn.textContent = MODE_NAMES[modeIndex];
        onToggleMode(modeIndex);
    }

    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        cycleMode();
    });

    return {
        cycleMode,
        getSelectedLevel() { return select.value; },
        showLoading(show) {
            document.getElementById('loading').style.display = show ? 'block' : 'none';
        }
    };
}
