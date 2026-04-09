// CSGRegion — one connected cluster of brushes plus its auto-resized shell.
// Ported and adapted from spike/csg/main.js (shell + evaluateBrushes + bake + updateShell).
//
// In the spike, there's exactly one global shell carved by all brushes. Here we
// support multiple disconnected regions (via clusterBrushes in regions.js), and
// each region owns its own shell, its own subset of brushes, and an optional
// baked-CSG-brush representing previously merged interior geometry.

import { Evaluator, ADDITION, SUBTRACTION } from 'three-bvh-csg';
import { WALL_THICKNESS, WORLD_SCALE } from '../constants.js';
import { BrushDef } from '../BrushDef.js';
import { buildFaceMap } from './faceMap.js';

// One shared evaluator instance — three-bvh-csg recommends reuse for caching.
const csgEvaluator = new Evaluator();

export class CSGRegion {
    constructor(id) {
        this.id = id;
        // Shell starts as a 1×1×1 placeholder; updateShell() resizes to fit brushes.
        // Shell uses brushId = -1 (sentinel). buildFaceMap reserves 0 for "baked/unmatched"
        // and user brushes have positive ids assigned from state.csg.nextBrushId.
        this.shell = new BrushDef(-1, 'add', 0, 0, 0, 1, 1, 1);
        this.brushes = [];               // BrushDef[] (the un-baked brushes)
        this.bakedCSGBrush = null;       // CSG Brush of previously merged interior, or null
        this.bakedBounds = null;         // { minX, minY, minZ, maxX, maxY, maxZ } in WT
        this.totalBakedBrushes = 0;
    }

    // Auto-resize the shell to fit all subtractive brushes + baked bounds, with
    // a WALL_THICKNESS margin so each room has solid walls in every direction.
    updateShell() {
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        if (this.bakedBounds) {
            minX = this.bakedBounds.minX; minY = this.bakedBounds.minY; minZ = this.bakedBounds.minZ;
            maxX = this.bakedBounds.maxX; maxY = this.bakedBounds.maxY; maxZ = this.bakedBounds.maxZ;
        }

        for (const b of this.brushes) {
            if (b.op !== 'subtract') continue;
            minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY); minZ = Math.min(minZ, b.minZ);
            maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY); maxZ = Math.max(maxZ, b.maxZ);
        }
        if (!isFinite(minX)) return;

        const t = WALL_THICKNESS;
        this.shell.x = minX - t; this.shell.y = minY - t; this.shell.z = minZ - t;
        this.shell.w = (maxX - minX) + t * 2;
        this.shell.h = (maxY - minY) + t * 2;
        this.shell.d = (maxZ - minZ) + t * 2;
    }

    // Run CSG: shell - bakedCSGBrush ± each unbaked brush.
    // Returns the result as { geometry, faceIds, timeMs }.
    evaluateBrushes() {
        this.updateShell();
        const t0 = performance.now();

        let result = this.shell.toCSGBrush();

        if (this.bakedCSGBrush) {
            result = csgEvaluator.evaluate(result, this.bakedCSGBrush, SUBTRACTION);
        }

        for (const brush of this.brushes) {
            const csgBrush = brush.toCSGBrush();
            const op = brush.op === 'subtract' ? SUBTRACTION : ADDITION;
            result = csgEvaluator.evaluate(result, csgBrush, op);
        }

        const elapsed = performance.now() - t0;
        const geometry = result.geometry;
        const allBrushes = [this.shell, ...this.brushes];
        const faceIds = buildFaceMap(geometry, allBrushes);
        return { geometry, timeMs: elapsed, faceIds };
    }

    // Merge all unbaked brushes into bakedCSGBrush, then clear the unbaked list.
    // After bake, push/pull operations create new sub-face brushes against the
    // baked geometry instead of mutating individual brushes.
    bake() {
        if (this.brushes.length === 0 && !this.bakedCSGBrush) return;

        let interior = this.bakedCSGBrush;

        for (const brush of this.brushes) {
            const csgBrush = brush.toCSGBrush();
            if (brush.op === 'subtract') {
                if (!interior) {
                    interior = csgBrush;
                } else {
                    interior = csgEvaluator.evaluate(interior, csgBrush, ADDITION);
                }
            } else {
                if (interior) {
                    interior = csgEvaluator.evaluate(interior, csgBrush, SUBTRACTION);
                }
            }
        }

        const bakedCount = this.brushes.length;
        this.totalBakedBrushes += bakedCount;
        this.bakedCSGBrush = interior;

        if (interior && interior.geometry) {
            interior.geometry.computeBoundingBox();
            const bb = interior.geometry.boundingBox;
            // Convert from world-scale back to WT for shell auto-resize math.
            // (BrushDef.toCSGBrush multiplies by WORLD_SCALE; reverse here.)
            this.bakedBounds = {
                minX: Math.round(bb.min.x / WORLD_SCALE), minY: Math.round(bb.min.y / WORLD_SCALE), minZ: Math.round(bb.min.z / WORLD_SCALE),
                maxX: Math.round(bb.max.x / WORLD_SCALE), maxY: Math.round(bb.max.y / WORLD_SCALE), maxZ: Math.round(bb.max.z / WORLD_SCALE),
            };
        }

        this.brushes.length = 0;
        return bakedCount;
    }
}
