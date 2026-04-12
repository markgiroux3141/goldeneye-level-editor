"""
Extract per-vertex features from all 21 GoldenEye OBJ levels.
Saves features + ground truth brightness to a .pt file for training.
"""

import os
import math
import numpy as np
from scipy.spatial import cKDTree
import torch

# Path to level OBJs relative to this script
LEVELS_DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'existing goldeneye levels')
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), 'data')

LEVEL_FOLDERS = [
    '01 - Dam', '02 - Facility', '03 - Runway', '04 - Surface1',
    '05 - Bunker1', '06 - Silo', '07 - Frigate', '08 - Surface2',
    '09 - Bunker2', '10 - Statue', '11 - Archives', '12 - Streets',
    '13 - Depot', '14 - Train', '15 - Jungle', '16 - Control',
    '17 - Caverns', '18 - Cradle', '19 - Aztec', '20 - Egyptian',
    '21 - Complex',
]

OUTDOOR_LEVELS = {
    '01 - Dam', '03 - Runway', '04 - Surface1', '08 - Surface2',
    '15 - Jungle', '18 - Cradle',
}

LOCAL_HEIGHT_RADIUS = 500.0  # XZ radius for local floor/ceiling estimation


def parse_obj(filepath):
    """Parse a GE OBJ file. Returns positions, colors (0-255), and face indices."""
    positions = []
    colors = []
    faces = []

    with open(filepath, 'r') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue

            if line.startswith('v '):
                parts = line.split()
                positions.append([float(parts[1]), float(parts[2]), float(parts[3])])

            elif line.startswith('#vcolor'):
                parts = line.split()
                colors.append([float(parts[1]), float(parts[2]), float(parts[3])])

            elif line.startswith('f '):
                parts = line.split()
                vis = []
                for p in parts[1:]:
                    vi = int(p.split('/')[0]) - 1  # OBJ is 1-based
                    vis.append(vi)
                # Triangulate (handles quads)
                for j in range(1, len(vis) - 1):
                    faces.append([vis[0], vis[j], vis[j + 1]])

    return np.array(positions, dtype=np.float32), np.array(colors, dtype=np.float32), faces


def compute_vertex_normals(positions, faces):
    """Compute per-vertex normals by averaging connected face normals."""
    normals = np.zeros_like(positions)

    for f in faces:
        v0, v1, v2 = positions[f[0]], positions[f[1]], positions[f[2]]
        edge1 = v1 - v0
        edge2 = v2 - v0
        face_normal = np.cross(edge1, edge2)
        norm = np.linalg.norm(face_normal)
        if norm > 1e-8:
            face_normal /= norm
        for vi in f:
            normals[vi] += face_normal

    # Normalize
    norms = np.linalg.norm(normals, axis=1, keepdims=True)
    norms = np.maximum(norms, 1e-8)
    normals /= norms
    return normals


def compute_face_areas(positions, faces):
    """Compute area of each face."""
    areas = []
    for f in faces:
        v0, v1, v2 = positions[f[0]], positions[f[1]], positions[f[2]]
        edge1 = v1 - v0
        edge2 = v2 - v0
        area = 0.5 * np.linalg.norm(np.cross(edge1, edge2))
        areas.append(area)
    return areas


