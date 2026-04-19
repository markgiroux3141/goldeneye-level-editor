// 3D Perlin noise + FBM. Exact port of spike/cave-painting/noise3D.js.
// The LCG and Fisher-Yates below MUST produce the same PERM as the JS seed
// path, so fbm3d values match the JS original bit-for-bit at seed 1337.

const GRAD3: [[f32; 3]; 12] = [
    [ 1.0,  1.0,  0.0], [-1.0,  1.0,  0.0], [ 1.0, -1.0,  0.0], [-1.0, -1.0,  0.0],
    [ 1.0,  0.0,  1.0], [-1.0,  0.0,  1.0], [ 1.0,  0.0, -1.0], [-1.0,  0.0, -1.0],
    [ 0.0,  1.0,  1.0], [ 0.0, -1.0,  1.0], [ 0.0,  1.0, -1.0], [ 0.0, -1.0, -1.0],
];

static mut PERM: [u8; 512] = [0u8; 512];

pub fn init_perm(seed: u32) {
    let mut p = [0u8; 256];
    for i in 0..256 {
        p[i] = i as u8;
    }
    let mut s: u32 = seed;
    for i in (1..=255usize).rev() {
        s = s.wrapping_mul(1664525).wrapping_add(1013904223);
        let j = (s % (i as u32 + 1)) as usize;
        p.swap(i, j);
    }
    unsafe {
        for i in 0..512 {
            PERM[i] = p[i & 255];
        }
    }
}

#[inline(always)]
fn perm(i: usize) -> u8 {
    unsafe { PERM[i] }
}

#[inline(always)]
fn fade(t: f32) -> f32 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

#[inline(always)]
fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + t * (b - a)
}

#[inline(always)]
fn grad3(hash: u8, x: f32, y: f32, z: f32) -> f32 {
    let g = &GRAD3[(hash as usize) % 12];
    g[0] * x + g[1] * y + g[2] * z
}

pub fn noise3d(x: f32, y: f32, z: f32) -> f32 {
    let xfloor = x.floor();
    let yfloor = y.floor();
    let zfloor = z.floor();
    let xi = (xfloor as i32 & 255) as usize;
    let yi = (yfloor as i32 & 255) as usize;
    let zi = (zfloor as i32 & 255) as usize;
    let xf = x - xfloor;
    let yf = y - yfloor;
    let zf = z - zfloor;

    let u = fade(xf);
    let v = fade(yf);
    let w = fade(zf);

    let a  = perm(xi    ) as usize + yi;
    let aa = perm(a    ) as usize + zi;
    let ab = perm(a + 1) as usize + zi;
    let b  = perm(xi + 1) as usize + yi;
    let ba = perm(b    ) as usize + zi;
    let bb = perm(b + 1) as usize + zi;

    lerp(
        lerp(
            lerp(grad3(perm(aa    ), xf      , yf      , zf      ),
                 grad3(perm(ba    ), xf - 1.0, yf      , zf      ), u),
            lerp(grad3(perm(ab    ), xf      , yf - 1.0, zf      ),
                 grad3(perm(bb    ), xf - 1.0, yf - 1.0, zf      ), u),
            v),
        lerp(
            lerp(grad3(perm(aa + 1), xf      , yf      , zf - 1.0),
                 grad3(perm(ba + 1), xf - 1.0, yf      , zf - 1.0), u),
            lerp(grad3(perm(ab + 1), xf      , yf - 1.0, zf - 1.0),
                 grad3(perm(bb + 1), xf - 1.0, yf - 1.0, zf - 1.0), u),
            v),
        w)
}

pub fn fbm3d(x: f32, y: f32, z: f32, octaves: u32) -> f32 {
    let lacunarity = 2.0;
    let gain = 0.5;
    let mut value = 0.0;
    let mut amplitude = 1.0;
    let mut frequency = 1.0;
    let mut max_amplitude = 0.0;
    for _ in 0..octaves {
        value += amplitude * noise3d(x * frequency, y * frequency, z * frequency);
        max_amplitude += amplitude;
        amplitude *= gain;
        frequency *= lacunarity;
    }
    value / max_amplitude
}
