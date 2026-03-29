// AABB collision detection for volumes

export function outerOverlapsInner(outerBox, innerBox) {
    return outerBox.minX < innerBox.maxX && outerBox.maxX > innerBox.minX &&
           outerBox.minY < innerBox.maxY && outerBox.maxY > innerBox.minY &&
           outerBox.minZ < innerBox.maxZ && outerBox.maxZ > innerBox.minZ;
}

export function canExtendVolume(volumes, vol, axis, side) {
    const test = vol.clone();
    applyPush(test, axis, side);

    const outerBox = {
        minX: test.outerMinX, maxX: test.outerMaxX,
        minY: test.outerMinY, maxY: test.outerMaxY,
        minZ: test.outerMinZ, maxZ: test.outerMaxZ,
    };

    for (const other of volumes) {
        if (other.id === vol.id) continue;
        const innerBox = {
            minX: other.innerMinX, maxX: other.innerMaxX,
            minY: other.innerMinY, maxY: other.innerMaxY,
            minZ: other.innerMinZ, maxZ: other.innerMaxZ,
        };
        if (outerOverlapsInner(outerBox, innerBox)) return false;
    }
    return true;
}

export function canPlaceVolume(volumes, newVol) {
    const outerBox = {
        minX: newVol.outerMinX, maxX: newVol.outerMaxX,
        minY: newVol.outerMinY, maxY: newVol.outerMaxY,
        minZ: newVol.outerMinZ, maxZ: newVol.outerMaxZ,
    };

    for (const other of volumes) {
        const innerBox = {
            minX: other.innerMinX, maxX: other.innerMaxX,
            minY: other.innerMinY, maxY: other.innerMaxY,
            minZ: other.innerMinZ, maxZ: other.innerMaxZ,
        };
        if (outerOverlapsInner(outerBox, innerBox)) return false;
    }
    return true;
}

import { state } from './state.js';

const MIN_DIMENSION = 1; // 1 WT minimum

export function applyPush(vol, axis, side) {
    const s = state.pushStep;
    if (axis === 'x') {
        if (side === 'max') vol.w += s;
        else { vol.x -= s; vol.w += s; }
    } else if (axis === 'y') {
        if (side === 'max') vol.h += s;
        else { vol.y -= s; vol.h += s; }
    } else {
        if (side === 'max') vol.d += s;
        else { vol.z -= s; vol.d += s; }
    }
}

export function applyPull(vol, axis, side) {
    const s = state.pushStep;
    if (axis === 'x') {
        if (vol.w <= MIN_DIMENSION) return false;
        if (side === 'max') vol.w -= s;
        else { vol.x += s; vol.w -= s; }
    } else if (axis === 'y') {
        if (vol.h <= MIN_DIMENSION) return false;
        if (side === 'max') vol.h -= s;
        else { vol.y += s; vol.h -= s; }
    } else {
        if (vol.d <= MIN_DIMENSION) return false;
        if (side === 'max') vol.d -= s;
        else { vol.z += s; vol.d -= s; }
    }
    return true;
}
