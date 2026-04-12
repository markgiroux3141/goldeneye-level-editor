"""
Export trained VertexColorNet weights to JSON for browser inference.
The exported format is simple enough to run with plain JS matrix math.
"""

import os
import json
import torch
from model import VertexColorNet

CHECKPOINT_PATH = os.path.join(os.path.dirname(__file__), 'checkpoints', 'best_model.pt')
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), 'data', 'model_weights.json')


def main():
    checkpoint = torch.load(CHECKPOINT_PATH, weights_only=False)
    model = VertexColorNet(in_features=checkpoint['in_features'])
    model.load_state_dict(checkpoint['model_state'])
    model.eval()

    # Extract layers (Linear layers only)
    layers = []
    for module in model.net:
        if isinstance(module, torch.nn.Linear):
            layers.append({
                'weights': module.weight.detach().cpu().tolist(),
                'bias': module.bias.detach().cpu().tolist(),
            })

    # Normalization stats
    feat_mean = checkpoint['feat_mean'].tolist()
    feat_std = checkpoint['feat_std'].tolist()

    output = {
        'layers': layers,
        'activations': ['relu', 'relu', 'relu', 'sigmoid'],
        'normalization': {
            'mean': feat_mean,
            'std': feat_std,
        },
        'feature_names': [
            'normal_x', 'normal_y', 'normal_z',
            'local_height_ratio', 'normal_y_dup',
            'local_room_height', 'vertex_density',
            'neighbor_brightness', 'is_outdoor', 'face_area',
        ],
        'metadata': {
            'epoch': checkpoint['epoch'],
            'val_mse': checkpoint['val_mse'],
        },
    }

    with open(OUTPUT_PATH, 'w') as f:
        json.dump(output, f, indent=2)

    # Size report
    size_kb = os.path.getsize(OUTPUT_PATH) / 1024
    n_params = sum(
        len(l['weights']) * len(l['weights'][0]) + len(l['bias'])
        for l in layers
    )
    print(f'Exported {n_params:,} parameters to {OUTPUT_PATH} ({size_kb:.1f} KB)')
    print(f'Layers: {" → ".join(str(len(l["bias"])) for l in layers)}')


if __name__ == '__main__':
    main()
