// Input controller for hub-walkway spike.
// States:
//   IDLE
//     click empty  → start placing a hub (first corner)
//     click hub edge (within EDGE_SNAP) → start placing a walkway from there
//     click hub interior → select that hub
//   PLACING_HUB: first corner set, preview rectangle follows cursor
//     click → commit rectangle, back to IDLE
//     ESC  → cancel
//   PLACING_WALKWAY: first anchor set, preview walkway follows cursor
//     click on another hub edge → commit walkway
//     wheel → adjust width
//     ESC → cancel
//   SELECTED: a hub is selected
//     ↑/↓ → raise/lower hub.y
//     Del → delete hub (cascades walkways)
//     click elsewhere → IDLE

import { pickHubEdge, pickHubContaining } from './model.js';

const EDGE_SNAP_WT = 1.0;
const DEFAULT_WIDTH = 2;
const MIN_WIDTH = 0.5;
const MAX_WIDTH = 8;
const HEIGHT_STEP = 0.5;

export class InputController {
    constructor(canvas, camera, world, callbacks) {
        this.canvas = canvas;
        this.camera = camera;
        this.world = world;
        this.cb = callbacks; // { onMutate, onPreview, onHover, onState }
        this.state = 'IDLE';
        this.hubFirstCorner = null;
        this.walkwayAnchorA = null;
        this.previewWidth = DEFAULT_WIDTH;
        this.selectedHubId = null;
        this._panning = false;
        this._panLast = { x: 0, y: 0 };
        this._bind();
    }
    _bind() {
        this.canvas.addEventListener('mousedown', (e) => this._onDown(e));
        this.canvas.addEventListener('mouseup', (e) => this._onUp(e));
        this.canvas.addEventListener('mousemove', (e) => this._onMove(e));
        this.canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
        window.addEventListener('keydown', (e) => this._onKey(e));
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    _onDown(e) {
        if (e.button === 1) { this._panning = true; this._panLast = { x: e.clientX, y: e.clientY }; return; }
        if (e.button !== 0) return;
        const pt = this.camera.screenToWorldWT(e);
        if (this.state === 'IDLE') {
            const edge = pickHubEdge(this.world, pt, EDGE_SNAP_WT);
            if (edge) {
                this.walkwayAnchorA = { hubId: edge.hub.id, edge: edge.edge, t: edge.t };
                this.state = 'PLACING_WALKWAY';
                this._emit();
                return;
            }
            const hub = pickHubContaining(this.world, pt);
            if (hub) {
                this.selectedHubId = hub.id;
                this.state = 'SELECTED';
                this._emit();
                return;
            }
            // Empty click → start hub placement.
            this.hubFirstCorner = { x: pt.x, z: pt.z };
            this.state = 'PLACING_HUB';
            this._emit();
            return;
        }
        if (this.state === 'PLACING_HUB') {
            // Commit rectangle from hubFirstCorner to pt.
            const x0 = Math.min(this.hubFirstCorner.x, pt.x);
            const z0 = Math.min(this.hubFirstCorner.z, pt.z);
            const sizeX = Math.abs(pt.x - this.hubFirstCorner.x);
            const sizeZ = Math.abs(pt.z - this.hubFirstCorner.z);
            if (sizeX < 0.5 || sizeZ < 0.5) { this._cancel(); return; }
            const hub = this.world.addHub(x0, z0, sizeX, sizeZ, 0, 1);
            this.cb.onMutate({ dirtyHubs: new Set([hub.id]), dirtyWalkways: new Set() });
            this.state = 'IDLE';
            this.hubFirstCorner = null;
            this._emit();
            return;
        }
        if (this.state === 'PLACING_WALKWAY') {
            const edge = pickHubEdge(this.world, pt, EDGE_SNAP_WT);
            if (!edge || edge.hub.id === this.walkwayAnchorA.hubId) { this._cancel(); return; }
            const w = this.world.addWalkway(
                this.walkwayAnchorA,
                { hubId: edge.hub.id, edge: edge.edge, t: edge.t },
                this.previewWidth,
            );
            this.cb.onMutate({
                dirtyHubs: new Set([this.walkwayAnchorA.hubId, edge.hub.id]),
                dirtyWalkways: new Set([w.id]),
            });
            this.state = 'IDLE';
            this.walkwayAnchorA = null;
            this._emit();
            return;
        }
        if (this.state === 'SELECTED') {
            const hub = pickHubContaining(this.world, pt);
            if (hub) { this.selectedHubId = hub.id; this._emit(); }
            else { this.selectedHubId = null; this.state = 'IDLE'; this._emit(); }
            return;
        }
    }
    _onUp(e) { if (e.button === 1) this._panning = false; }
    _onMove(e) {
        if (this._panning) {
            const dx = e.clientX - this._panLast.x, dy = e.clientY - this._panLast.y;
            this._panLast = { x: e.clientX, y: e.clientY };
            this.camera.pan(dx, dy);
            return;
        }
        const pt = this.camera.screenToWorldWT(e);
        if (this.state === 'PLACING_HUB') {
            this.cb.onPreview({ kind: 'HUB', a: this.hubFirstCorner, b: pt });
        } else if (this.state === 'PLACING_WALKWAY') {
            const edge = pickHubEdge(this.world, pt, EDGE_SNAP_WT);
            const endPt = edge ? edge.foot : pt;
            this.cb.onPreview({
                kind: 'WALKWAY',
                anchorA: this.walkwayAnchorA,
                end: endPt,
                edgeHit: edge,
                width: this.previewWidth,
            });
            this.cb.onHover(edge ? { kind: 'EDGE', foot: edge.foot } : null);
        } else {
            const edge = pickHubEdge(this.world, pt, EDGE_SNAP_WT);
            this.cb.onHover(edge ? { kind: 'EDGE', foot: edge.foot } : null);
        }
    }
    _onWheel(e) {
        e.preventDefault();
        if (this.state === 'PLACING_WALKWAY') {
            const dir = e.deltaY < 0 ? 1 : -1;
            this.previewWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, this.previewWidth + dir * 0.25));
            this._emit();
        } else {
            const factor = e.deltaY < 0 ? 0.9 : 1.1;
            this.camera.zoomBy(factor);
        }
    }
    _onKey(e) {
        if (e.key === 'Escape') { this._cancel(); return; }
        if (this.state === 'SELECTED' && this.selectedHubId != null) {
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                const dir = e.key === 'ArrowUp' ? 1 : -1;
                const hub = this.world.hubs.get(this.selectedHubId);
                hub.y += dir * HEIGHT_STEP;
                const dirtyHubs = new Set([this.selectedHubId]);
                const dirtyWalkways = new Set();
                for (const w of this.world.walkwaysOfHub(this.selectedHubId)) {
                    dirtyWalkways.add(w.id);
                    dirtyHubs.add(w.anchorA.hubId).add(w.anchorB.hubId);
                }
                this.cb.onMutate({ dirtyHubs, dirtyWalkways });
                this._emit();
            } else if (e.key === 'Delete' || e.key === 'Backspace') {
                const hubId = this.selectedHubId;
                const ws = this.world.walkwaysOfHub(hubId);
                const dirtyHubs = new Set([hubId]);
                const dirtyWalkways = new Set();
                for (const w of ws) {
                    dirtyWalkways.add(w.id);
                    dirtyHubs.add(w.anchorA.hubId).add(w.anchorB.hubId);
                }
                this.world.removeHub(hubId);
                this.cb.onMutate({ dirtyHubs, dirtyWalkways });
                this.selectedHubId = null;
                this.state = 'IDLE';
                this._emit();
            }
        }
    }
    _cancel() {
        this.state = 'IDLE';
        this.hubFirstCorner = null;
        this.walkwayAnchorA = null;
        this.cb.onPreview(null);
        this._emit();
    }
    _emit() {
        this.cb.onState({
            state: this.state,
            selectedHubId: this.selectedHubId,
            previewWidth: this.previewWidth,
        });
    }
}
