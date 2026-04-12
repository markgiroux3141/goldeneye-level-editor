"""
Train VertexColorNet on extracted vertex features.
Hold out Facility (indoor) and Dam (outdoor) for validation.
"""

import os
import time
import torch
import torch.nn as nn
from torch.utils.data import TensorDataset, DataLoader
from model import VertexColorNet, count_parameters

DATA_PATH = os.path.join(os.path.dirname(__file__), 'data', 'vertex_data.pt')
CHECKPOINT_DIR = os.path.join(os.path.dirname(__file__), 'checkpoints')

# Training config
BATCH_SIZE = 4096
EPOCHS = 200
LR = 1e-3
WEIGHT_DECAY = 1e-5

# Validation levels (hold out one indoor + one outdoor)
VAL_LEVELS = {'02 - Facility', '01 - Dam'}


def main():
    os.makedirs(CHECKPOINT_DIR, exist_ok=True)

    # --- Device ---
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    print(f'Device: {device}')
    if device.type == 'cuda':
        print(f'GPU: {torch.cuda.get_device_name(0)}')

    # --- Load data ---
    print(f'Loading data from {DATA_PATH}...')
    data = torch.load(DATA_PATH, weights_only=False)
    features = data['features']
    labels = data['labels']
    level_ids = data['level_ids']
    level_names = data['level_names']
    feat_mean = data['feat_mean']
    feat_std = data['feat_std']

    print(f'Total vertices: {len(features)}')
    print(f'Features: {features.shape[1]}')

    # --- Normalize features ---
    features = (features - feat_mean) / feat_std

    # --- Train/val split by level ---
    val_level_indices = {i for i, name in enumerate(level_names) if name in VAL_LEVELS}
    val_mask = torch.tensor([lid.item() in val_level_indices for lid in level_ids])
    train_mask = ~val_mask

    train_features = features[train_mask].to(device)
    train_labels = labels[train_mask].to(device)
    val_features = features[val_mask].to(device)
    val_labels = labels[val_mask].to(device)

    print(f'Train: {len(train_features)} vertices ({train_mask.sum()} from {len(level_names) - len(val_level_indices)} levels)')
    print(f'Val:   {len(val_features)} vertices (from {", ".join(sorted(VAL_LEVELS))})')

    # --- Dataloaders ---
    train_ds = TensorDataset(train_features, train_labels)
    train_loader = DataLoader(train_ds, batch_size=BATCH_SIZE, shuffle=True)

    # --- Model ---
    model = VertexColorNet(in_features=features.shape[1]).to(device)
    print(f'Model parameters: {count_parameters(model):,}')

    optimizer = torch.optim.Adam(model.parameters(), lr=LR, weight_decay=WEIGHT_DECAY)
    criterion = nn.MSELoss()

    # --- Formula baseline (for comparison) ---
    # Simple formula: ambient + intensity * max(0, normal.y)
    # Features are normalized, so we need to un-normalize normal.y (feature index 4)
    # But we can compute baseline on raw data
    raw_features = data['features']
    raw_labels = data['labels']
    formula_pred = 0.3 + 0.7 * torch.clamp(raw_features[:, 4], min=0).unsqueeze(1)
    formula_mse = nn.MSELoss()(formula_pred, raw_labels).item()
    print(f'Formula baseline MSE: {formula_mse:.6f} (RMSE: {formula_mse**0.5:.4f})')

    # --- Training loop ---
    best_val_loss = float('inf')
    start_time = time.time()

    for epoch in range(1, EPOCHS + 1):
        model.train()
        train_loss = 0.0
        n_batches = 0

        for batch_x, batch_y in train_loader:
            optimizer.zero_grad()
            pred = model(batch_x)
            loss = criterion(pred, batch_y)
            loss.backward()
            optimizer.step()
            train_loss += loss.item()
            n_batches += 1

        train_loss /= n_batches

        # Validation
        model.eval()
        with torch.no_grad():
            val_pred = model(val_features)
            val_loss = criterion(val_pred, val_labels).item()

        # Save best
        if val_loss < best_val_loss:
            best_val_loss = val_loss
            torch.save({
                'model_state': model.state_dict(),
                'feat_mean': feat_mean,
                'feat_std': feat_std,
                'in_features': features.shape[1],
                'epoch': epoch,
                'val_mse': val_loss,
            }, os.path.join(CHECKPOINT_DIR, 'best_model.pt'))

        if epoch % 10 == 0 or epoch == 1:
            elapsed = time.time() - start_time
            print(f'Epoch {epoch:3d}/{EPOCHS}  '
                  f'train_mse={train_loss:.6f}  '
                  f'val_mse={val_loss:.6f}  '
                  f'best={best_val_loss:.6f}  '
                  f'[{elapsed:.1f}s]')

    elapsed = time.time() - start_time
    print(f'\nTraining complete in {elapsed:.1f}s')
    print(f'Best val MSE:    {best_val_loss:.6f} (RMSE: {best_val_loss**0.5:.4f})')
    print(f'Formula MSE:     {formula_mse:.6f} (RMSE: {formula_mse**0.5:.4f})')
    improvement = (formula_mse - best_val_loss) / formula_mse * 100
    print(f'Improvement:     {improvement:.1f}% lower MSE than formula')

    # --- Per-level validation breakdown ---
    print(f'\nPer-level validation MSE:')
    model.load_state_dict(torch.load(
        os.path.join(CHECKPOINT_DIR, 'best_model.pt'), weights_only=False
    )['model_state'])
    model.eval()

    for level_name in sorted(VAL_LEVELS):
        level_idx = level_names.index(level_name)
        mask = level_ids == level_idx
        if mask.sum() == 0:
            continue
        lf = features[mask].to(device)
        ll = labels[mask].to(device)
        with torch.no_grad():
            pred = model(lf)
            mse = criterion(pred, ll).item()
        print(f'  {level_name}: MSE={mse:.6f} RMSE={mse**0.5:.4f} ({mask.sum()} verts)')


if __name__ == '__main__':
    main()
