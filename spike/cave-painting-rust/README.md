# Cave Painting — Rust/WASM

Sibling of [../cave-painting/](../cave-painting/). Identical gameplay; density field, Perlin/FBM noise, all five brushes, and marching cubes run in Rust/WASM.

## Build

Prerequisite: `wasm-pack`. Check with:

```bash
wasm-pack --version
# if missing: cargo install wasm-pack  (requires a rust toolchain)
```

Build the crate:

```bash
cd cave-wasm && wasm-pack build --target web --out-dir pkg --release
```

Output goes to `cave-wasm/pkg/` (`cave_wasm.js` + `cave_wasm_bg.wasm`).

## Run

From the repo root:

```bash
python dev-server.py 8765
# http://localhost:8765/spike/cave-painting-rust/index.html
```

Side-by-side comparison: open [http://localhost:8765/spike/cave-painting/](http://localhost:8765/spike/cave-painting/) in another tab. Seed 1337 and brush algorithms are identical, so both should render the same cavity silhouette and carve identically.

Success criterion: HUD `Remesh: N chk / X.Xms` drops to roughly ¼–⅓ of the JS spike's value for the same stroke at the same radius.
