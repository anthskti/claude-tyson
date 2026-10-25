"""Small masked temporal CNN/GRU; optional PyTorch dependency, no live imports."""
import torch
from torch import nn
from torch.nn import functional as F

ARCHITECTURE = dict(version='masked-cnn-gru-v1', channels=[6, 16, 32], kernels=[5, 3],
                    hidden=32, convolutionDropout=.15, headDropout=.20, classes=3)


class MotionClassifier(nn.Module):
    def __init__(self, kind='cnn_gru', regularized=True):
        super().__init__()
        if kind not in ('cnn_gru', 'cnn'):
            raise ValueError('Unknown model kind')
        self.kind = kind
        self.convs = nn.ModuleList([nn.Conv1d(6, 16, 5), nn.Conv1d(16, 32, 3)])
        self.norms = nn.ModuleList([nn.LayerNorm(16), nn.LayerNorm(32)])
        self.drop = nn.Dropout(.15 if regularized else 0.)
        self.gru = nn.GRUCell(32, 32) if kind == 'cnn_gru' else None
        self.head_drop = nn.Dropout(.20 if regularized else 0.)
        self.head = nn.Linear(32, 3)

    def forward(self, x, mask):
        # Explicit where also neutralizes NaNs at masked positions.
        x = torch.where(mask.unsqueeze(-1), x, torch.zeros_like(x))
        for conv, norm in zip(self.convs, self.norms):
            kernel = conv.kernel_size[0]
            x = conv(F.pad(x.transpose(1, 2), (kernel-1, 0))).transpose(1, 2)
            counts = F.conv1d(F.pad(mask[:, None].to(x.dtype), (kernel-1, 0)),
                              torch.ones(1, 1, kernel, device=x.device, dtype=x.dtype))
            mask = counts[:, 0] == kernel
            x = self.drop(F.relu(norm(x)))
            x = torch.where(mask.unsqueeze(-1), x, torch.zeros_like(x))
        if self.gru is not None:
            h = x.new_zeros(x.shape[0], 32)
            for t in range(x.shape[1]):
                candidate = self.gru(x[:, t], h)
                h = torch.where(mask[:, t, None], candidate, h)
        else:
            h = x.sum(dim=1) / mask.sum(dim=1).clamp_min(1).unsqueeze(-1)
        return self.head(self.head_drop(h))
