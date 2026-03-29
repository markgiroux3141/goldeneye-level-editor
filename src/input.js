// Keyboard and mouse input state tracking

const keys = new Set();
let isLocked = false;
let mouseDX = 0;
let mouseDY = 0;

export function initInput(canvas) {
    document.addEventListener('keydown', (e) => keys.add(e.code));
    document.addEventListener('keyup', (e) => keys.delete(e.code));

    canvas.addEventListener('click', () => {
        if (!isLocked) canvas.requestPointerLock();
    });

    document.addEventListener('pointerlockchange', () => {
        isLocked = document.pointerLockElement === canvas;
        document.getElementById('lock-prompt').style.display = isLocked ? 'none' : 'block';
        document.getElementById('crosshair').style.display = isLocked ? 'block' : 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isLocked) return;
        mouseDX += e.movementX;
        mouseDY += e.movementY;
    });
}

export function isKeyDown(code) { return keys.has(code); }
export function isPointerLocked() { return isLocked; }

export function consumeMouseDelta() {
    const dx = mouseDX;
    const dy = mouseDY;
    mouseDX = 0;
    mouseDY = 0;
    return { dx, dy };
}

// Event registration for specific key actions (keydown only, not held)
const keyDownCallbacks = [];

export function onKeyDown(callback) {
    keyDownCallbacks.push(callback);
}

// Must be called once during init
export function initKeyActions() {
    document.addEventListener('keydown', (e) => {
        for (const cb of keyDownCallbacks) cb(e);
    });
}