def compute_vertex_features(positions, colors, faces, normals, is_outdoor):
    """
    Compute per-vertex feature vectors.
    Returns features array (N, 10) and labels array (N, 1).
    """
    n_verts = len(positions)

    # --- Build adjacency and per-vertex face info ---
    vert_faces = [[] for _ in range(n_verts)]  # faces per vertex
    neighbors = [set() for _ in range(n_verts)]  # adjacent vertices
    face_areas = compute_face_areas(positions, faces)

    for fi, f in enumerate(faces):
        for vi in f:
            vert_faces[vi].append(fi)
        # Track edge neighbors
        for j in range(3):
            a, b = f[j], f[(j + 1) % 3]
            neighbors[a].add(b)
            neighbors[b].add(a)

    # --- Ground truth brightness ---
    brightness = colors.mean(axis=1) / 255.0  # (N,)

    # --- Local height estimation via KDTree on XZ ---
    xz = positions[:, [0, 2]]  # project to XZ plane
    tree = cKDTree(xz)

    local_floor = np.full(n_verts, positions[:, 1].min())
    local_ceil = np.full(n_verts, positions[:, 1].max())

    # Query neighbors within radius for each vertex
    print(f'    Computing local heights (radius={LOCAL_HEIGHT_RADIUS})...')
    neighbor_lists = tree.query_ball_tree(tree, LOCAL_HEIGHT_RADIUS)

    for i in range(n_verts):
        nbr_indices = neighbor_lists[i]
        if len(nbr_indices) > 1:
            nbr_ys = positions[nbr_indices, 1]
            local_floor[i] = nbr_ys.min()
            local_ceil[i] = nbr_ys.max()

    local_range = local_ceil - local_floor
    local_range = np.maximum(local_range, 10.0)  # avoid div by zero

    # --- Build features ---
    features = np.zeros((n_verts, 10), dtype=np.float32)

    # 0-2: vertex normal
    features[:, 0:3] = normals

    # 3: local height ratio (position within local floor-ceiling)
    features[:, 3] = (positions[:, 1] - local_floor) / local_range

    # 4: normal.y as separate feature (dominant signal)
    features[:, 4] = normals[:, 1]

    # 5: local room height (normalized by global max)
    max_room_height = local_range.max()
    features[:, 5] = local_range / max_room_height if max_room_height > 0 else 0.5

    # 6: vertex density (number of connected faces, normalized)
    face_counts = np.array([len(vf) for vf in vert_faces], dtype=np.float32)
    max_faces = face_counts.max() if face_counts.max() > 0 else 1
    features[:, 6] = face_counts / max_faces

    # 7: mean neighbor brightness
    for i in range(n_verts):
        nbrs = list(neighbors[i])
        if nbrs:
            features[i, 7] = brightness[nbrs].mean()
        else:
            features[i, 7] = brightness[i]

    # 8: level type (0=indoor, 1=outdoor)
    features[:, 8] = 1.0 if is_outdoor else 0.0

    # 9: average face area (log-scaled, normalized)
    avg_areas = np.zeros(n_verts, dtype=np.float32)
    for i in range(n_verts):
        if vert_faces[i]:
            avg_areas[i] = np.mean([face_areas[fi] for fi in vert_faces[i]])
    # Log scale to compress huge range
    avg_areas = np.log1p(avg_areas)
    max_area = avg_areas.max() if avg_areas.max() > 0 else 1
    features[:, 9] = avg_areas / max_area

    labels = brightness.reshape(-1, 1)
    return features, labels


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    all_features = []
    all_labels = []
    all_level_ids = []
    level_names = []

    for level_idx, folder in enumerate(LEVEL_FOLDERS):
        obj_path = os.path.join(LEVELS_DIR, folder, 'LevelIndices.obj')
        if not os.path.exists(obj_path):
            print(f'  SKIP: {folder} (not found)')
            continue

        print(f'[{level_idx + 1}/21] Processing {folder}...')
        positions, colors, faces = parse_obj(obj_path)
        print(f'    {len(positions)} vertices, {len(faces)} faces')

        if len(positions) == 0 or len(colors) == 0:
            print(f'    SKIP: no data')
            continue

        normals = compute_vertex_normals(positions, faces)
        is_outdoor = folder in OUTDOOR_LEVELS

        features, labels = compute_vertex_features(
            positions, colors, faces, normals, is_outdoor
        )

        all_features.append(features)
        all_labels.append(labels)
        all_level_ids.append(np.full(len(positions), level_idx, dtype=np.int64))
        level_names.append(folder)

        print(f'    Features shape: {features.shape}, mean brightness: {labels.mean():.3f}')

    # Concatenate all levels
    features = np.concatenate(all_features, axis=0)
    labels = np.concatenate(all_labels, axis=0)
    level_ids = np.concatenate(all_level_ids, axis=0)

    print(f'\nTotal: {len(features)} vertices from {len(level_names)} levels')

    # Compute normalization stats (per feature mean/std)
    feat_mean = features.mean(axis=0)
    feat_std = features.std(axis=0)
    feat_std[feat_std < 1e-6] = 1.0  # avoid div by zero

    # Save
    output_path = os.path.join(OUTPUT_DIR, 'vertex_data.pt')
    torch.save({
        'features': torch.from_numpy(features),
        'labels': torch.from_numpy(labels),
        'level_ids': torch.from_numpy(level_ids),
        'level_names': level_names,
        'feat_mean': torch.from_numpy(feat_mean),
        'feat_std': torch.from_numpy(feat_std),
    }, output_path)

    print(f'Saved to {output_path}')
    print(f'Feature stats:')
    for i in range(features.shape[1]):
        print(f'  [{i}] mean={feat_mean[i]:.4f}  std={feat_std[i]:.4f}  '
              f'min={features[:, i].min():.4f}  max={features[:, i].max():.4f}')


if __name__ == '__main__':
    main()
