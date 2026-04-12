"""
Evaluate trained VertexColorNet on all 21 levels.
Compare neural net vs formula baseline per-level.
Compute feature importance via gradient-based analysis.
"""

import os
import torch
import torch.nn as nn
from model import VertexColorNet

DATA_PATH = os.path.join(os.path.dirname(__file__), 'data', 'vertex_data.pt')
CHECKPOINT_PATH = os.path.join(os.path.dirname(__file__), 'checkpoints', 'best_model.pt')


def formula_predict(features):
    """Simple formula baseline: ambient + intensity * max(0, normal.y)"""
    normal_y = features[:, 4]  # raw (un-normalized) normal.y
    return (0.3 + 0.7 * torch.clamp(normal_y, min=0)).unsqueeze(1)


def main():
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    print(f'Device: {device}')

    # --- Load data ---
    data = torch.load(DATA_PATH, weights_only=False)
    raw_features = data['features']
    labels = data['labels']
    level_ids = data['level_ids']
    level_names = data['level_names']
    feat_mean = data['feat_mean']
    feat_std = data['feat_std']

    # Normalize
    norm_features = (raw_features - feat_mean) / feat_std

    # --- Load model ---
    checkpoint = torch.load(CHECKPOINT_PATH, weights_only=False)
    model = VertexColorNet(in_features=checkpoint['in_features']).to(device)
    model.load_state_dict(checkpoint['model_state'])
    model.eval()
    print(f'Loaded model from epoch {checkpoint["epoch"]} (val MSE: {checkpoint["val_mse"]:.6f})')

    criterion = nn.MSELoss()

    # --- Per-level evaluation ---
    print(f'\n{"Level":<20} {"Verts":>7} {"NN MSE":>10} {"NN RMSE":>10} {"Formula MSE":>12} {"Form RMSE":>10} {"Improvement":>12}')
    print('-' * 85)

    total_nn_mse = 0
    total_formula_mse = 0
    total_verts = 0

    for level_idx, name in enumerate(level_names):
        mask = level_ids == level_idx
        n = mask.sum().item()
        if n == 0:
            continue

        lf = norm_features[mask].to(device)
        ll = labels[mask].to(device)
        rf = raw_features[mask]

        with torch.no_grad():
            nn_pred = model(lf)
            nn_mse = criterion(nn_pred, ll).item()

        formula_pred = formula_predict(rf)
        formula_mse = criterion(formula_pred, labels[mask]).item()

        improvement = (formula_mse - nn_mse) / formula_mse * 100 if formula_mse > 0 else 0

        total_nn_mse += nn_mse * n
        total_formula_mse += formula_mse * n
        total_verts += n

        print(f'{name:<20} {n:>7} {nn_mse:>10.6f} {nn_mse**0.5:>10.4f} '
              f'{formula_mse:>12.6f} {formula_mse**0.5:>10.4f} {improvement:>+11.1f}%')

    avg_nn = total_nn_mse / total_verts
    avg_formula = total_formula_mse / total_verts
    overall_imp = (avg_formula - avg_nn) / avg_formula * 100

    print('-' * 85)
    print(f'{"OVERALL":<20} {total_verts:>7} {avg_nn:>10.6f} {avg_nn**0.5:>10.4f} '
          f'{avg_formula:>12.6f} {avg_formula**0.5:>10.4f} {overall_imp:>+11.1f}%')

    # --- Feature importance (gradient-based) ---
    print(f'\nFeature Importance (gradient magnitude):')
    feature_names = [
        'normal.x', 'normal.y', 'normal.z',
        'local_height_ratio', 'normal_y_dup',
        'local_room_height', 'vertex_density',
        'neighbor_brightness', 'is_outdoor', 'face_area',
    ]

    # Compute average gradient magnitude per feature
    test_features = norm_features.to(device).requires_grad_(True)
    pred = model(test_features)
    pred.sum().backward()

    grad_importance = test_features.grad.abs().mean(dim=0).cpu()
    sorted_indices = torch.argsort(grad_importance, descending=True)

    for idx in sorted_indices:
        print(f'  {feature_names[idx]:<25} {grad_importance[idx]:.4f}')


if __name__ == '__main__':
    main()
