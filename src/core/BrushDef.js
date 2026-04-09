// BrushDef — a single CSG brush (additive or subtractive) with optional per-face taper.
// Ported from spike/csg/main.js (BrushDef class + applyTaperToBoxGeo).

import * as THREE from 'three';
import { Brush as CSGBrush } from 'three-bvh-csg';
import { WORLD_SCALE } from './constants.js';

export class BrushDef {
    constructor(id, op, x, y, z, w, h, d) {
        this.id = id;
        this.op = op;                  // 'add' | 'subtract'
        this.x = x; this.y = y; this.z = z;
        this.w = w; this.h = h; this.d = d;
        // Per-face taper: key = 'x-min'|'x-max'|'y-min'|'y-max'|'z-min'|'z-max'
        // value = { u: number, v: number } — symmetric inset in WT on each edge
        this.taper = {};
        this.isDoorframe = false;      // door frame brush (zone 5 walls + zone 6 floor)
        this.isHoleFrame = false;      // generic hole frame brush (zone 5 all sides)
        this.isBrace = false;          // structural brace brush (all faces zone 7)
        this.schemeKey = 'facility_white_tile';
        this.floorY = y;               // WT-space anchor for wall texture vertical split
    }

    hasTaper() { return Object.keys(this.taper).length > 0; }

    toCSGBrush() {
        const geo = new THREE.BoxGeometry(this.w * WORLD_SCALE, this.h * WORLD_SCALE, this.d * WORLD_SCALE);
        if (this.hasTaper()) {
            applyTaperToBoxGeo(geo, this);
        }
        const cx = (this.x + this.w / 2) * WORLD_SCALE;
        const cy = (this.y + this.h / 2) * WORLD_SCALE;
        const cz = (this.z + this.d / 2) * WORLD_SCALE;
        const brush = new CSGBrush(geo);
        brush.position.set(cx, cy, cz);
        brush.updateMatrixWorld();
        return brush;
    }

    getFaces() {
        return [
            { brushId: this.id, axis: 'x', side: 'min', pos: this.x },
            { brushId: this.id, axis: 'x', side: 'max', pos: this.x + this.w },
            { brushId: this.id, axis: 'y', side: 'min', pos: this.y },
            { brushId: this.id, axis: 'y', side: 'max', pos: this.y + this.h },
            { brushId: this.id, axis: 'z', side: 'min', pos: this.z },
            { brushId: this.id, axis: 'z', side: 'max', pos: this.z + this.d },
        ];
    }

    get minX() { return this.x; }  get maxX() { return this.x + this.w; }
    get minY() { return this.y; }  get maxY() { return this.y + this.h; }
    get minZ() { return this.z; }  get maxZ() { return this.z + this.d; }

    clone() {
        const b = new BrushDef(this.id, this.op, this.x, this.y, this.z, this.w, this.h, this.d);
        b.taper = JSON.parse(JSON.stringify(this.taper));
        b.isDoorframe = this.isDoorframe;
        b.isHoleFrame = this.isHoleFrame;
        b.isBrace = this.isBrace;
        b.schemeKey = this.schemeKey;
        b.floorY = this.floorY;
        return b;
    }

    toJSON() {
        const j = {
            id: this.id, op: this.op,
            x: this.x, y: this.y, z: this.z,
            w: this.w, h: this.h, d: this.d,
        };
        if (this.hasTaper()) j.taper = this.taper;
        if (this.isDoorframe) j.isDoorframe = true;
        if (this.isHoleFrame) j.isHoleFrame = true;
        if (this.isBrace) j.isBrace = true;
        if (this.schemeKey !== 'facility_white_tile') j.schemeKey = this.schemeKey;
        if (this.floorY !== this.y) j.floorY = this.floorY;
        return j;
    }

    static fromJSON(j) {
        const b = new BrushDef(j.id, j.op, j.x, j.y, j.z, j.w, j.h, j.d);
        if (j.taper) b.taper = j.taper;
        if (j.isDoorframe) b.isDoorframe = true;
        if (j.isHoleFrame) b.isHoleFrame = true;
        if (j.isBrace) b.isBrace = true;
        if (j.schemeKey) b.schemeKey = j.schemeKey;
        if (j.floorY !== undefined) b.floorY = j.floorY;
        return b;
    }
}

// ─── Taper: Modify BoxGeometry Vertices In-Place ────────────────────────
// Instead of building custom geometry, we modify a standard BoxGeometry.
// This preserves the index buffer, UVs, and groups that three-bvh-csg expects.
// For each tapered face, we find all vertices at that face's position and
// move them toward the face center in the face's UV plane.
function applyTaperToBoxGeo(geo, brush) {
    const pos = geo.getAttribute('position');
    const hw = brush.w * WORLD_SCALE / 2;
    const hh = brush.h * WORLD_SCALE / 2;
    const hd = brush.d * WORLD_SCALE / 2;

    for (const [faceKey, { u: tU, v: tV }] of Object.entries(brush.taper)) {
        const [axis, side] = faceKey.split('-');

        let checkAxis, target, uAxis, vAxis;
        if (axis === 'y') {
            checkAxis = 1; target = side === 'max' ? hh : -hh;
            uAxis = 0; vAxis = 2;
        } else if (axis === 'x') {
            checkAxis = 0; target = side === 'max' ? hw : -hw;
            uAxis = 2; vAxis = 1;
        } else {
            checkAxis = 2; target = side === 'max' ? hd : -hd;
            uAxis = 0; vAxis = 1;
        }

        const getComp = (i, c) => c === 0 ? pos.getX(i) : c === 1 ? pos.getY(i) : pos.getZ(i);

        for (let i = 0; i < pos.count; i++) {
            const val = getComp(i, checkAxis);
            if (Math.abs(val - target) < 0.001) {
                const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
                const coords = [x, y, z];
                coords[uAxis] -= Math.sign(coords[uAxis]) * tU * WORLD_SCALE;
                coords[vAxis] -= Math.sign(coords[vAxis]) * tV * WORLD_SCALE;
                pos.setXYZ(i, coords[0], coords[1], coords[2]);
            }
        }
    }

    pos.needsUpdate = true;
    geo.computeVertexNormals();
}
