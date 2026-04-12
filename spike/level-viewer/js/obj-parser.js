// Custom OBJ + MTL parser that extracts #vcolor vertex color data
// and tracks per-material face groups for textured rendering.
// Standard Three.js OBJLoader ignores #vcolor comment lines.

import * as THREE from 'three';

/**
 * Parse a .mtl file.
 * Returns a Map of materialName -> { texture, transparent, clampS, clampT, doubleSided }
 */
export function parseMTL(text) {
    const materials = new Map();
    let current = null;

    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line.startsWith('newmtl ')) {
            const name = line.substring(7).trim();
            current = {
                texture: null,
                transparent: name.includes('Transparent'),
                clampS: name.includes('ClampS'),
                clampT: name.includes('ClampT'),
                doubleSided: name.includes('CullBoth'),
            };
            materials.set(name, current);
        } else if (line.startsWith('map_Kd ') && current) {
            current.texture = line.substring(7).trim();
        }
    }

    return materials;
}

/**
 * Parse a GoldenEye Setup Editor OBJ file.
 * Returns { geometry, materialGroups } where materialGroups is an array of
 * { name, start, count } describing which faces use which material.
 */
export function parseOBJ(text) {
    const positions = [];   // flat: x,y,z, ...
    const uvs = [];         // flat: u,v, ...
    const colors = [];      // flat: r,g,b, ... (normalized 0-1)

    // Faces grouped by material+group combo
    let currentMtl = 'default';
    let currentGroup = '';
    let isSecondary = false;
    // Key = "mtlName|secondary" or "mtlName|primary", value = {faces, name, secondary}
    const faceGroups = [];

    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.length === 0) continue;

        const first = line[0];

        if (first === 'v') {
            if (line[1] === 't') {
                const parts = line.split(/\s+/);
                uvs.push(parseFloat(parts[1]), parseFloat(parts[2]));
            } else if (line[1] === 'n') {
                // skip - all zeros, we compute normals later
            } else if (line[1] === ' ' || line[1] === '\t') {
                const parts = line.split(/\s+/);
                positions.push(
                    parseFloat(parts[1]),
                    parseFloat(parts[2]),
                    parseFloat(parts[3])
                );
            }
        } else if (first === '#') {
            if (line.startsWith('#vcolor')) {
                const parts = line.split(/\s+/);
                colors.push(
                    parseFloat(parts[1]) / 255,
                    parseFloat(parts[2]) / 255,
                    parseFloat(parts[3]) / 255
                );
            }
        } else if (first === 'g') {
            currentGroup = line.substring(2).trim();
            isSecondary = currentGroup.startsWith('secondary');
        } else if (first === 'u' && line.startsWith('usemtl ')) {
            currentMtl = line.substring(7).trim();
            // Start a new face group for this material+secondary combo
            faceGroups.push({ name: currentMtl, secondary: isSecondary, faces: [] });
        } else if (first === 'f') {
            const parts = line.split(/\s+/);
            const verts = [];
            for (let j = 1; j < parts.length; j++) {
                const indices = parts[j].split('/');
                verts.push({
                    v: parseInt(indices[0]) - 1,
                    vt: parseInt(indices[1]) - 1
                });
            }
            if (faceGroups.length === 0) {
                faceGroups.push({ name: currentMtl, secondary: isSecondary, faces: [] });
            }
            const bucket = faceGroups[faceGroups.length - 1].faces;
            // Triangulate
            for (let j = 1; j < verts.length - 1; j++) {
                bucket.push(verts[0], verts[j], verts[j + 1]);
            }
        }
    }

    // Flatten all face groups into one geometry with groups
    const materialGroups = [];  // { name, secondary, start, count }
    const allFaces = [];

    for (const fg of faceGroups) {
        if (fg.faces.length === 0) continue;
        const start = allFaces.length;
        for (const f of fg.faces) allFaces.push(f);
        materialGroups.push({ name: fg.name, secondary: fg.secondary, start, count: fg.faces.length });
    }

    // Expand into non-indexed arrays
    const vertCount = allFaces.length;
    const posArr = new Float32Array(vertCount * 3);
    const uvArr = new Float32Array(vertCount * 2);
    const colArr = new Float32Array(vertCount * 3);

    const hasColors = colors.length > 0;

    for (let i = 0; i < allFaces.length; i++) {
        const f = allFaces[i];

        const pi = f.v * 3;
        posArr[i * 3]     = positions[pi];
        posArr[i * 3 + 1] = positions[pi + 1];
        posArr[i * 3 + 2] = positions[pi + 2];

        const ti = f.vt * 2;
        uvArr[i * 2]     = uvs[ti];
        uvArr[i * 2 + 1] = uvs[ti + 1];

        if (hasColors) {
            const ci = f.v * 3;
            colArr[i * 3]     = colors[ci];
            colArr[i * 3 + 1] = colors[ci + 1];
            colArr[i * 3 + 2] = colors[ci + 2];
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
    geometry.setAttribute('color', new THREE.BufferAttribute(colArr, 3));

    // Register geometry groups for multi-material rendering
    for (const g of materialGroups) {
        geometry.addGroup(g.start, g.count, 0); // materialIndex set later
    }

    // All normals in GE OBJs are 0,0,0 - compute real ones
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();

    return { geometry, materialGroups };
}
