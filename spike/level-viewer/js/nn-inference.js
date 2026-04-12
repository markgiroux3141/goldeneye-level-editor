// Neural network inference for vertex color prediction.
// Loads exported PyTorch weights and runs a small MLP in pure JS.

import * as THREE from 'three';

let modelData = null;

/**
 * Load the exported model weights JSON.
 */
export async function loadModel() {
    if (modelData) return;
    const resp = await fetch('./js/model_weights.json');
    modelData = await resp.json();
    console.log(`NN model loaded: ${modelData.layers.length} layers, ` +
        `features: ${modelData.feature_names.join(', ')}`);
}

/**
 * Run MLP forward pass on a single feature vector.
 * Returns brightness 0-1.
 */
function mlpForward(features) {
    let x = features;

    for (let l = 0; l < modelData.layers.length; l++) {
        const { weights, bias } = modelData.layers[l];
        const activation = modelData.activations[l];
        const outSize = bias.length;
        const out = new Float64Array(outSize);

        for (let i = 0; i < outSize; i++) {
            let sum = bias[i];
            const w = weights[i];
            for (let j = 0; j < x.length; j++) {
                sum += w[j] * x[j];
            }
            out[i] = sum;
        }

        // Activation
        if (activation === 'relu') {
            for (let i = 0; i < outSize; i++) {
                if (out[i] < 0) out[i] = 0;
            }
        } else if (activation === 'sigmoid') {
            for (let i = 0; i < outSize; i++) {
                out[i] = 1.0 / (1.0 + Math.exp(-out[i]));
            }
        }

        x = out;
    }

    return x[0];
}

/**
 * Compute the 10 input features for every vertex and run NN inference.
 * Returns a Float32Array of RGB vertex colors (length = vertexCount * 3).
 *
 * Features (must match training):
 *   0-2: vertex normal (nx, ny, nz)
 *   3:   local height ratio
 *   4:   normal.y (duplicate)
 *   5:   local room height (normalized)
 *   6:   vertex density (normalized)
 *   7:   mean neighbor brightness (from actual vertex colors)
 *   8:   is_outdoor
 *   9:   face area (log-scaled, normalized)
 */
