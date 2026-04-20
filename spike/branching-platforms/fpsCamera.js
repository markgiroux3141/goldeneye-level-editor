// First-person fly camera controller. Holds its own THREE.PerspectiveCamera,
// requests pointer lock when enabled, listens to WASD + mouse-move + Space/C,
// and advances each frame via update(dt). All listeners are global — gate
// their effects on `enabled` so they're inert in top-down mode.
//
// The host canvas is shared with the top-down camera; this class NEVER calls
// requestPointerLock unless setEnabled(true) is invoked, so the editor's
// mouse-clicks in top-down mode don't accidentally lock.

import * as THREE from 'three';

const MOVE_SPEED = 8;          // m/s
const LOOK_SPEED = 0.002;      // radians per px
const FAST_MULT = 3;           // hold Shift

export class FpsCamera {
    constructor(canvas, { lockPromptEl = null, crosshairEl = null } = {}) {
        this.canvas = canvas;
        this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, 500);
        this.camera.position.set(0, 2, 5);
        this.camera.lookAt(0, 0, 0);

        this.enabled = false;
        this.isLocked = false;
        this._keys = new Set();
        this._mouseDX = 0;
        this._mouseDY = 0;
        this._lockPromptEl = lockPromptEl;
        this._crosshairEl = crosshairEl;
        this._euler = new THREE.Euler(0, 0, 0, 'YXZ');

        this._onKeyDown = (e) => { if (this.enabled) this._keys.add(e.code); };
        this._onKeyUp = (e) => { this._keys.delete(e.code); };
        this._onMouseMove = (e) => {
            if (!this.enabled || !this.isLocked) return;
            this._mouseDX += e.movementX;
            this._mouseDY += e.movementY;
        };
        this._onCanvasClick = () => {
            if (!this.enabled || this.isLocked) return;
            this.canvas.requestPointerLock();
        };
        this._onPointerLockChange = () => {
            this.isLocked = document.pointerLockElement === this.canvas;
            this._updatePromptVisibility();
        };
        this._attach();
    }

    _attach() {
        document.addEventListener('keydown', this._onKeyDown);
        document.addEventListener('keyup', this._onKeyUp);
        document.addEventListener('mousemove', this._onMouseMove);
        this.canvas.addEventListener('click', this._onCanvasClick);
        document.addEventListener('pointerlockchange', this._onPointerLockChange);
    }

    onResize() {
        const w = this.canvas.clientWidth;
        const h = this.canvas.clientHeight;
        this.camera.aspect = w / Math.max(1, h);
        this.camera.updateProjectionMatrix();
    }

    // Place the camera to frame a point from a useful distance/angle.
    lookAtTarget(targetXZ) {
        // Start above and behind the target by a fixed offset, pitched down.
        this.camera.position.set(targetXZ.x - 4, 3, targetXZ.z + 4);
        this.camera.lookAt(targetXZ.x, 0, targetXZ.z);
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        if (!enabled && this.isLocked && document.pointerLockElement === this.canvas) {
            document.exitPointerLock();
        }
        this._keys.clear();
        this._mouseDX = 0;
        this._mouseDY = 0;
        this._updatePromptVisibility();
    }

    _updatePromptVisibility() {
        if (this._lockPromptEl) {
            this._lockPromptEl.style.display = (this.enabled && !this.isLocked) ? 'block' : 'none';
        }
        if (this._crosshairEl) {
            this._crosshairEl.style.display = (this.enabled && this.isLocked) ? 'block' : 'none';
        }
    }

    update(dt) {
        if (!this.enabled || !this.isLocked) return;

        // Mouse look
        this._euler.setFromQuaternion(this.camera.quaternion);
        this._euler.y -= this._mouseDX * LOOK_SPEED;
        this._euler.x -= this._mouseDY * LOOK_SPEED;
        this._euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this._euler.x));
        this.camera.quaternion.setFromEuler(this._euler);
        this._mouseDX = 0;
        this._mouseDY = 0;

        const forward = new THREE.Vector3();
        this.camera.getWorldDirection(forward);
        const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize();
        const mult = this._keys.has('ShiftLeft') || this._keys.has('ShiftRight') ? FAST_MULT : 1;
        const speed = MOVE_SPEED * mult * dt;

        if (this._keys.has('KeyW')) this.camera.position.addScaledVector(forward, speed);
        if (this._keys.has('KeyS')) this.camera.position.addScaledVector(forward, -speed);
        if (this._keys.has('KeyA')) this.camera.position.addScaledVector(right, -speed);
        if (this._keys.has('KeyD')) this.camera.position.addScaledVector(right, speed);
        if (this._keys.has('Space')) this.camera.position.y += speed;
        if (this._keys.has('KeyC')) this.camera.position.y -= speed;
    }
}
