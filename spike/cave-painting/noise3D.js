// 3D Perlin noise + FBM. Ported from src/terrain/noise.js (2D version).
// Returns values in roughly [-1, 1].

const PERM = new Uint8Array(512);

// Standard Perlin '02 gradient directions (edges of a cube).
const GRAD3 = [
    [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
    [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
    [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

export function seedNoise3D(seed = 0) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    let s = seed;
    for (let i = 255; i > 0; i--) {
        s = (s * 1664525 + 1013904223) & 0xffffffff;
        const j = ((s >>> 0) % (i + 1));
        [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}

seedNoise3D(1337);

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function lerp(a, b, t) { return a + t * (b - a); }

function grad3(hash, x, y, z) {
    const g = GRAD3[hash % 12];
    return g[0] * x + g[1] * y + g[2] * z;
}

export function noise3D(x, y, z) {
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const zi = Math.floor(z) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const zf = z - Math.floor(z);

    const u = fade(xf);
    const v = fade(yf);
    const w = fade(zf);

    const A  = PERM[xi    ] + yi;
    const AA = PERM[A    ] + zi;
    const AB = PERM[A + 1] + zi;
    const B  = PERM[xi + 1] + yi;
    const BA = PERM[B    ] + zi;
    const BB = PERM[B + 1] + zi;

    return lerp(
        lerp(
            lerp(grad3(PERM[AA    ], xf    , yf    , zf    ),
                 grad3(PERM[BA    ], xf - 1, yf    , zf    ), u),
            lerp(grad3(PERM[AB    ], xf    , yf - 1, zf    ),
                 grad3(PERM[BB    ], xf - 1, yf - 1, zf    ), u),
            v),
        lerp(
            lerp(grad3(PERM[AA + 1], xf    , yf    , zf - 1),
                 grad3(PERM[BA + 1], xf - 1, yf    , zf - 1), u),
            lerp(grad3(PERM[AB + 1], xf    , yf - 1, zf - 1),
                 grad3(PERM[BB + 1], xf - 1, yf - 1, zf - 1), u),
            v),
        w);
}

export function fbm3D(x, y, z, octaves = 4, lacunarity = 2, gain = 0.5) {
    let value = 0;
    let amplitude = 1;
    let frequency = 1;
    let maxAmplitude = 0;
    for (let i = 0; i < octaves; i++) {
        value += amplitude * noise3D(x * frequency, y * frequency, z * frequency);
        maxAmplitude += amplitude;
        amplitude *= gain;
        frequency *= lacunarity;
    }
    return value / maxAmplitude;
}
