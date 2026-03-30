// Staircase — a solid stepped structure connecting two height levels

export class Staircase {
    constructor(id, topX, topY, topZ, bottomX, bottomY, bottomZ, width, stepHeight, side) {
        this.id = id;
        this.topX = topX;
        this.topY = topY;
        this.topZ = topZ;
        this.bottomX = bottomX;
        this.bottomY = bottomY;
        this.bottomZ = bottomZ;
        this.width = width;           // perpendicular width in WT units
        this.stepHeight = stepHeight; // height of each step in WT units
        this.side = side;             // 'left' | 'right' — which side width extends from anchor line
    }

    // Derived: number of steps based on total rise and step height
    get steps() {
        return Math.max(1, Math.round((this.topY - this.bottomY) / this.stepHeight));
    }

    // Derived: which horizontal axis the staircase runs along
    get runAxis() {
        const dx = Math.abs(this.topX - this.bottomX);
        const dz = Math.abs(this.topZ - this.bottomZ);
        return dx >= dz ? 'x' : 'z';
    }

    toJSON() {
        return {
            id: this.id,
            topX: this.topX, topY: this.topY, topZ: this.topZ,
            bottomX: this.bottomX, bottomY: this.bottomY, bottomZ: this.bottomZ,
            width: this.width, stepHeight: this.stepHeight, side: this.side,
        };
    }

    static fromJSON(j) {
        return new Staircase(
            j.id, j.topX, j.topY, j.topZ,
            j.bottomX, j.bottomY, j.bottomZ,
            j.width, j.stepHeight, j.side,
        );
    }
}