export function computeNNColors(geometry, actualColors, isOutdoor, heightMap) {
    if (!modelData) {
        console.warn('NN model not loaded');
        return null;
    }

    const positions = geometry.getAttribute('position').array;
    const normals = geometry.getAttribute('normal').array;
    const vertCount = positions.length / 3;
    const colors = new Float32Array(vertCount * 3);

    const { mean: featMean, std: featStd } = modelData.normalization;

    // --- Precompute per-vertex data ---

    // Build face list and adjacency from the non-indexed geometry
    // Every 3 consecutive vertices form a triangle
    const faceCount = vertCount / 3;

    // Per-vertex: face count, neighbor set, face areas
    // Since geometry is non-indexed, each vertex index appears in exactly 1 face
    // But shared vertices (same position) need to be linked
    // For speed, we'll use a spatial hash to find coincident vertices

    // Actual brightness per vertex
    const brightness = new Float32Array(vertCount);
    for (let i = 0; i < vertCount; i++) {
        brightness[i] = (actualColors[i * 3] + actualColors[i * 3 + 1] + actualColors[i * 3 + 2]) / 3;
    }

    // Face areas
    const faceAreas = new Float32Array(faceCount);
    const v0 = new THREE.Vector3(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3();
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), cross = new THREE.Vector3();

    for (let f = 0; f < faceCount; f++) {
        const base = f * 3;
        v0.set(positions[base * 3], positions[base * 3 + 1], positions[base * 3 + 2]);
        v1.set(positions[(base + 1) * 3], positions[(base + 1) * 3 + 1], positions[(base + 1) * 3 + 2]);
        v2.set(positions[(base + 2) * 3], positions[(base + 2) * 3 + 1], positions[(base + 2) * 3 + 2]);
        e1.subVectors(v1, v0);
        e2.subVectors(v2, v0);
        cross.crossVectors(e1, e2);
        faceAreas[f] = cross.length() * 0.5;
    }

    // Max face area for normalization (log-scaled)
    let maxLogArea = 0;
    for (let f = 0; f < faceCount; f++) {
        const la = Math.log1p(faceAreas[f]);
        if (la > maxLogArea) maxLogArea = la;
    }
    if (maxLogArea === 0) maxLogArea = 1;

    // Bounding box for height
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const globalYMin = geometry.boundingBox.min.y;
    const globalYMax = geometry.boundingBox.max.y;
    const globalYRange = globalYMax - globalYMin || 1;

    // Find max local room height for normalization
    let maxRoomHeight = 0;
    if (heightMap) {
        for (let i = 0; i < vertCount; i++) {
            const rh = heightMap[i * 2 + 1] - heightMap[i * 2];
            if (rh > maxRoomHeight) maxRoomHeight = rh;
        }
    }
    if (maxRoomHeight === 0) maxRoomHeight = globalYRange;

    // Use actual ground-truth neighbor brightness as input feature.
    // This is what the model was trained on. For new geometry without
    // ground truth, we'd need an iterative approach, but for analysis
    // of existing levels this gives the best results.
    const neighborBrightness = new Float32Array(vertCount);
    for (let f = 0; f < faceCount; f++) {
        const a = f * 3, b = f * 3 + 1, c = f * 3 + 2;
        neighborBrightness[a] = (brightness[b] + brightness[c]) / 2;
        neighborBrightness[b] = (brightness[a] + brightness[c]) / 2;
        neighborBrightness[c] = (brightness[a] + brightness[b]) / 2;
    }

    const rawFeatures = new Float64Array(10);

    {
        for (let i = 0; i < vertCount; i++) {
            const nx = normals[i * 3];
            const ny = normals[i * 3 + 1];
            const nz = normals[i * 3 + 2];
            const py = positions[i * 3 + 1];
            const faceIdx = Math.floor(i / 3);

            rawFeatures[0] = nx;
            rawFeatures[1] = ny;
            rawFeatures[2] = nz;

            if (heightMap) {
                const floorY = heightMap[i * 2];
                const ceilY = heightMap[i * 2 + 1];
                const localRange = ceilY - floorY;
                rawFeatures[3] = localRange > 10 ? (py - floorY) / localRange : 0.5;
            } else {
                rawFeatures[3] = (py - globalYMin) / globalYRange;
            }

            rawFeatures[4] = ny;

            if (heightMap) {
                const rh = heightMap[i * 2 + 1] - heightMap[i * 2];
                rawFeatures[5] = rh / maxRoomHeight;
            } else {
                rawFeatures[5] = 1.0;
            }

            rawFeatures[6] = 0.18;
            rawFeatures[7] = neighborBrightness[i];
            rawFeatures[8] = isOutdoor ? 1.0 : 0.0;
            rawFeatures[9] = Math.log1p(faceAreas[faceIdx]) / maxLogArea;

            const normFeatures = new Float64Array(10);
            for (let j = 0; j < 10; j++) {
                normFeatures[j] = (rawFeatures[j] - featMean[j]) / featStd[j];
            }

            const b = mlpForward(normFeatures);
            colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = b;
        }
    }

    // --- Spatial smoothing pass ---
    // The non-indexed geometry means adjacent faces don't share vertices.
    // Build a spatial hash to find coincident/nearby vertices and smooth.
    // Merge vertices at the same position, weighted by normal similarity
    mergeCoincidentVertices(colors, positions, normals, vertCount);

    return colors;
}

/**
 * Normal-weighted merge of coincident vertices.
 * Vertices at the same position are averaged, but weighted by how similar
 * their face normals are (dot product). This means:
 * - Coplanar faces (dot=1): fully averaged — eliminates seams
 * - Perpendicular faces (dot=0): not averaged — preserves hard edges
 * - Opposing faces (dot<0): not averaged
 */
function mergeCoincidentVertices(colors, positions, normals, vertCount) {
    const SNAP = 0.5;
    const groups = new Map();

    for (let i = 0; i < vertCount; i++) {
        const kx = Math.round(positions[i * 3] / SNAP);
        const ky = Math.round(positions[i * 3 + 1] / SNAP);
        const kz = Math.round(positions[i * 3 + 2] / SNAP);
        const key = `${kx},${ky},${kz}`;

        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(i);
    }

    for (const indices of groups.values()) {
        if (indices.length <= 1) continue;

        // For each vertex in the group, compute a normal-weighted average
        for (const i of indices) {
            const nix = normals[i * 3];
            const niy = normals[i * 3 + 1];
            const niz = normals[i * 3 + 2];

            let weightedSum = colors[i * 3]; // self-weight = 1
            let totalWeight = 1.0;

            for (const j of indices) {
                if (j === i) continue;
                // Dot product of normals
                const dot = nix * normals[j * 3]
                          + niy * normals[j * 3 + 1]
                          + niz * normals[j * 3 + 2];
                const w = Math.max(0, dot);
                weightedSum += colors[j * 3] * w;
                totalWeight += w;
            }

            colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] =
                weightedSum / totalWeight;
        }
    }
}
