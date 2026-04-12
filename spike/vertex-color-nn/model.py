"""
VertexColorNet — small MLP that predicts vertex brightness from geometry features.
"""

import torch
import torch.nn as nn


class VertexColorNet(nn.Module):
    """
    Input:  10 normalized features per vertex
    Output: 1 scalar brightness (0-1, via sigmoid)

    Architecture: 4-layer MLP with ReLU, ~3.5K parameters.
    """

    def __init__(self, in_features=10, hidden=64):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(in_features, hidden),
            nn.ReLU(),
            nn.Linear(hidden, hidden // 2),
            nn.ReLU(),
            nn.Linear(hidden // 2, hidden // 4),
            nn.ReLU(),
            nn.Linear(hidden // 4, 1),
            nn.Sigmoid(),
        )

    def forward(self, x):
        return self.net(x)


def count_parameters(model):
    return sum(p.numel() for p in model.parameters() if p.requires_grad)
