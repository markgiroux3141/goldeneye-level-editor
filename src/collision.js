// AABB collision detection for volumes

export function outerOverlapsInner(outerBox, innerBox) {
    return outerBox.minX < innerBox.maxX && outerBox.maxX > innerBox.minX &&
           outerBox.minY < innerBox.maxY && outerBox.maxY > innerBox.minY &&
           outerBox.minZ < innerBox.maxZ && outerBox.maxZ > innerBox.minZ;
}

export function canExtendVolume(volumes, vol, axis, side, excludeIds = []) {
    const test = vol.clone();
    applyPush(test, axis, side);

    const outerBox = {
        minX: test.outerMinX, maxX: test.outerMaxX,
        minY: test.outerMinY, maxY: test.outerMaxY,
        minZ: test.outerMinZ, maxZ: test.outerMaxZ,
    };

    for (const other of volumes) {
        if (other.id === vol.id) continue;
        if (excludeIds.includes(other.id)) continue;
        const innerBox = {
            minX: other.innerMinX, maxX: other.innerMaxX,
            minY: other.innerMinY, maxY: other.innerMaxY,
            minZ: other.innerMinZ, maxZ: other.innerMaxZ,
        };
        if (outerOverlapsInner(outerBox, innerBox)) return false;
    }
    return true;
}

export function canPlaceVolume(volumes, newVol, excludeIds = []) {
    const outerBox = {
        minX: newVol.outerMinX, maxX: newVol.outerMaxX,
        minY: newVol.outerMinY, maxY: newVol.outerMaxY,
        minZ: newVol.outerMinZ, maxZ: newVol.outerMaxZ,
    };

    for (const other of volumes) {
        if (excludeIds.includes(other.id)) continue;
        const innerBox = {
            minX: other.innerMinX, maxX: other.innerMaxX,
            minY: other.innerMinY, maxY: other.innerMaxY,
            minZ: other.innerMinZ, maxZ: other.innerMaxZ,
        };
        if (outerOverlapsInner(outerBox, innerBox)) return false;
    }
    return true;
}

// Batch validation: check an array of new volumes against existing volumes AND each other
// skipInterCheck: when true, skip checking new volumes against each other (used for
// adjacent protrusions inside the same parent room)
export function canPlaceVolumes(existingVolumes, newVolumes, excludeIds = [], skipInterCheck = false) {
    for (let i = 0; i < newVolumes.length; i++) {
        const nv = newVolumes[i];
        // Check against existing volumes
        if (!canPlaceVolume(existingVolumes, nv, excludeIds)) return false;
        // Check against other new volumes (unless skipped for protrusions)
        if (!skipInterCheck) {
            for (let j = 0; j < i; j++) {
                const other = newVolumes[j];
                const outerBox = {
                    minX: nv.outerMinX, maxX: nv.outerMaxX,
                    minY: nv.outerMinY, maxY: nv.outerMaxY,
                    minZ: nv.outerMinZ, maxZ: nv.outerMaxZ,
                };
                const innerBox = {
                    minX: other.innerMinX, maxX: other.innerMaxX,
                    minY: other.innerMinY, maxY: other.innerMaxY,
                    minZ: other.innerMinZ, maxZ: other.innerMaxZ,
                };
                if (outerOverlapsInner(outerBox, innerBox)) return false;
                const outerBox2 = {
                    minX: other.outerMinX, maxX: other.outerMaxX,
                    minY: other.outerMinY, maxY: other.outerMaxY,
                    minZ: other.outerMinZ, maxZ: other.outerMaxZ,
                };
                const innerBox2 = {
                    minX: nv.innerMinX, maxX: nv.innerMaxX,
                    minY: nv.innerMinY, maxY: nv.innerMaxY,
                    minZ: nv.innerMinZ, maxZ: nv.innerMaxZ,
                };
                if (outerOverlapsInner(outerBox2, innerBox2)) return false;
            }
        }
    }
    return true;
}

import { state } from './state.js';
// Note: collision uses state.pushStep — this dependency will be removed in Phase 5

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
