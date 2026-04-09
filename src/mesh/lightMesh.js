// Light mesh lifecycle — visual representation of point lights in the editor.
// Real-time preview (Three.js PointLights + dimmed scene lights) is a manual toggle.

import * as THREE from 'three';
import { state } from '../state.js';
import { WORLD_SCALE } from '../core/constants.js';
import { scene } from '../scene/setup.js';

const S = WORLD_SCALE;

// Light icon mesh storage: Map<lightId, THREE.Group>
export const lightMeshes = new Map();

// Real-time Three.js PointLight storage (only populated when preview is on)
const realtimeLights = new Map();

// Stored scene light intensities for restore
let sceneLightsBackup = null;

function colorToHex(c) {
    return new THREE.Color(c.r, c.g, c.b).getHex();
}

// Build the visual icon for a light (octahedron + core sphere). No PointLight here.
export function rebuildLight(light) {
    const old = lightMeshes.get(light.id);
    if (old) {
        scene.remove(old);
        old.traverse(child => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
    }

    const group = new THREE.Group();
    const hex = colorToHex(light.color);

    const iconGeo = new THREE.OctahedronGeometry(0.5 * S, 0);
    const iconMat = new THREE.MeshBasicMaterial({ color: hex, wireframe: true, depthTest: false });
    const icon = new THREE.Mesh(iconGeo, iconMat);
    icon.renderOrder = 998;
    icon.userData = { lightId: light.id, part: 'icon' };
    group.add(icon);

    const coreGeo = new THREE.SphereGeometry(0.15 * S, 8, 6);
    const coreMat = new THREE.MeshBasicMaterial({ color: hex, depthTest: false });
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.renderOrder = 998;
    core.userData = { lightId: light.id, part: 'core' };
    group.add(core);

    group.position.set(light.x * S, light.y * S, light.z * S);
    group.userData = { lightId: light.id };

    lightMeshes.set(light.id, group);
    scene.add(group);

    // If realtime preview is on, also update/create the PointLight for this light
    if (state.realtimePreview) {
        const oldRT = realtimeLights.get(light.id);
        if (oldRT) scene.remove(oldRT);

        const rtLight = new THREE.PointLight(
            new THREE.Color(light.color.r, light.color.g, light.color.b),
            light.intensity,
            light.range * S,
            2,
        );
        rtLight.position.set(light.x * S, light.y * S, light.z * S);
        realtimeLights.set(light.id, rtLight);
        scene.add(rtLight);
    }
}

export function rebuildAllLights() {
    for (const [, group] of lightMeshes) {
        scene.remove(group);
        group.traverse(child => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
    }
    lightMeshes.clear();

    for (const light of state.pointLights) {
        rebuildLight(light);
    }
}

export function removeLightMesh(lightId) {
    const group = lightMeshes.get(lightId);
    if (group) {
        scene.remove(group);
        group.traverse(child => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
        lightMeshes.delete(lightId);
    }

    const rtLight = realtimeLights.get(lightId);
    if (rtLight) {
        scene.remove(rtLight);
        realtimeLights.delete(lightId);
    }
}

export function updateLightSelection() {}

export function getLightPickTargets() {
    const targets = [];
    for (const [, group] of lightMeshes) {
        for (const child of group.children) {
            if (child.userData.part === 'icon' || child.userData.part === 'core') {
                targets.push(child);
            }
        }
    }
    return targets;
}

// ============================================================
// Realtime preview toggle — manual, no automatic behavior
// ============================================================

export function setRealtimePreview(enabled) {
    state.realtimePreview = enabled;

    if (enabled) {
        // Create PointLights for all lights
        for (const light of state.pointLights) {
            const rtLight = new THREE.PointLight(
                new THREE.Color(light.color.r, light.color.g, light.color.b),
                light.intensity,
                light.range * S,
                2,
            );
            rtLight.position.set(light.x * S, light.y * S, light.z * S);
            realtimeLights.set(light.id, rtLight);
            scene.add(rtLight);
        }

        // Dim scene lights
        const sceneLights = scene.children.filter(c =>
            c.isAmbientLight || c.isDirectionalLight || c.isHemisphereLight
        );
        sceneLightsBackup = sceneLights.map(l => ({ light: l, intensity: l.intensity }));
        for (const entry of sceneLightsBackup) {
            if (entry.light.isAmbientLight) {
                entry.light.intensity = 0.08;
            } else {
                entry.light.intensity = 0;
            }
        }
    } else {
        // Remove all PointLights
        for (const [, rtLight] of realtimeLights) {
            scene.remove(rtLight);
        }
        realtimeLights.clear();

        // Restore scene lights
        if (sceneLightsBackup) {
            for (const entry of sceneLightsBackup) {
                entry.light.intensity = entry.intensity;
            }
            sceneLightsBackup = null;
        }
    }
}
