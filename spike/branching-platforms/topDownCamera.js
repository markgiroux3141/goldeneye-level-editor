// Top-down orthographic camera with pan (middle-drag) and zoom (wheel in IDLE).
// World is in Three.js meters after WORLD_SCALE (1 WT = 0.25m). Camera looks
// straight down at y=0. Screen-up → world -Z; screen-right → world +X.

import * as THREE from 'three';

const WORLD_SCALE = 0.25;

export class TopDownCamera {
    constructor(canvas) {
        this.canvas = canvas;
        this.panX = 0;     // in Three.js meters
        this.panZ = 0;
        this.zoom = 10;    // meters visible per 100 screen px (roughly)
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -100, 1000);
        this.camera.up.set(0, 0, -1);     // world -Z = screen up
        this.camera.position.set(0, 50, 0);
        this.camera.lookAt(0, 0, 0);
        this.updateProjection();
    }

    updateProjection() {
        const w = this.canvas.clientWidth;
        const h = this.canvas.clientHeight;
        const aspect = w / Math.max(1, h);
        const halfH = this.zoom / 2;
        const halfW = halfH * aspect;
        this.camera.left = -halfW;
        this.camera.right = halfW;
        this.camera.top = halfH;
        this.camera.bottom = -halfH;
        this.camera.position.set(this.panX, 50, this.panZ);
        this.camera.lookAt(this.panX, 0, this.panZ);
        this.camera.updateProjectionMatrix();
    }

    onResize() {
        this.updateProjection();
    }

    // Given a mouse event (clientX, clientY), return the world-space point
    // on the y=0 plane in WT units: { x, z }. (No reliance on raycaster —
    // for a top-down ortho camera we can unproject directly.)
    screenToWorldWT(event) {
        const rect = this.canvas.getBoundingClientRect();
        const sx = event.clientX - rect.left;
        const sy = event.clientY - rect.top;
        // NDC: x ∈ [-1, 1] → +X, y ∈ [-1, 1] → +screen-up = world -Z
        const ndcX = (sx / rect.width) * 2 - 1;
        const ndcY = -((sy / rect.height) * 2 - 1);
        // camera visible area in meters: ±halfW, ±halfH around (panX, panZ)
        const halfH = (this.camera.top - this.camera.bottom) / 2;
        const halfW = (this.camera.right - this.camera.left) / 2;
        const worldXm = this.panX + ndcX * halfW;
        const worldZm = this.panZ - ndcY * halfH;   // up vector is -Z: screen-up = world -Z
        return { x: worldXm / WORLD_SCALE, z: worldZm / WORLD_SCALE };
    }

    pan(dxPx, dyPx) {
        const rect = this.canvas.getBoundingClientRect();
        const halfH = (this.camera.top - this.camera.bottom) / 2;
        const halfW = (this.camera.right - this.camera.left) / 2;
        this.panX -= (dxPx / rect.width) * 2 * halfW;
        this.panZ += (dyPx / rect.height) * 2 * halfH;
        this.updateProjection();
    }

    zoomBy(factor) {
        this.zoom = Math.max(0.5, Math.min(500, this.zoom * factor));
        this.updateProjection();
    }
}
