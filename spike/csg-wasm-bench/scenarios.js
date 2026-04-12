// ─── Benchmark Scenarios ─────────────────────────────────────────────
// Each scenario defines a shell + array of brushes to evaluate.
// Brushes use WT-space integers: { op, x, y, z, w, h, d, taper?, ... }
// Scenarios range from trivial (1 brush) to stress-test (many brushes).

export const scenarios = [

    // ── 1. Single Room ─────────────────────────────────────────────
    {
        name: 'Single Room',
        description: '1 subtractive brush — baseline measurement',
        shell: { x: -1, y: -1, z: -1, w: 14, h: 10, d: 14 },
        brushes: [
            { op: 'subtract', x: 0, y: 0, z: 0, w: 12, h: 8, d: 12 },
        ],
    },

    // ── 2. Two Connected Rooms ─────────────────────────────────────
    {
        name: 'Two Rooms + Doorway',
        description: '2 rooms joined by a doorway cut — 4 brushes',
        shell: { x: -1, y: -1, z: -1, w: 28, h: 10, d: 14 },
        brushes: [
            { op: 'subtract', x: 0, y: 0, z: 0, w: 12, h: 8, d: 12 },
            { op: 'subtract', x: 14, y: 0, z: 0, w: 12, h: 8, d: 12 },
            // Doorway connecting them
            { op: 'subtract', x: 12, y: 0, z: 4, w: 2, h: 7, d: 4 },
            // Door frame (additive, creates the frame border)
            { op: 'add', x: 11, y: 0, z: 3, w: 4, h: 8, d: 6, isDoorframe: true },
        ],
    },

    // ── 3. L-shaped Corridor ───────────────────────────────────────
    {
        name: 'L-shaped Corridor',
        description: '3 rooms in an L shape with 2 corridors — 7 brushes',
        shell: { x: -1, y: -1, z: -1, w: 28, h: 10, d: 28 },
        brushes: [
            // Room A (bottom-left)
            { op: 'subtract', x: 0, y: 0, z: 0, w: 10, h: 8, d: 10 },
            // Room B (bottom-right)
            { op: 'subtract', x: 16, y: 0, z: 0, w: 10, h: 8, d: 10 },
            // Room C (top-right)
            { op: 'subtract', x: 16, y: 0, z: 16, w: 10, h: 8, d: 10 },
            // Corridor A→B
            { op: 'subtract', x: 10, y: 0, z: 3, w: 6, h: 7, d: 4 },
            // Corridor B→C
            { op: 'subtract', x: 19, y: 0, z: 10, w: 4, h: 7, d: 6 },
            // Door frame A→B
            { op: 'add', x: 9, y: 0, z: 2, w: 2, h: 8, d: 6, isDoorframe: true },
            // Door frame B→C
            { op: 'add', x: 18, y: 0, z: 9, w: 6, h: 8, d: 2, isDoorframe: true },
        ],
    },

    // ── 4. Staircase (consecutive subtracts) ───────────────────────
    {
        name: 'Staircase (10 steps)',
        description: '10 consecutive subtractive steps — tests pre-merge optimization',
        shell: { x: -1, y: -1, z: -1, w: 14, h: 18, d: 22 },
        brushes: (() => {
            const steps = [];
            const stepW = 8, stepD = 2, stepH = 1;
            for (let i = 0; i < 10; i++) {
                steps.push({
                    op: 'subtract',
                    x: 2, y: i * stepH, z: 2 + i * stepD,
                    w: stepW, h: 8 - i * stepH, d: stepD,
                });
            }
            // Room at bottom
            steps.unshift({ op: 'subtract', x: 0, y: 0, z: 0, w: 12, h: 8, d: 2 });
            return steps;
        })(),
    },

    // ── 5. Tapered Room ────────────────────────────────────────────
    {
        name: 'Tapered Brushes',
        description: 'Room with tapered ceiling and alcove — tests non-axis-aligned faces',
        shell: { x: -1, y: -1, z: -1, w: 16, h: 12, d: 16 },
        brushes: [
            // Main room
            { op: 'subtract', x: 0, y: 0, z: 0, w: 14, h: 10, d: 14 },
            // Tapered ceiling niche
            {
                op: 'subtract', x: 4, y: 8, z: 4, w: 6, h: 3, d: 6,
                taper: { 'y-max': { u: 2, v: 2 } },
            },
            // Tapered wall alcove
            {
                op: 'subtract', x: 0, y: 2, z: 4, w: 3, h: 5, d: 6,
                taper: { 'x-min': { u: 1, v: 1 } },
            },
        ],
    },

    // ── 6. Multi-room Complex ──────────────────────────────────────
    {
        name: 'Multi-room Complex',
        description: '6 rooms, 5 corridors, 2 holes — 18 brushes',
        shell: { x: -1, y: -1, z: -1, w: 42, h: 10, d: 42 },
        brushes: [
            // Grid of 6 rooms (2×3)
            { op: 'subtract', x: 0, y: 0, z: 0, w: 10, h: 8, d: 10 },
            { op: 'subtract', x: 14, y: 0, z: 0, w: 10, h: 8, d: 10 },
            { op: 'subtract', x: 28, y: 0, z: 0, w: 12, h: 8, d: 10 },
            { op: 'subtract', x: 0, y: 0, z: 14, w: 10, h: 8, d: 12 },
            { op: 'subtract', x: 14, y: 0, z: 14, w: 10, h: 8, d: 12 },
            { op: 'subtract', x: 28, y: 0, z: 14, w: 12, h: 8, d: 12 },
            // Horizontal corridors (row 1)
            { op: 'subtract', x: 10, y: 0, z: 3, w: 4, h: 7, d: 4 },
            { op: 'subtract', x: 24, y: 0, z: 3, w: 4, h: 7, d: 4 },
            // Horizontal corridors (row 2)
            { op: 'subtract', x: 10, y: 0, z: 17, w: 4, h: 7, d: 4 },
            { op: 'subtract', x: 24, y: 0, z: 17, w: 4, h: 7, d: 4 },
            // Vertical corridor connecting row 1 and row 2 (middle column)
            { op: 'subtract', x: 17, y: 0, z: 10, w: 4, h: 7, d: 4 },
            // Door frames on some corridors
            { op: 'add', x: 9, y: 0, z: 2, w: 2, h: 8, d: 6, isDoorframe: true },
            { op: 'add', x: 23, y: 0, z: 2, w: 2, h: 8, d: 6, isDoorframe: true },
            { op: 'add', x: 9, y: 0, z: 16, w: 2, h: 8, d: 6, isDoorframe: true },
            // Holes (windows) in outer walls
            { op: 'subtract', x: -1, y: 3, z: 3, w: 2, h: 3, d: 4 },
            { op: 'add', x: -2, y: 2, z: 2, w: 3, h: 5, d: 6, isHoleFrame: true },
            { op: 'subtract', x: 39, y: 3, z: 17, w: 2, h: 3, d: 4 },
            { op: 'add', x: 38, y: 2, z: 16, w: 3, h: 5, d: 6, isHoleFrame: true },
        ],
    },

    // ── 7. Stress Test ─────────────────────────────────────────────
    {
        name: 'Stress Test (30 brushes)',
        description: 'Large room with many alcoves and features — 30 brushes',
        shell: { x: -1, y: -1, z: -1, w: 34, h: 14, d: 34 },
        brushes: (() => {
            const b = [];
            // Central large room
            b.push({ op: 'subtract', x: 0, y: 0, z: 0, w: 32, h: 12, d: 32 });
            // Ring of alcoves along walls
            for (let i = 0; i < 6; i++) {
                // Z-min wall alcoves
                b.push({ op: 'subtract', x: 2 + i * 5, y: 2, z: -1, w: 3, h: 5, d: 2 });
                // Z-max wall alcoves
                b.push({ op: 'subtract', x: 2 + i * 5, y: 2, z: 31, w: 3, h: 5, d: 2 });
            }
            // Pillars (additive inside the room)
            for (let px = 0; px < 3; px++) {
                for (let pz = 0; pz < 3; pz++) {
                    b.push({
                        op: 'add',
                        x: 6 + px * 10, y: 0, z: 6 + pz * 10,
                        w: 2, h: 12, d: 2,
                    });
                }
            }
            // Ceiling recesses
            b.push({
                op: 'subtract', x: 8, y: 10, z: 8, w: 16, h: 3, d: 16,
                taper: { 'y-max': { u: 3, v: 3 } },
            });
            return b;
        })(),
    },

    // ── 8. Facility Wing ──────────────────────────────────────────
    {
        name: 'Facility Wing (60 brushes)',
        description: '8 rooms along a corridor with alcoves, doors, and pillars',
        shell: { x: -1, y: -1, z: -1, w: 82, h: 12, d: 30 },
        brushes: (() => {
            const b = [];
            // Main corridor
            b.push({ op: 'subtract', x: 0, y: 0, z: 10, w: 80, h: 8, d: 8 });
            // 8 rooms branching off the corridor (4 per side)
            for (let i = 0; i < 8; i++) {
                const rx = 2 + i * 10;
                const rz = i % 2 === 0 ? -1 : 19;
                const roomW = 8, roomH = 8, roomD = 10;
                b.push({ op: 'subtract', x: rx, y: 0, z: rz, w: roomW, h: roomH, d: roomD });
                // Doorway into corridor
                const dz = i % 2 === 0 ? 9 : 18;
                b.push({ op: 'subtract', x: rx + 2, y: 0, z: dz, w: 4, h: 7, d: 2 });
                // Door frame
                b.push({ op: 'add', x: rx + 1, y: 0, z: dz - 1, w: 6, h: 8, d: 4, isDoorframe: true });
                // Alcove in each room
                const az = i % 2 === 0 ? rz : rz + roomD - 1;
                b.push({ op: 'subtract', x: rx + 2, y: 2, z: az, w: 4, h: 4, d: 2 });
                // Pillar in each room
                b.push({ op: 'add', x: rx + 3, y: 0, z: rz + 4, w: 2, h: roomH, d: 2 });
            }
            // Windows along corridor walls (both sides)
            for (let i = 0; i < 5; i++) {
                b.push({ op: 'subtract', x: 5 + i * 16, y: 4, z: 9, w: 4, h: 3, d: 2 });
                b.push({ op: 'add', x: 4 + i * 16, y: 3, z: 8, w: 6, h: 5, d: 3, isHoleFrame: true });
            }
            return b;
        })(),
    },

    // ── 9. Dungeon Grid (100 brushes) ─────────────────────────────
    {
        name: 'Dungeon Grid (100 brushes)',
        description: '4x4 grid of rooms with corridors, features in every room',
        shell: { x: -1, y: -1, z: -1, w: 62, h: 12, d: 62 },
        brushes: (() => {
            const b = [];
            const roomSize = 10;
            const gap = 5; // corridor length between rooms
            const stride = roomSize + gap;

            // 4x4 rooms
            for (let gx = 0; gx < 4; gx++) {
                for (let gz = 0; gz < 4; gz++) {
                    const rx = gx * stride;
                    const rz = gz * stride;
                    b.push({ op: 'subtract', x: rx, y: 0, z: rz, w: roomSize, h: 8, d: roomSize });

                    // Horizontal corridor (connect to next room in X)
                    if (gx < 3) {
                        b.push({ op: 'subtract', x: rx + roomSize, y: 0, z: rz + 3, w: gap, h: 7, d: 4 });
                    }
                    // Vertical corridor (connect to next room in Z)
                    if (gz < 3) {
                        b.push({ op: 'subtract', x: rx + 3, y: 0, z: rz + roomSize, w: 4, h: 7, d: gap });
                    }

                    // Feature per room: alternating pillar vs alcove
                    if ((gx + gz) % 2 === 0) {
                        // Center pillar
                        b.push({ op: 'add', x: rx + 4, y: 0, z: rz + 4, w: 2, h: 8, d: 2 });
                    } else {
                        // Wall alcove
                        b.push({ op: 'subtract', x: rx, y: 2, z: rz + 3, w: 1, h: 4, d: 4 });
                    }
                }
            }
            return b;
        })(),
    },

    // ── 10. Cathedral (150 brushes) ───────────────────────────────
    {
        name: 'Cathedral (150 brushes)',
        description: 'Massive hall with nave, aisles, side chapels, pillars, and vaulted ceiling cuts',
        shell: { x: -1, y: -1, z: -1, w: 62, h: 22, d: 102 },
        brushes: (() => {
            const b = [];
            // Main nave (central hall)
            b.push({ op: 'subtract', x: 16, y: 0, z: 0, w: 28, h: 18, d: 100 });
            // Left aisle
            b.push({ op: 'subtract', x: 2, y: 0, z: 0, w: 12, h: 12, d: 100 });
            // Right aisle
            b.push({ op: 'subtract', x: 46, y: 0, z: 0, w: 12, h: 12, d: 100 });

            // Row of pillars on each side of nave (20 per side)
            for (let i = 0; i < 20; i++) {
                const pz = 2 + i * 5;
                // Left pillar row
                b.push({ op: 'add', x: 14, y: 0, z: pz, w: 3, h: 18, d: 2 });
                // Right pillar row
                b.push({ op: 'add', x: 43, y: 0, z: pz, w: 3, h: 18, d: 2 });
            }

            // Side chapels (10 on each side, branching off aisles)
            for (let i = 0; i < 10; i++) {
                const cz = 2 + i * 10;
                // Left chapel
                b.push({ op: 'subtract', x: -1, y: 0, z: cz, w: 4, h: 10, d: 6 });
                b.push({ op: 'add', x: -2, y: 0, z: cz - 1, w: 5, h: 11, d: 8, isDoorframe: true });
                // Right chapel
                b.push({ op: 'subtract', x: 57, y: 0, z: cz, w: 4, h: 10, d: 6 });
                b.push({ op: 'add', x: 56, y: 0, z: cz - 1, w: 5, h: 11, d: 8, isDoorframe: true });
            }

            // Transept (cross-arm near the far end)
            b.push({ op: 'subtract', x: -1, y: 0, z: 80, w: 62, h: 16, d: 12 });

            // Apse (semicircular end — approximated with tapered box)
            b.push({
                op: 'subtract', x: 18, y: 0, z: 92, w: 24, h: 16, d: 8,
                taper: { 'z-max': { u: 6, v: 0 } },
            });

            // Clerestory windows (upper nave, both sides)
            for (let i = 0; i < 12; i++) {
                const wz = 3 + i * 8;
                b.push({ op: 'subtract', x: 15, y: 10, z: wz, w: 2, h: 5, d: 4 });
                b.push({ op: 'subtract', x: 43, y: 10, z: wz, w: 2, h: 5, d: 4 });
            }

            // Vaulted ceiling ribs (additive, crossing the nave)
            for (let i = 0; i < 10; i++) {
                const rz = 5 + i * 10;
                b.push({ op: 'add', x: 16, y: 16, z: rz, w: 28, h: 2, d: 1 });
            }

            return b;
        })(),
    },

    // ── 11. Mega Complex (250 brushes) ────────────────────────────
    {
        name: 'Mega Complex (250 brushes)',
        description: '6x6 room grid, every room with pillars, alcoves, doors, and corridors',
        shell: { x: -1, y: -1, z: -1, w: 92, h: 12, d: 92 },
        brushes: (() => {
            const b = [];
            const roomW = 10, roomD = 10, roomH = 8;
            const gap = 5;
            const stride = roomW + gap;

            for (let gx = 0; gx < 6; gx++) {
                for (let gz = 0; gz < 6; gz++) {
                    const rx = gx * stride;
                    const rz = gz * stride;

                    // Room
                    b.push({ op: 'subtract', x: rx, y: 0, z: rz, w: roomW, h: roomH, d: roomD });

                    // Corridor to right neighbor
                    if (gx < 5) {
                        b.push({ op: 'subtract', x: rx + roomW, y: 0, z: rz + 3, w: gap, h: 7, d: 4 });
                        b.push({ op: 'add', x: rx + roomW - 1, y: 0, z: rz + 2, w: 2, h: 8, d: 6, isDoorframe: true });
                    }
                    // Corridor to front neighbor
                    if (gz < 5) {
                        b.push({ op: 'subtract', x: rx + 3, y: 0, z: rz + roomD, w: 4, h: 7, d: gap });
                        b.push({ op: 'add', x: rx + 2, y: 0, z: rz + roomD - 1, w: 6, h: 8, d: 2, isDoorframe: true });
                    }

                    // Corner pillar in every room
                    b.push({ op: 'add', x: rx + 1, y: 0, z: rz + 1, w: 2, h: roomH, d: 2 });

                    // Wall alcove
                    b.push({ op: 'subtract', x: rx + roomW - 1, y: 2, z: rz + 3, w: 2, h: 4, d: 4 });
                }
            }
            return b;
        })(),
    },
];
