// Cave-envelope wireframe overlay. One blue box per brush flagged
// isCaveEnvelope; rebuilt on demand (toggle + load), not per-frame.

import * as THREE from 'three';
import { state } from '../state.js';
import { scene } from '../scene/setup.js';
import { WORLD_SCALE } from '../core/constants.js';

const envelopeMat = new THREE.LineBasicMaterial({
    color: 0x44aaff,
    transparent: true,
    opacity: 0.85,
    depthTest: true,
});

// brushId → THREE.LineSegments
const envelopeOverlays = new Map();

function disposeOverlay(line) {
    scene.remove(line);
    if (line.geometry) line.geometry.dispose();
}

function buildBoxEdgeGeometry(brush) {
    const s = WORLD_SCALE;
    const x0 = brush.x * s,  x1 = (brush.x + brush.w) * s;
    const y0 = brush.y * s,  y1 = (brush.y + brush.h) * s;
    const z0 = brush.z * s,  z1 = (brush.z + brush.d) * s;
    const box = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
    box.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    const edges = new THREE.EdgesGeometry(box);
    box.dispose();
    return edges;
}

export function updateEnvelopePreviews() {
    const seen = new Set();
    for (const brush of state.csg.brushes) {
        if (!brush.isCaveEnvelope) continue;
        seen.add(brush.id);

        const existing = envelopeOverlays.get(brush.id);
        const newGeom = buildBoxEdgeGeometry(brush);
        if (existing) {
            existing.geometry.dispose();
            existing.geometry = newGeom;
        } else {
            const line = new THREE.LineSegments(newGeom, envelopeMat);
            line.name = `envelope_${brush.id}`;
            envelopeOverlays.set(brush.id, line);
            scene.add(line);
        }
    }

    // Dispose overlays for brushes that are no longer envelopes / no longer exist.
    for (const [id, line] of envelopeOverlays) {
        if (!seen.has(id)) {
            disposeOverlay(line);
            envelopeOverlays.delete(id);
        }
    }
}

export function disposeAllEnvelopePreviews() {
    for (const line of envelopeOverlays.values()) disposeOverlay(line);
    envelopeOverlays.clear();
}
