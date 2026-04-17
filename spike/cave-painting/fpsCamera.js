// First-person fly camera — pointer lock + WASD + mouse-look.
// Self-contained port of the main editor's camera/input pattern.

import * as THREE from 'three';

const MOVE_SPEED = 8;
const LOOK_SPEED = 0.002;

const keys = new Set();
let isLocked = false;
let mouseDX = 0;
let mouseDY = 0;
let mouseButtons = 0;
let shiftHeld = false;
let canvasRef = null;

const scrollListeners = [];

export function initInput(canvas) {
    canvasRef = canvas;

    document.addEventListener('keydown', (e) => {
        keys.add(e.code);
        if (e.shiftKey) shiftHeld = true;
    });
    document.addEventListener('keyup', (e) => {
        keys.delete(e.code);
        shiftHeld = e.shiftKey;
    });

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

    document.addEventListener('mousedown', (e) => {
        if (!isLocked) return;
        mouseButtons |= (1 << e.button);
    });
    document.addEventListener('mouseup', (e) => {
        mouseButtons &= ~(1 << e.button);
    });

    document.addEventListener('wheel', (e) => {
        if (!isLocked) return;
        e.preventDefault();
        for (const cb of scrollListeners) cb(e.deltaY);
    }, { passive: false });
}

export function onScroll(cb) { scrollListeners.push(cb); }
export function isKeyDown(code) { return keys.has(code); }
export function isPointerLocked() { return isLocked; }
export function isShiftHeld() { return shiftHeld; }
export function isLeftMouseDown() { return (mouseButtons & 1) !== 0; }

const euler = new THREE.Euler(0, 0, 0, 'YXZ');

export function updateCamera(camera, dt) {
    if (!isLocked) return;

    // Mouse look
    euler.setFromQuaternion(camera.quaternion);
    euler.y -= mouseDX * LOOK_SPEED;
    euler.x -= mouseDY * LOOK_SPEED;
    euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, euler.x));
    camera.quaternion.setFromEuler(euler);
    mouseDX = 0;
    mouseDY = 0;

    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
    const speed = MOVE_SPEED * dt;

    if (keys.has('KeyW')) camera.position.addScaledVector(forward, speed);
    if (keys.has('KeyS')) camera.position.addScaledVector(forward, -speed);
    if (keys.has('KeyA')) camera.position.addScaledVector(right, -speed);
    if (keys.has('KeyD')) camera.position.addScaledVector(right, speed);
    if (keys.has('Space')) camera.position.y += speed;
    if (keys.has('KeyC')) camera.position.y -= speed;
}
