// Staircase — a solid stepped structure with one or more segments and landings
// Waypoints define the anchor edge. Width extends perpendicular based on 'side'.
// 'right'/'left' is relative to the walk direction (top→bottom), using up × walkDir.

export class Staircase {
    constructor(id, waypoints, width, stepHeight, side) {
        this.id = id;
        this.waypoints = waypoints;   // [{x, y, z}, ...] in WT units (at least 2)
        this.width = width;           // perpendicular width in WT units
        this.stepHeight = stepHeight; // height of each step in WT units
        this.side = side;             // 'left' | 'right'
    }

    toJSON() {
        return {
            id: this.id,
            waypoints: this.waypoints,
            width: this.width, stepHeight: this.stepHeight, side: this.side,
        };
    }

    static fromJSON(j) {
        return new Staircase(j.id, j.waypoints, j.width, j.stepHeight, j.side);
    }
}

/**
 * Compute segment info between two waypoints.
 * runSign: +1 if walking in positive axis direction, -1 if negative.
 */
export function getSegmentInfo(wpA, wpB, stepHeight) {
    const dx = Math.abs(wpA.x - wpB.x);
    const dz = Math.abs(wpA.z - wpB.z);
    const runAxis = dx >= dz ? 'x' : 'z';
    const rise = Math.abs(wpA.y - wpB.y);
    const topPt = wpA.y >= wpB.y ? wpA : wpB;
    const bottomPt = wpA.y >= wpB.y ? wpB : wpA;
    const steps = rise > 0 ? Math.max(1, Math.round(rise / stepHeight)) : 0;

    // Walk direction: from top toward bottom (descending)
    const topRun = runAxis === 'x' ? topPt.x : topPt.z;
    const bottomRun = runAxis === 'x' ? bottomPt.x : bottomPt.z;
    const runSign = bottomRun >= topRun ? 1 : -1;

    return { runAxis, runSign, topPt, bottomPt, steps, isFlat: rise === 0 };
}

/**
 * Compute the perpendicular width extent for a segment.
 * 'right'/'left' is relative to walk direction using cross product up × walkDir:
 *   Walk +X → right = -Z    Walk -X → right = +Z
 *   Walk +Z → right = +X    Walk -Z → right = -X
 */
export function getSegmentWidthExtent(topPt, runAxis, runSign, width, side) {
    const anchor = runAxis === 'x' ? topPt.z : topPt.x;

    // Determine if "right" extends in the positive perpendicular direction
    let rightIsPositive;
    if (runAxis === 'x') {
        rightIsPositive = runSign < 0; // walk +X → right is -Z, walk -X → right is +Z
    } else {
        rightIsPositive = runSign > 0; // walk +Z → right is +X, walk -Z → right is -X
    }

    const extendPositive = (side === 'right') === rightIsPositive;
    if (extendPositive) return { perpMin: anchor, perpMax: anchor + width };
    return { perpMin: anchor - width, perpMax: anchor };
}
