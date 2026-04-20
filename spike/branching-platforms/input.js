// Interaction state machine — IDLE / PLACING / SELECTED.
// Emits mutation events to the main scene and hover-highlight events so the
// scene can draw a green marker on the current snap target.
//
// Snap targets (priority order, used everywhere we need to place a point):
//   NODE       — existing node within NODE_SNAP_WT
//   ENDPOINT   — either end of a segment (same as NODE, subset)
//   MIDPOINT   — segment centerline midpoint within SNAP_WT
//   EDGE       — segment long side, projected to centerline (auto-T-junction)
//   PERPFOOT   — perpendicular drop onto segment centerline from a reference
//                point (only active while placing, using startNode as ref)
//
// In PLACING, direction snaps to 15° increments unless Alt is held.

// Node snap must stay strictly under any segment's half-width, otherwise the
// node's snap disk swallows its own adjacent edges and you can't click them
// to branch. 0.6 WT comfortably fits inside a 1 WT half-width (width-2 default).
const NODE_SNAP_WT = 0.6;
const MIDPOINT_SNAP_WT = 0.8;
const EDGE_SNAP_WT = 0.8;
const PERPFOOT_SNAP_WT = 0.6;
const DEFAULT_WIDTH_WT = 2;
const MIN_WIDTH_WT = 0.5;
const MAX_WIDTH_WT = 10;
const WIDTH_STEP_WT = 0.25;
const HEIGHT_STEP_WT = 0.5;
const ANGLE_SNAP_DEG = 15;
const UNDO_STACK_MAX = 50;

export class InputController {
    constructor(canvas, camera, graph, onMutate, onPreviewChange, onStateChange, onHoverChange) {
        this.canvas = canvas;
        this.camera = camera;
        this.graph = graph;
        this.onMutate = onMutate;
        this.onPreviewChange = onPreviewChange;
        this.onStateChange = onStateChange;
        this.onHoverChange = onHoverChange || (() => {});
        this.state = 'IDLE';
        this.startNodeId = null;
        this.previewWidth = DEFAULT_WIDTH_WT;
        this.previewEnd = null;
        this.previewSnap = null;       // snap resolved for preview endpoint
        this.selectedNodeId = null;
        this.hoveredSnap = null;       // current snap under cursor (for IDLE highlight)
        this.angleSnapEnabled = true;   // can toggle with Shift
        this._altHeld = false;
        this._panning = false;
        this._panLast = { x: 0, y: 0 };
        this._undoStack = [];  // cap at UNDO_STACK_MAX
        this._enabled = true;
        this._bind();
    }

    // Disable edit input (e.g. while in 3D fly mode). Does NOT disable the
    // global keydown for Ctrl+Z — undo stays available regardless.
    setEnabled(enabled) {
        this._enabled = enabled;
        if (!enabled) {
            // Bail out of any in-progress placement and clear selection.
            if (this.state === 'PLACING') this._undo();
            else if (this.state === 'SELECTED') {
                this.selectedNodeId = null;
                this.state = 'IDLE';
                this._emitAll();
            }
            this._emitHover(null);
        }
    }

    // Push a snapshot of the current graph state onto the undo stack. Call
    // BEFORE performing any mutation so Ctrl+Z returns to the pre-mutation
    // state.
    _pushUndo() {
        this._undoStack.push(this.graph.snapshot());
        if (this._undoStack.length > UNDO_STACK_MAX) this._undoStack.shift();
    }

    _undo() {
        if (this._undoStack.length === 0) return;
        const snap = this._undoStack.pop();
        this.graph.restore(snap);
        // Drop any editing state that might reference stale ids.
        this.state = 'IDLE';
        this.startNodeId = null;
        this.previewEnd = null;
        this.previewSnap = null;
        this.selectedNodeId = null;
        // Signal a rebuild. Main.js ignores the dirty set and rebuilds all.
        this.onMutate({ dirtyNodes: new Set(), dirtySegments: new Set() });
        this._emitAll();
    }

