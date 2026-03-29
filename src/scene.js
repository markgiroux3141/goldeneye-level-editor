// Three.js scene, renderer, camera, lighting

import * as THREE from 'three';

export let scene, renderer, camera;

export function initScene() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e);
    scene.fog = new THREE.Fog(0x1a1a2e, 30, 80);

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 200);
    camera.position.set(2, 1.5, 2);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    document.body.appendChild(renderer.domElement);

    // Lighting
    scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(10, 20, 10);
    scene.add(dirLight);
    scene.add(new THREE.HemisphereLight(0x8888ff, 0x444422, 0.3));

    // Ground grid — 1 line per WT (0.25m spacing)
    const grid = new THREE.GridHelper(100, 400, 0x004400, 0x002200);
    grid.position.y = -0.01;
    scene.add(grid);

    // Resize
    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    return { scene, renderer, camera };
}
