// Volume — an axis-aligned rectangular box of interior space
// The level is made of connected volumes. No "room" concept.

export const WALL_THICKNESS = 1;    // 1 WT = the fundamental unit
export const WORLD_SCALE = 0.25;    // 1 WT = 0.25 Three.js meters

export class Volume {
    constructor(id, x, y, z, w, h, d) {
        this.id = id;
        this.x = x; this.y = y; this.z = z;  // min corner of interior
        this.w = w; this.h = h; this.d = d;   // interior dimensions (integers >= 1)
        this.invertNormals = false;            // true for protrusions (normals point outward)
    }

    get outerMinX() { return this.x - WALL_THICKNESS; }
    get outerMaxX() { return this.x + this.w + WALL_THICKNESS; }
    get outerMinY() { return this.y - WALL_THICKNESS; }
    get outerMaxY() { return this.y + this.h + WALL_THICKNESS; }
    get outerMinZ() { return this.z - WALL_THICKNESS; }
    get outerMaxZ() { return this.z + this.d + WALL_THICKNESS; }

    get innerMinX() { return this.x; }
    get innerMaxX() { return this.x + this.w; }
    get innerMinY() { return this.y; }
    get innerMaxY() { return this.y + this.h; }
    get innerMinZ() { return this.z; }
    get innerMaxZ() { return this.z + this.d; }

    clone() {
        const v = new Volume(this.id, this.x, this.y, this.z, this.w, this.h, this.d);
        v.invertNormals = this.invertNormals;
        return v;
    }

    toJSON() {
        const j = { id: this.id, x: this.x, y: this.y, z: this.z, w: this.w, h: this.h, d: this.d };
        if (this.invertNormals) j.invertNormals = true;
        return j;
    }

    static fromJSON(j) {
        const v = new Volume(j.id, j.x, j.y, j.z, j.w, j.h, j.d);
        if (j.invertNormals) v.invertNormals = true;
        return v;
    }
}
