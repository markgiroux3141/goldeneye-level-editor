// MultiPolygon → THREE.BufferGeometry: top face (via ShapeGeometry) + vertical
// skirt walls along every ring edge, all packed into one geometry with zone
// groups for the shared material array.

import * as THREE from 'three';
import { GeoBuilder } from './segmentGeometry.js';

const WORLD_SCALE = 0.25;
const ZONE_FLOOR = 0;
const ZONE_SIDE = 1;

// multiPoly: polygon-clipping MultiPolygon. y = top-surface world y (WT).
// thickness: extrusion depth downward (WT). Returns THREE.BufferGeometry with
// zone groups (material-index 0 for floor, 1 for blue sides).
export function polygonToGeometry(multiPoly, y, thickness) {
    const builder = new GeoBuilder();
    const yBot = y - thickness;

    for (const polygon of multiPoly) {
        if (!polygon.length) continue;
        const outer = polygon[0];
        if (!outer || outer.length < 4) continue;

        // ── Top face via THREE.ShapeGeometry ──
        // ShapeGeometry triangulates in its local XY plane. We feed world (x, z)
        // as Shape's (X, Y) and then reinterpret the resulting vertex Y as world Z.
        const outerPts = outer.slice(0, -1).map(([x, z]) => new THREE.Vector2(x, z));
        const shape = new THREE.Shape(outerPts);
        for (let i = 1; i < polygon.length; i++) {
            const hole = polygon[i];
            if (!hole || hole.length < 4) continue;
            const holePts = hole.slice(0, -1).map(([x, z]) => new THREE.Vector2(x, z));
            shape.holes.push(new THREE.Path(holePts));
        }
        const shapeGeo = new THREE.ShapeGeometry(shape);
        const pos = shapeGeo.attributes.position.array;
        const idx = shapeGeo.index ? shapeGeo.index.array : null;
        // ShapeGeometry emits (x, localY, 0); reinterpret localY as world Z.
        // Remap every triangle through GeoBuilder so it ends up in the same
        // BufferGeometry as the skirts, with world-xz UVs for texture
        // continuity with stair treads.
        const vCount = pos.length / 3;
        const verts = [];
        for (let v = 0; v < vCount; v++) {
            const px = pos[v * 3];
            const pz = pos[v * 3 + 1];   // ShapeGeometry's local Y
            verts.push([px, y, pz]);
        }
        const triCount = idx ? idx.length / 3 : vCount / 3;
        for (let t = 0; t < triCount; t++) {
            const i0 = idx ? idx[t * 3]     : t * 3;
            const i1 = idx ? idx[t * 3 + 1] : t * 3 + 1;
            const i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
            const v0 = verts[i0], v1 = verts[i1], v2 = verts[i2];
            builder.addTri(
                v0, v1, v2,
                [0, 1, 0],
                ZONE_FLOOR,
                [v0[0], v0[2]], [v1[0], v1[2]], [v2[0], v2[2]],
            );
        }
        shapeGeo.dispose();

        // ── Skirts on every ring edge ──
        for (const ring of polygon) {
            if (!ring || ring.length < 2) continue;
            for (let i = 0; i < ring.length - 1; i++) {
                const [px, pz] = ring[i];
                const [qx, qz] = ring[i + 1];
                const edgeLen = Math.hypot(qx - px, qz - pz);
                if (edgeLen < 1e-6) continue;
                builder.addQuad(
                    [px, yBot, pz],
                    [qx, yBot, qz],
                    [qx, y,    qz],
                    [px, y,    pz],
                    ZONE_SIDE,
                    [0, 0], [edgeLen, 0], [edgeLen, 1], [0, 1],
                );
            }
        }
    }

    const geo = builder.build();
    // GeoBuilder positions already bake WORLD_SCALE, so the mesh can be placed
    // at the origin without additional scaling.
    void WORLD_SCALE;
    return geo;
}
