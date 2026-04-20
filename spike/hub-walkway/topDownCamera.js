// Top-down orthographic camera (copy of branching-platforms version).
import * as THREE from 'three';

const WORLD_SCALE = 0.25;

export class TopDownCamera {
    constructor(canvas) {
        this.canvas = canvas;
        this.panX = 0; this.panZ = 0;
        this.zoom = 20;
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -100, 1000);
        this.camera.up.set(0, 0, -1);
        this.camera.position.set(0, 50, 0);
        this.camera.lookAt(0, 0, 0);
        this.updateProjection();
    }
    updateProjection() {
        const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
        const aspect = w / Math.max(1, h);
        const halfH = this.zoom / 2;
        const halfW = halfH * aspect;
        this.camera.left = -halfW; this.camera.right = halfW;
        this.camera.top = halfH; this.camera.bottom = -halfH;
        this.camera.position.set(this.panX, 50, this.panZ);
        this.camera.lookAt(this.panX, 0, this.panZ);
        this.camera.updateProjectionMatrix();
    }
    onResize() { this.updateProjection(); }
    screenToWorldWT(event) {
        const rect = this.canvas.getBoundingClientRect();
        const sx = event.clientX - rect.left, sy = event.clientY - rect.top;
        const ndcX = (sx / rect.width) * 2 - 1;
        const ndcY = -((sy / rect.height) * 2 - 1);
        const halfH = (this.camera.top - this.camera.bottom) / 2;
        const halfW = (this.camera.right - this.camera.left) / 2;
        return {
            x: (this.panX + ndcX * halfW) / WORLD_SCALE,
            z: (this.panZ - ndcY * halfH) / WORLD_SCALE,
        };
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
