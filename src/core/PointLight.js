// PointLight — a positionable light source for baked vertex lighting
// Follows the same pattern as Platform.js

export class PointLight {
    constructor(id, x, y, z) {
        this.id = id;
        this.x = x;            // position X in WT units
        this.y = y;            // position Y in WT units
        this.z = z;            // position Z in WT units
        this.color = { r: 1, g: 1, b: 1 };  // normalized 0-1 RGB
        this.intensity = 5.0;   // brightness multiplier
        this.range = 20;        // falloff radius in WT units
        this.enabled = true;    // toggle for bake inclusion
    }

    toJSON() {
        return {
            id: this.id,
            x: this.x, y: this.y, z: this.z,
            color: { ...this.color },
            intensity: this.intensity,
            range: this.range,
            enabled: this.enabled,
        };
    }

    static fromJSON(j) {
        const l = new PointLight(j.id, j.x, j.y, j.z);
        l.color = j.color ? { ...j.color } : { r: 1, g: 1, b: 1 };
        l.intensity = j.intensity ?? 5.0;
        l.range = j.range ?? 20;
        l.enabled = j.enabled ?? true;
        return l;
    }
}
