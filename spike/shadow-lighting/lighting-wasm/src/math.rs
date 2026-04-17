// Lightweight 3D math primitives.

#[derive(Copy, Clone, Debug, Default)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Vec3 {
    pub const fn new(x: f32, y: f32, z: f32) -> Self { Vec3 { x, y, z } }

    pub fn sub(self, o: Vec3) -> Vec3 { Vec3::new(self.x - o.x, self.y - o.y, self.z - o.z) }
    pub fn add(self, o: Vec3) -> Vec3 { Vec3::new(self.x + o.x, self.y + o.y, self.z + o.z) }
    pub fn scale(self, s: f32) -> Vec3 { Vec3::new(self.x * s, self.y * s, self.z * s) }
    pub fn dot(self, o: Vec3) -> f32 { self.x * o.x + self.y * o.y + self.z * o.z }
    pub fn cross(self, o: Vec3) -> Vec3 {
        Vec3::new(
            self.y * o.z - self.z * o.y,
            self.z * o.x - self.x * o.z,
            self.x * o.y - self.y * o.x,
        )
    }
    pub fn length(self) -> f32 { self.dot(self).sqrt() }
    pub fn normalize(self) -> Vec3 {
        let l = self.length();
        if l > 1e-12 { self.scale(1.0 / l) } else { self }
    }
    pub fn axis(self, a: usize) -> f32 {
        match a { 0 => self.x, 1 => self.y, _ => self.z }
    }
    pub fn min_each(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x.min(o.x), self.y.min(o.y), self.z.min(o.z))
    }
    pub fn max_each(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x.max(o.x), self.y.max(o.y), self.z.max(o.z))
    }
}

#[derive(Copy, Clone, Debug)]
pub struct Aabb { pub min: Vec3, pub max: Vec3 }

impl Aabb {
    pub fn empty() -> Self {
        Aabb {
            min: Vec3::new(f32::INFINITY, f32::INFINITY, f32::INFINITY),
            max: Vec3::new(f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY),
        }
    }
    pub fn from_tri(a: Vec3, b: Vec3, c: Vec3) -> Self {
        Aabb { min: a.min_each(b).min_each(c), max: a.max_each(b).max_each(c) }
    }
    pub fn union(self, o: Aabb) -> Aabb {
        Aabb { min: self.min.min_each(o.min), max: self.max.max_each(o.max) }
    }
    pub fn centroid_axis(&self, a: usize) -> f32 {
        0.5 * (self.min.axis(a) + self.max.axis(a))
    }
    pub fn longest_axis(&self) -> usize {
        let d = Vec3::new(self.max.x - self.min.x, self.max.y - self.min.y, self.max.z - self.min.z);
        if d.x >= d.y && d.x >= d.z { 0 } else if d.y >= d.z { 1 } else { 2 }
    }
    /// Slab test for ray-aabb
    pub fn ray_hit(&self, origin: Vec3, inv_dir: Vec3, tmax: f32) -> bool {
        let mut tmin = 0.0f32;
        let mut tmax = tmax;
        for a in 0..3 {
            let o = origin.axis(a);
            let invd = inv_dir.axis(a);
            let mn = self.min.axis(a);
            let mx = self.max.axis(a);
            let t1 = (mn - o) * invd;
            let t2 = (mx - o) * invd;
            let (tlo, thi) = if t1 < t2 { (t1, t2) } else { (t2, t1) };
            tmin = tmin.max(tlo);
            tmax = tmax.min(thi);
            if tmax < tmin { return false; }
        }
        true
    }
}

#[derive(Copy, Clone, Debug)]
pub struct Triangle { pub a: Vec3, pub b: Vec3, pub c: Vec3 }

impl Triangle {
    pub fn aabb(&self) -> Aabb { Aabb::from_tri(self.a, self.b, self.c) }
    pub fn centroid(&self) -> Vec3 {
        self.a.add(self.b).add(self.c).scale(1.0 / 3.0)
    }
}
