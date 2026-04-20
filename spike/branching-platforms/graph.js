// Graph of nodes (junction points) and segments (platforms/stairs between them).
// Coordinates are in WT (1 WT = world unit in the main editor).

export class Graph {
    constructor() {
        this.nodes = new Map();       // id → { id, x, z, y }
        this.segments = new Map();    // id → { id, a, b, width, thickness }
        this.adjacency = new Map();   // nodeId → Set<segId>
        this._nextNodeId = 1;
        this._nextSegId = 1;
    }

    addNode(x, z, y = 0) {
        const id = this._nextNodeId++;
        const node = { id, x, z, y };
        this.nodes.set(id, node);
        this.adjacency.set(id, new Set());
        return node;
    }

    addSegment(aId, bId, width, thickness = 1) {
        if (aId === bId) throw new Error('segment endpoints must differ');
        const id = this._nextSegId++;
        const seg = { id, a: aId, b: bId, width, thickness };
        this.segments.set(id, seg);
        this.adjacency.get(aId).add(id);
        this.adjacency.get(bId).add(id);
        return seg;
    }

    removeSegment(segId) {
        const seg = this.segments.get(segId);
        if (!seg) return;
        this.adjacency.get(seg.a)?.delete(segId);
        this.adjacency.get(seg.b)?.delete(segId);
        this.segments.delete(segId);
    }

    removeNode(nodeId) {
        const segs = this.adjacency.get(nodeId);
        if (segs) for (const segId of [...segs]) this.removeSegment(segId);
        this.adjacency.delete(nodeId);
        this.nodes.delete(nodeId);
    }

    setNodeY(nodeId, y) {
        const n = this.nodes.get(nodeId);
        if (n) n.y = y;
    }

    neighbors(nodeId) {
        return [...(this.adjacency.get(nodeId) || [])].map((sid) => this.segments.get(sid));
    }

    // The "other end" of a segment given one endpoint.
    otherNode(seg, nodeId) {
        return this.nodes.get(seg.a === nodeId ? seg.b : seg.a);
    }

    // Serialize the graph's full state into a plain object suitable for
    // deep-restore via restore(). Used by the undo stack; cheap at spike
    // scale (nodes + segments are plain data).
    snapshot() {
        return {
            nodes: [...this.nodes.entries()].map(([id, n]) => [id, { ...n }]),
            segments: [...this.segments.entries()].map(([id, s]) => [id, { ...s }]),
            nextNodeId: this._nextNodeId,
            nextSegId: this._nextSegId,
        };
    }

    // Replace the graph's state with a snapshot from snapshot(). Rebuilds
    // adjacency from the segment list.
    restore(snap) {
        this.nodes.clear();
        this.segments.clear();
        this.adjacency.clear();
        for (const [id, n] of snap.nodes) {
            this.nodes.set(id, { ...n });
            this.adjacency.set(id, new Set());
        }
        for (const [id, s] of snap.segments) {
            this.segments.set(id, { ...s });
            this.adjacency.get(s.a)?.add(id);
            this.adjacency.get(s.b)?.add(id);
        }
        this._nextNodeId = snap.nextNodeId;
        this._nextSegId = snap.nextSegId;
    }

    // Split a segment at point (x, z), inserting a new node.
    // Returns the new node.
    splitSegmentAt(segId, x, z) {
        const seg = this.segments.get(segId);
        if (!seg) return null;
        const { a, b, width, thickness } = seg;
        const nA = this.nodes.get(a);
        const nB = this.nodes.get(b);
        // Interpolate y linearly along the old segment.
        const dx = nB.x - nA.x, dz = nB.z - nA.z;
        const len2 = dx * dx + dz * dz;
        const t = len2 > 0 ? ((x - nA.x) * dx + (z - nA.z) * dz) / len2 : 0;
        const tc = Math.max(0, Math.min(1, t));
        const y = nA.y + (nB.y - nA.y) * tc;

        const newNode = this.addNode(x, z, y);
        this.removeSegment(segId);
        this.addSegment(a, newNode.id, width, thickness);
        this.addSegment(newNode.id, b, width, thickness);
        return newNode;
    }
}
