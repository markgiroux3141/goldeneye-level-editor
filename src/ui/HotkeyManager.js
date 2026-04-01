// Configurable hotkey system with localStorage persistence

const STORAGE_KEY = 'goldeneye-hotkeys';

// Default bindings: actionId -> keyCode
// Actions use e.code (positional) except +/- which use e.key (character)
const DEFAULT_BINDINGS = {
    'cycle_tool':       'KeyT',
    'toggle_view':      'KeyV',
    'toggle_mode':      'KeyM',
    'push':             'Equal',      // +/= key
    'pull':             'Minus',      // - key
    'delete':           'KeyX',
    'undo':             'Ctrl+KeyZ',
    'save':             'Ctrl+KeyS',
    'load':             'Ctrl+KeyO',
    'simple_stairs':    'KeyN',
    'connect_stairs':   'KeyC',
    'toggle_grounded':  'KeyF',
    'toggle_railings':  'KeyR',
    'toggle_grid':      'KeyH',
    'escape':           'Escape',
};

// Human-readable labels for the rebind UI
const ACTION_LABELS = {
    'cycle_tool':       'Cycle Tool',
    'toggle_view':      'Toggle View',
    'toggle_mode':      'Toggle Indoor/Terrain',
    'push':             'Push / Extrude',
    'pull':             'Pull / Shrink',
    'delete':           'Delete',
    'undo':             'Undo',
    'save':             'Save',
    'load':             'Load',
    'simple_stairs':    'Simple Stairs',
    'connect_stairs':   'Connect Stairs',
    'toggle_grounded':  'Toggle Grounded',
    'toggle_railings':  'Toggle Railings',
    'toggle_grid':      'Toggle Grid Lines',
    'escape':           'Cancel / Deselect',
};

class HotkeyManager {
    constructor() {
        this.bindings = { ...DEFAULT_BINDINGS };
        this._load();
    }

    // Get the key binding string for an action
    getBinding(actionId) {
        return this.bindings[actionId] || DEFAULT_BINDINGS[actionId] || null;
    }

    // Get a display-friendly key name for showing in menus
    getDisplayKey(actionId) {
        const binding = this.getBinding(actionId);
        if (!binding) return '';
        return formatKeyForDisplay(binding);
    }

    // Check if a keyboard event matches a given action
    matches(actionId, e) {
        const binding = this.getBinding(actionId);
        if (!binding) return false;
        return eventMatchesBinding(binding, e);
    }

    // Find which action (if any) matches the event
    getActionForEvent(e) {
        for (const [actionId, binding] of Object.entries(this.bindings)) {
            if (eventMatchesBinding(binding, e)) return actionId;
        }
        return null;
    }

    // Rebind an action to a new key
    rebind(actionId, newBinding) {
        this.bindings[actionId] = newBinding;
        this._save();
    }

    // Check if an action still has its default binding
    isDefault(actionId) {
        return this.bindings[actionId] === DEFAULT_BINDINGS[actionId];
    }

    // Reset a single action to default
    resetAction(actionId) {
        if (DEFAULT_BINDINGS[actionId]) {
            this.bindings[actionId] = DEFAULT_BINDINGS[actionId];
        } else {
            delete this.bindings[actionId];
        }
        this._save();
    }

    // Reset all to defaults
    resetAll() {
        this.bindings = { ...DEFAULT_BINDINGS };
        this._save();
    }

    // Get all actions with their labels and current bindings
    getAllActions() {
        return Object.keys(ACTION_LABELS).map(id => ({
            id,
            label: ACTION_LABELS[id],
            binding: this.getBinding(id),
            displayKey: this.getDisplayKey(id),
            isDefault: this.bindings[id] === DEFAULT_BINDINGS[id],
        }));
    }

    _save() {
        // Only save overrides (differences from defaults)
        const overrides = {};
        for (const [id, binding] of Object.entries(this.bindings)) {
            if (binding !== DEFAULT_BINDINGS[id]) {
                overrides[id] = binding;
            }
        }
        if (Object.keys(overrides).length > 0) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
        } else {
            localStorage.removeItem(STORAGE_KEY);
        }
    }

    _load() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (saved) {
                const overrides = JSON.parse(saved);
                Object.assign(this.bindings, overrides);
            }
        } catch (e) { /* ignore corrupt data */ }
    }
}

// Convert a keyboard event to a binding string like "Ctrl+KeyA" or "Shift+KeyN"
export function eventToBinding(e) {
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.shiftKey) parts.push('Shift');
    if (e.altKey) parts.push('Alt');
    // Don't include modifier keys themselves as the main key
    if (!['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight'].includes(e.code)) {
        parts.push(e.code);
    }
    return parts.join('+');
}

function eventMatchesBinding(binding, e) {
    const parts = binding.split('+');
    const keyCode = parts[parts.length - 1];
    const needCtrl = parts.includes('Ctrl');
    const needShift = parts.includes('Shift');
    const needAlt = parts.includes('Alt');

    // Ctrl and Alt must match exactly
    if (needCtrl !== e.ctrlKey) return false;
    if (needAlt !== e.altKey) return false;
    // Shift: only enforce if the binding explicitly requires it.
    // This allows Shift+Equal to still match "Equal" (for +/= key),
    // letting handler code inspect e.shiftKey for variant behavior.
    if (needShift && !e.shiftKey) return false;
    if (!needShift && e.shiftKey && e.ctrlKey) return false; // Ctrl+Shift combos shouldn't match Ctrl-only bindings

    return e.code === keyCode;
}

function formatKeyForDisplay(binding) {
    // Split on combo separator, format each part, rejoin with " + "
    const parts = binding.split('+');
    const formatted = parts.map(p =>
        p.replace('Key', '')
         .replace('Digit', '')
         .replace('Equal', '+/=')
         .replace('Minus', '-')
         .replace('Escape', 'Esc')
    );
    return formatted.join(' + ');
}

// Singleton
export const hotkeyManager = new HotkeyManager();
