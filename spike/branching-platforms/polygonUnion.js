// Segment rectangle + polygon union for a flat component.
// polygon-clipping format:
//   Ring         = [ [x, z], [x, z], …, [x0, z0] ]   (first point repeated at end)
//   Polygon      = [ outerRing, hole1, hole2, … ]
//   MultiPolygon = [ polygon1, polygon2, … ]
// outer rings are CCW, holes CW.

import polygonClipping from 'polygon-clipping';

// 4-corner rectangle around a segment's centerline, as a MultiPolygon ([[ring]]).
// Returns null for degenerate (zero-length) segments.
export function segmentRect(seg, graph) {
    const a = graph.nodes.get(seg.a);
    const b = graph.nodes.get(seg.b);
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return null;
    const ax = dx / len, az = dz / len;
    const lx = -az, lz = ax;   // CCW 90° (left)
    const hw = seg.width / 2;
    const p0 = [a.x + hw * lx, a.z + hw * lz];
    const p1 = [a.x - hw * lx, a.z - hw * lz];
    const p2 = [b.x - hw * lx, b.z - hw * lz];
    const p3 = [b.x + hw * lx, b.z + hw * lz];
    // polygon-clipping expects first==last.
    return [[[p0, p1, p2, p3, p0]]];
}

// Union every rectangle in a flat component. Returns a MultiPolygon.
// Single-segment shortcut avoids calling the library with one input (which
// some versions handle oddly) and catches per-rect degeneracies.
export function unionComponent(comp, graph) {
    const rects = [];
    for (const seg of comp.segments) {
        const r = segmentRect(seg, graph);
        if (r) rects.push(r);
    }
    if (rects.length === 0) return [];
    if (rects.length === 1) return rects[0];
    try {
        return polygonClipping.union(rects[0], ...rects.slice(1));
    } catch (err) {
        // If union fails, fall back to emitting each rect as its own polygon
        // (MultiPolygon with N separate polygons). Overlapping — old stitching
        // artifacts return for this component — but at least nothing crashes.
        console.warn('polygon-clipping union failed; falling back to per-rect', err);
        return rects.map((r) => r[0]);
    }
}
