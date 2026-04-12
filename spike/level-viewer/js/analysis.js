// Vertex color analysis functions for studying GoldenEye lighting patterns

import * as THREE from 'three';

/**
 * Color vertices by normal direction.
 * Red = facing up (normal.y = +1), Green = sideways, Blue = facing down (normal.y = -1)
 */
export function computeNormalDirectionColors(geometry) {
    const normals = geometry.getAttribute('normal').array;
    const count = normals.length / 3;
    const colors = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
        const ny = normals[i * 3 + 1];
        // Map normal.y from [-1,+1] to a red-green-blue gradient
        if (ny > 0) {
            // Facing up: green -> red
            colors[i * 3]     = ny;       // R
            colors[i * 3 + 1] = 1 - ny;   // G
            colors[i * 3 + 2] = 0;        // B
        } else {
            // Facing down: green -> blue
            colors[i * 3]     = 0;         // R
            colors[i * 3 + 1] = 1 + ny;   // G
            colors[i * 3 + 2] = -ny;      // B
        }
    }

    return colors;
}

/**
 * Compute local floor/ceiling heights per vertex by raycasting up and down.
 * Returns a Float32Array of [floorY, ceilY] pairs (length = vertexCount * 2).
 * This is a precomputed step — expensive but cached.
 */
export async function computeLocalHeightMap(geometry, mesh, { onProgress = null } = {}) {
    const positions = geometry.getAttribute('position').array;
    const normals = geometry.getAttribute('normal').array;
    const count = positions.length / 3;
    const heightMap = new Float32Array(count * 2); // [floorY, ceilY] per vertex

    const raycaster = new THREE.Raycaster();
    const origin = new THREE.Vector3();
    const upDir = new THREE.Vector3(0, 1, 0);
    const downDir = new THREE.Vector3(0, -1, 0);

    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const globalYMin = geometry.boundingBox.min.y;
    const globalYMax = geometry.boundingBox.max.y;

    const BATCH_SIZE = 200;

    for (let i = 0; i < count; i++) {
        const px = positions[i * 3];
        const py = positions[i * 3 + 1];
        const pz = positions[i * 3 + 2];
        const nx = normals[i * 3];
        const ny = normals[i * 3 + 1];
        const nz = normals[i * 3 + 2];

        // Offset origin slightly inward from the surface to avoid self-hit
        origin.set(
            px - nx * 5,
            py - ny * 5,
            pz - nz * 5
        );

        // Raycast up to find ceiling
        raycaster.set(origin, upDir);
        raycaster.far = Infinity;
        let hits = raycaster.intersectObject(mesh, false);
        const ceilY = hits.length > 0 ? hits[0].point.y : globalYMax;

        // Raycast down to find floor
        raycaster.set(origin, downDir);
        hits = raycaster.intersectObject(mesh, false);
        const floorY = hits.length > 0 ? hits[0].point.y : globalYMin;

        heightMap[i * 2] = floorY;
        heightMap[i * 2 + 1] = ceilY;

        if (i % BATCH_SIZE === 0 && i > 0) {
            if (onProgress) onProgress(i / count);
            await new Promise(r => setTimeout(r, 0));
        }
    }

    if (onProgress) onProgress(1);
    return heightMap;
}

/**
 * Compute predicted lighting using directional + ambient + local height gradient.
 * Uses per-vertex local floor/ceiling heights (from computeLocalHeightMap)
 * to create room-aware height falloff instead of global.
 *
 * Parameters:
 *   ambient       - base brightness floor (0-1)
 *   intensity     - directional light strength (0-1)
 *   heightFalloff - how much height darkens vertices (0-1)
 *   heightMap     - precomputed [floorY, ceilY] per vertex (optional, falls back to global)
 *   lightDir      - light direction vector (default: straight up)
 */
export function computePredictedLighting(geometry, {
    ambient = 0.3, intensity = 0.7, heightFalloff = 0.5,
    heightMap = null, lightDir = null
} = {}) {
    const positions = geometry.getAttribute('position').array;
    const normals = geometry.getAttribute('normal').array;
    const count = normals.length / 3;
    const colors = new Float32Array(count * 3);

    const dir = lightDir || new THREE.Vector3(0, 1, 0);
    dir.normalize();

    // Global fallback Y range
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const globalYMin = geometry.boundingBox.min.y;
    const globalYMax = geometry.boundingBox.max.y;
    const globalYRange = globalYMax - globalYMin;

    for (let i = 0; i < count; i++) {
        const nx = normals[i * 3];
        const ny = normals[i * 3 + 1];
        const nz = normals[i * 3 + 2];
        const py = positions[i * 3 + 1];

        // Directional component (normal dot light)
        const dot = nx * dir.x + ny * dir.y + nz * dir.z;
        const directional = intensity * Math.max(0, dot);

        // Height gradient using local floor/ceiling if available
        let heightNorm;
        if (heightMap) {
            const floorY = heightMap[i * 2];
            const ceilY = heightMap[i * 2 + 1];
            const localRange = ceilY - floorY;
            heightNorm = localRange > 10 ? (py - floorY) / localRange : 0.5;
        } else {
            heightNorm = globalYRange > 0 ? (py - globalYMin) / globalYRange : 0.5;
        }
        heightNorm = Math.max(0, Math.min(1, heightNorm));
        const heightFactor = 1.0 - heightFalloff * heightNorm;

        const brightness = Math.min(1, Math.max(0,
            (ambient + directional) * heightFactor
        ));

        colors[i * 3]     = brightness;
        colors[i * 3 + 1] = brightness;
        colors[i * 3 + 2] = brightness;
    }

    return colors;
}