    _bind() {
        this.canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
        this.canvas.addEventListener('mouseup', (e) => this._onMouseUp(e));
        this.canvas.addEventListener('mousemove', (e) => this._onMouseMove(e));
        this.canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
        window.addEventListener('keydown', (e) => this._onKeyDown(e));
        window.addEventListener('keyup', (e) => this._onKeyUp(e));
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    // Effective node snap radius at a given node — shrinks so it never crowds
    // its own adjacent segment edges. Must stay strictly below every incident
    // segment's half-width so the edges are clickable right next to the node.
    _nodeSnapRadius(node) {
        const segs = this.graph.neighbors(node.id);
        if (segs.length === 0) return NODE_SNAP_WT;
        let minHalfW = Infinity;
        for (const s of segs) minHalfW = Math.min(minHalfW, s.width / 2);
        return Math.min(NODE_SNAP_WT, Math.max(0.2, minHalfW - 0.15));
    }

    // ─── SNAP RESOLUTION ────────────────────────────────────────
    // Resolve the best snap target at world-space point pt.
    // referencePt (optional): used for PERPFOOT snap (usually startNode during PLACING).
    _resolveSnap(pt, referencePt = null) {
        // 1) NODE (highest priority) — each node has its own effective radius.
        let best = null;
        let bestD2 = Infinity;
        for (const node of this.graph.nodes.values()) {
            const r = this._nodeSnapRadius(node);
            const d2 = (node.x - pt.x) ** 2 + (node.z - pt.z) ** 2;
            if (d2 < r * r && d2 < bestD2) {
                bestD2 = d2;
                best = { type: 'NODE', node, x: node.x, z: node.z };
            }
        }
        if (best) return best;

        // 2) MIDPOINT of a segment
        bestD2 = MIDPOINT_SNAP_WT * MIDPOINT_SNAP_WT;
        for (const seg of this.graph.segments.values()) {
            const a = this.graph.nodes.get(seg.a);
            const b = this.graph.nodes.get(seg.b);
            const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
            const d2 = (mx - pt.x) ** 2 + (mz - pt.z) ** 2;
            if (d2 < bestD2) { bestD2 = d2; best = { type: 'MIDPOINT', seg, x: mx, z: mz }; }
        }
        if (best) return best;

        // 3) EDGE (project onto segment centerline if click is near the long side)
        bestD2 = EDGE_SNAP_WT * EDGE_SNAP_WT;
        for (const seg of this.graph.segments.values()) {
            const a = this.graph.nodes.get(seg.a);
            const b = this.graph.nodes.get(seg.b);
            const dx = b.x - a.x, dz = b.z - a.z;
            const len2 = dx * dx + dz * dz;
            if (len2 < 1e-6) continue;
            const len = Math.sqrt(len2);
            const ax = dx / len, az = dz / len;
            const nx = -az, nz = ax;
            const px = pt.x - a.x, pz = pt.z - a.z;
            const along = px * ax + pz * az;
            const perp = px * nx + pz * nz;
            const halfW = seg.width / 2;
            const edgeDist = Math.abs(Math.abs(perp) - halfW);
            // Stay out of each endpoint's own snap radius so node clicks still
            // win right at the vertex.
            const deadA = this._nodeSnapRadius(a);
            const deadB = this._nodeSnapRadius(b);
            if (along > deadA && along < len - deadB && edgeDist * edgeDist < bestD2) {
                const projX = a.x + along * ax;
                const projZ = a.z + along * az;
                const d2 = (projX - pt.x) ** 2 + (projZ - pt.z) ** 2;
                if (d2 < bestD2) {
                    bestD2 = d2;
                    best = { type: 'EDGE', seg, along, x: projX, z: projZ };
                }
            }
        }
        if (best) return best;

        // 4) PERPFOOT — perpendicular from referencePt onto a segment's centerline,
        // if pt is near that foot.
        if (referencePt) {
            bestD2 = PERPFOOT_SNAP_WT * PERPFOOT_SNAP_WT;
            for (const seg of this.graph.segments.values()) {
                const a = this.graph.nodes.get(seg.a);
                const b = this.graph.nodes.get(seg.b);
                const dx = b.x - a.x, dz = b.z - a.z;
                const len2 = dx * dx + dz * dz;
                if (len2 < 1e-6) continue;
                const len = Math.sqrt(len2);
                const ax = dx / len, az = dz / len;
                const px = referencePt.x - a.x, pz = referencePt.z - a.z;
                const footAlong = px * ax + pz * az;
                if (footAlong < 0 || footAlong > len) continue;
                const footX = a.x + footAlong * ax;
                const footZ = a.z + footAlong * az;
                const d2 = (footX - pt.x) ** 2 + (footZ - pt.z) ** 2;
                if (d2 < bestD2) {
                    bestD2 = d2;
                    best = { type: 'PERPFOOT', seg, along: footAlong, x: footX, z: footZ };
                }
            }
            if (best) return best;
        }

        return null;
    }

    // Apply angle snap to a direction from origin → pt, returning an adjusted endpoint.
    // Snaps the direction (not the distance) so the user can still set the length by moving farther out.
    _applyAngleSnap(origin, pt) {
        if (!this.angleSnapEnabled || this._altHeld) return pt;
        const dx = pt.x - origin.x, dz = pt.z - origin.z;
        const len = Math.hypot(dx, dz);
        if (len < 1e-4) return pt;
        const theta = Math.atan2(dz, dx);
        const stepRad = (ANGLE_SNAP_DEG * Math.PI) / 180;
        const snappedTheta = Math.round(theta / stepRad) * stepRad;
        return {
            x: origin.x + Math.cos(snappedTheta) * len,
            z: origin.z + Math.sin(snappedTheta) * len,
        };
    }

    // ─── EVENT HANDLERS ─────────────────────────────────────────

    _onMouseDown(e) {
        if (!this._enabled) return;
        if (e.button === 1) {
            this._panning = true;
            this._panLast = { x: e.clientX, y: e.clientY };
            return;
        }
        if (e.button !== 0) return;
        const pt = this.camera.screenToWorldWT(e);

        if (this.state === 'IDLE') {
            const snap = this._resolveSnap(pt);
            if (snap && snap.type === 'NODE') {
                this.selectedNodeId = snap.node.id;
                this.state = 'SELECTED';
                this._emitAll();
                return;
            }
            if (snap && (snap.type === 'EDGE' || snap.type === 'MIDPOINT' || snap.type === 'PERPFOOT')) {
                // Split the segment at the snap point and start placing from the new node.
                // Snapshot the full pre-action state so Ctrl+Z returns here.
                this._pushUndo();
                const oldSegId = snap.seg.id;
                const newNode = this.graph.splitSegmentAt(oldSegId, snap.x, snap.z);
                const dirty = {
                    dirtyNodes: new Set([newNode.id, snap.seg.a, snap.seg.b]),
                    dirtySegments: new Set([oldSegId]),
                };
                for (const s of this.graph.neighbors(newNode.id)) dirty.dirtySegments.add(s.id);
                for (const nId of [snap.seg.a, snap.seg.b]) {
                    for (const s of this.graph.neighbors(nId)) dirty.dirtySegments.add(s.id);
                }
                this.onMutate(dirty);
                this.startNodeId = newNode.id;
                this.state = 'PLACING';
                this.previewEnd = { x: pt.x, z: pt.z };
                this.previewSnap = null;
                this._emitAll();
                return;
            }
            // Empty click → new free-floating start node.
            // Snapshot the full pre-action state so Ctrl+Z (or Escape) can return here.
            this._pushUndo();
            const startNode = this.graph.addNode(pt.x, pt.z, 0);
            this.onMutate({ dirtyNodes: new Set([startNode.id]), dirtySegments: new Set() });
            this.startNodeId = startNode.id;
            this.state = 'PLACING';
            this.previewEnd = { x: pt.x, z: pt.z };
            this.previewSnap = null;
            this._emitAll();
            return;
        }

        if (this.state === 'PLACING') {
            const startNode = this.graph.nodes.get(this.startNodeId);
            const resolved = this._resolvePlacementEnd(pt);
            const endPt = resolved.point;
            if (Math.hypot(endPt.x - startNode.x, endPt.z - startNode.z) < 0.05) {
                // Zero-length commit — rewind the placement start snapshot.
                this._undo();
                return;
            }
            let endNode;
            const dirty = { dirtyNodes: new Set([startNode.id]), dirtySegments: new Set() };
            if (resolved.snap && resolved.snap.type === 'NODE') {
                endNode = resolved.snap.node;
            } else if (resolved.snap &&
                       (resolved.snap.type === 'EDGE' || resolved.snap.type === 'MIDPOINT' || resolved.snap.type === 'PERPFOOT')) {
                // End on an existing segment's centerline → auto-T junction.
                const oldSegId = resolved.snap.seg.id;
                endNode = this.graph.splitSegmentAt(oldSegId, resolved.snap.x, resolved.snap.z);
                dirty.dirtyNodes.add(resolved.snap.seg.a).add(resolved.snap.seg.b);
                dirty.dirtySegments.add(oldSegId);
                for (const nId of [resolved.snap.seg.a, resolved.snap.seg.b]) {
                    for (const s of this.graph.neighbors(nId)) dirty.dirtySegments.add(s.id);
                }
            } else {
                endNode = this.graph.addNode(endPt.x, endPt.z, startNode.y);
            }
            const seg = this.graph.addSegment(startNode.id, endNode.id, this.previewWidth);
            dirty.dirtyNodes.add(endNode.id);
            dirty.dirtySegments.add(seg.id);
            for (const nId of [startNode.id, endNode.id]) {
                for (const s of this.graph.neighbors(nId)) dirty.dirtySegments.add(s.id);
            }
            this.onMutate(dirty);
            this.state = 'IDLE';
            this.startNodeId = null;
            this.previewEnd = null;
            this.previewSnap = null;
            this._emitAll();
            return;
        }

        if (this.state === 'SELECTED') {
            const snap = this._resolveSnap(pt);
            if (snap && snap.type === 'NODE') {
                this.selectedNodeId = snap.node.id;
                this._emitAll();
            } else {
                this.selectedNodeId = null;
                this.state = 'IDLE';
                this._emitAll();
            }
            return;
        }
    }

    // Resolve the endpoint while placing: run snap from the raw cursor, then
    // fall back to angle-snap when no snap target matches. Returns
    // { point: {x,z}, snap: snapOrNull }.
    _resolvePlacementEnd(pt) {
        const startNode = this.graph.nodes.get(this.startNodeId);
        const snap = this._resolveSnap(pt, startNode);
        if (snap) return { point: { x: snap.x, z: snap.z }, snap };
        const angled = this._applyAngleSnap(startNode, pt);
        return { point: angled, snap: null };
    }

    _onMouseUp(e) {
        if (!this._enabled) return;
        if (e.button === 1) this._panning = false;
    }

    _onMouseMove(e) {
        if (!this._enabled) return;
        if (this._panning) {
            const dx = e.clientX - this._panLast.x;
            const dy = e.clientY - this._panLast.y;
            this._panLast = { x: e.clientX, y: e.clientY };
            this.camera.pan(dx, dy);
            return;
        }
        const pt = this.camera.screenToWorldWT(e);

        if (this.state === 'PLACING') {
            const resolved = this._resolvePlacementEnd(pt);
            this.previewEnd = resolved.point;
            this.previewSnap = resolved.snap;
            this._emitPreview();
            this._emitHover(resolved.snap);
        } else {
            // IDLE / SELECTED — highlight the hover snap so users can see
            // where a click would land.
            const snap = this._resolveSnap(pt);
            this._emitHover(snap);
        }
    }

    _onWheel(e) {
        if (!this._enabled) return;
        e.preventDefault();
        if (this.state === 'PLACING') {
            const dir = e.deltaY < 0 ? 1 : -1;
            this.previewWidth = Math.max(MIN_WIDTH_WT, Math.min(MAX_WIDTH_WT,
                this.previewWidth + dir * WIDTH_STEP_WT));
            this._emitPreview();
            this._emitState();
        } else {
            const factor = e.deltaY < 0 ? 0.9 : 1.1;
            this.camera.zoomBy(factor);
        }
    }

    _onKeyDown(e) {
        // Ctrl+Z is available even when editing is disabled (e.g. in 3D fly mode).
        if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
            e.preventDefault();
            this._undo();
            return;
        }
        if (!this._enabled) return;
        if (e.key === 'Alt') { this._altHeld = true; return; }
        if (e.key === 'Escape') {
            if (this.state === 'PLACING') {
                // Escape rewinds the in-progress action — equivalent to Ctrl+Z
                // here, which pops the snapshot we pushed on placement start.
                this._undo();
            } else if (this.state === 'SELECTED') {
                this.selectedNodeId = null;
                this.state = 'IDLE';
                this._emitAll();
            }
            return;
        }
        if (this.state === 'SELECTED' && this.selectedNodeId != null) {
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                this._pushUndo();
                const dir = e.key === 'ArrowUp' ? 1 : -1;
                const n = this.graph.nodes.get(this.selectedNodeId);
                this.graph.setNodeY(this.selectedNodeId, n.y + dir * HEIGHT_STEP_WT);
                const dirty = {
                    dirtyNodes: new Set([this.selectedNodeId]),
                    dirtySegments: new Set(),
                };
                for (const s of this.graph.neighbors(this.selectedNodeId)) {
                    dirty.dirtySegments.add(s.id);
                    dirty.dirtyNodes.add(s.a).add(s.b);
                }
                this.onMutate(dirty);
                this._emitState();
            } else if (e.key === 'Delete' || e.key === 'Backspace') {
                const n = this.graph.nodes.get(this.selectedNodeId);
                if (!n) return;
                this._pushUndo();
                const affectedNodes = new Set([this.selectedNodeId]);
                const affectedSegs = new Set();
                for (const s of this.graph.neighbors(this.selectedNodeId)) {
                    affectedSegs.add(s.id);
                    affectedNodes.add(s.a).add(s.b);
                }
                this.graph.removeNode(this.selectedNodeId);
                this.onMutate({ dirtyNodes: affectedNodes, dirtySegments: affectedSegs });
                this.selectedNodeId = null;
                this.state = 'IDLE';
                this._emitAll();
            }
        }
    }

    _onKeyUp(e) {
        if (e.key === 'Alt') this._altHeld = false;
    }

    _emitAll() { this._emitState(); this._emitPreview(); this._emitHover(null); }

    _emitPreview() {
        if (this.state !== 'PLACING' || !this.previewEnd) { this.onPreviewChange(null); return; }
        const start = this.graph.nodes.get(this.startNodeId);
        this.onPreviewChange({
            start: { x: start.x, z: start.z, y: start.y },
            end: this.previewEnd,
            width: this.previewWidth,
            snap: this.previewSnap,
        });
    }

    _emitState() {
        this.onStateChange({
            state: this.state,
            selectedNodeId: this.selectedNodeId,
            previewWidth: this.previewWidth,
            angleSnap: this.angleSnapEnabled && !this._altHeld,
        });
    }

    _emitHover(snap) {
        this.hoveredSnap = snap;
        this.onHoverChange(snap);
    }
}
