// CaveDef — a single voxel-carved cavity anchored to a CSG face via its
// mouth brush. Owned by a CSGRegion (`region.caves[]`); dies with the region.
//
// Voxel data lives in the CaveWorld (Rust/WASM) — CaveDef only holds metadata
// the JS side needs: anchor face identity, mouth-brush link, current voxel
// extent AABB (world meters) so the region's shell can pad around it.

export class CaveDef {
    constructor(id, regionId) {
        this.id = id;
        this.regionId = regionId;

        // Face the cave was carved from. Coordinates in WT (same as BrushDef).
        // { axis, side, position, u0, u1, v0, v1, anchorBrushId }
        this.anchorFace = null;

        // Id of the subtract brush that punches the wall opening.
        this.mouthBrushId = null;

        // Live extent of carved voxels in world meters. Updated by caveMesh.js
        // after each remesh. Drives CSGRegion.updateShell() padding.
        // null until first meshing completes.
        this.extentAabb = null;  // { minX, minY, minZ, maxX, maxY, maxZ }

        // Voxel state is NOT stored here — the CaveWorld owns it in WASM
        // memory. Phase 6 will add JSON serialization that pulls voxel data
        // out of the world at save time.
    }

    toJSON() {
        return {
            id: this.id,
            regionId: this.regionId,
            anchorFace: this.anchorFace,
            mouthBrushId: this.mouthBrushId,
            // extentAabb + voxel data rebuilt from WASM on load (Phase 6).
        };
    }

    static fromJSON(j) {
        const c = new CaveDef(j.id, j.regionId);
        c.anchorFace = j.anchorFace || null;
        c.mouthBrushId = j.mouthBrushId ?? null;
        return c;
    }
}
