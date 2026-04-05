// Volume push/pull operations

const MIN_DIMENSION = 1; // 1 WT minimum

export function applyPush(vol, axis, side, step) {
    const s = step;
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

export function applyPull(vol, axis, side, step) {
    const s = step;
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
