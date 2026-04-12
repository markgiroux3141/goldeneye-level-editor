// Self-contained FPS fly camera with pointer lock
// Adapted from src/scene/camera.js + src/input/input.js patterns

import * as THREE from 'three';

const DEFAULT_SPEED = 500;
const MIN_SPEED = 50;
const MAX_SPEED = 5000;
const SCROLL_FACTOR = 1.2;   // multiply/divide per wheel notch
const SPRINT_MULTIPLIER = 2;
const LOOK_SPEED = 0.002;
const FOV = 75;
const NEAR = 1;
const FAR = 50000;

export function initCamera(canvas) {
    const camera = new THREE.PerspectiveCamera(
        FOV, window.innerWidth / window.innerHeight, NEAR, FAR
    );

    // Input state
    const keys = new Set();
    let mouseDX = 0, mouseDY = 0;
    let locked = false;
    let moveSpeed = DEFAULT_SPEED;
    const euler = new THREE.Euler(0, 0, 0, 'YXZ');

    // Keyboard
    document.addEventListener('keydown', (e) => keys.add(e.code));
    document.addEventListener('keyup', (e) => keys.delete(e.code));

    // Pointer lock
    canvas.addEventListener('click', () => {
        if (!locked) canvas.requestPointerLock();
    });

    document.addEventListener('pointerlockchange', () => {
        locked = document.pointerLockElement === canvas;
        document.getElementById('lock-prompt').style.display = locked ? 'none' : 'block';
        document.getElementById('crosshair').style.display = locked ? 'block' : 'none';
    });

    // Mouse movement
    document.addEventListener('mousemove', (e) => {
        if (!locked) return;
        mouseDX += e.movementX;
        mouseDY += e.movementY;
    });

    // Scroll wheel to adjust speed
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (e.deltaY < 0) {
            moveSpeed = Math.min(MAX_SPEED, moveSpeed * SCROLL_FACTOR);
        } else {
            moveSpeed = Math.max(MIN_SPEED, moveSpeed / SCROLL_FACTOR);
        }
        // Notify speed display
        const el = document.getElementById('speed-display');
        if (el) el.textContent = `Speed: ${Math.round(moveSpeed)}`;
    }, { passive: false });

    // Resize
    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
    });

    function update(dt) {
        if (!locked) return;

        // Mouse look
        euler.setFromQuaternion(camera.quaternion);
        euler.y -= mouseDX * LOOK_SPEED;
        euler.x -= mouseDY * LOOK_SPEED;
        euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, euler.x));
        camera.quaternion.setFromEuler(euler);
        mouseDX = 0;
        mouseDY = 0;

        // Movement
        const forward = new THREE.Vector3();
        camera.getWorldDirection(forward);
        const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();

        const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
        const speed = moveSpeed * (sprint ? SPRINT_MULTIPLIER : 1) * dt;

        if (keys.has('KeyW')) camera.position.addScaledVector(forward, speed);
        if (keys.has('KeyS')) camera.position.addScaledVector(forward, -speed);
        if (keys.has('KeyA')) camera.position.addScaledVector(right, -speed);
        if (keys.has('KeyD')) camera.position.addScaledVector(right, speed);
        if (keys.has('Space')) camera.position.y += speed;
    }

    function isKeyDown(code) { return keys.has(code); }

    return { camera, update, isKeyDown };
}