/**
 * Compute error heatmap between predicted and actual vertex colors.
 * Green = low error, Yellow = medium, Red = high.
 * Returns { colors, stats }.
 */
export function computePredictionError(predictedColors, actualColors) {
    const count = predictedColors.length / 3;
    const colors = new Float32Array(count * 3);
    let totalError = 0;
    let within10 = 0;
    let within20 = 0;

    for (let i = 0; i < count; i++) {
        // Compare brightness (average of RGB for actual, predicted is already grayscale)
        const actualBrightness = (actualColors[i * 3] + actualColors[i * 3 + 1] + actualColors[i * 3 + 2]) / 3;
        const predictedBrightness = predictedColors[i * 3];

        const error = Math.abs(predictedBrightness - actualBrightness);
        totalError += error;

        if (error < 0.1) within10++;
        if (error < 0.2) within20++;

        // Green -> Yellow -> Red gradient based on error
        if (error < 0.15) {
            // Green to yellow
            const t = error / 0.15;
            colors[i * 3]     = t;        // R
            colors[i * 3 + 1] = 1;        // G
            colors[i * 3 + 2] = 0;        // B
        } else {
            // Yellow to red
            const t = Math.min(1, (error - 0.15) / 0.25);
            colors[i * 3]     = 1;        // R
            colors[i * 3 + 1] = 1 - t;    // G
            colors[i * 3 + 2] = 0;        // B
        }
    }

    const stats = {
        meanError: totalError / count,
        within10Pct: within10 / count,
        within20Pct: within20 / count,
    };

    return { colors, stats };
}

/**
 * Compute ambient occlusion estimate per vertex via hemisphere raycasting.
 * Returns a Promise since this is expensive and yields periodically.
 * onProgress(fraction) is called during computation.
 */
export async function computeAOEstimate(geometry, mesh, { samples = 16, radius = 500, onProgress = null } = {}) {
    const positions = geometry.getAttribute('position').array;
    const normals = geometry.getAttribute('normal').array;
    const count = positions.length / 3;
    const colors = new Float32Array(count * 3);

    const raycaster = new THREE.Raycaster();
    raycaster.far = radius;
    // Process in face triples (3 vertices per triangle share similar position)
    // but compute per-vertex for accuracy

    const origin = new THREE.Vector3();
    const direction = new THREE.Vector3();
    const normal = new THREE.Vector3();

    // Pre-generate sample directions in hemisphere (tangent space)
    const sampleDirs = generateHemisphereSamples(samples);

    const BATCH_SIZE = 100; // vertices per yield

    for (let i = 0; i < count; i++) {
        origin.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
        normal.set(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);

        // Skip degenerate normals
        if (normal.lengthSq() < 0.01) {
            colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = 0.5;
            continue;
        }
        normal.normalize();

        // Offset origin slightly along normal to avoid self-intersection
        const offsetOrigin = origin.clone().addScaledVector(normal, 2);

        let hits = 0;
        for (let s = 0; s < samples; s++) {
            // Transform hemisphere sample from tangent space to world space
            tangentToWorld(sampleDirs[s], normal, direction);

            raycaster.set(offsetOrigin, direction);
            const intersections = raycaster.intersectObject(mesh, false);
            if (intersections.length > 0) hits++;
        }

        const ao = 1 - (hits / samples);
        colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = ao;

        // Yield to keep UI responsive
        if (i % BATCH_SIZE === 0 && i > 0) {
            if (onProgress) onProgress(i / count);
            await new Promise(r => setTimeout(r, 0));
        }
    }

    if (onProgress) onProgress(1);
    return colors;
}

/**
 * Generate quasi-random hemisphere sample directions (cosine-weighted).
 */
function generateHemisphereSamples(n) {
    const samples = [];
    for (let i = 0; i < n; i++) {
        // Use stratified sampling with golden ratio
        const phi = 2 * Math.PI * ((i * 0.618033988749895) % 1);
        const cosTheta = Math.sqrt(1 - (i + 0.5) / n); // cosine-weighted
        const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);

        samples.push(new THREE.Vector3(
            sinTheta * Math.cos(phi),
            cosTheta, // Y is the hemisphere "up" axis (aligned with normal)
            sinTheta * Math.sin(phi)
        ));
    }
    return samples;
}

/**
 * Transform a direction from tangent space (Y=up=normal) to world space.
 */
function tangentToWorld(sampleDir, normal, outDir) {
    // Build tangent frame from normal
    const up = Math.abs(normal.y) < 0.999
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(1, 0, 0);
    const tangent = new THREE.Vector3().crossVectors(up, normal).normalize();
    const bitangent = new THREE.Vector3().crossVectors(normal, tangent);

    outDir.set(
        sampleDir.x * tangent.x + sampleDir.y * normal.x + sampleDir.z * bitangent.x,
        sampleDir.x * tangent.y + sampleDir.y * normal.y + sampleDir.z * bitangent.y,
        sampleDir.x * tangent.z + sampleDir.y * normal.z + sampleDir.z * bitangent.z
    ).normalize();
}
