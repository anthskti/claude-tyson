"""Causal per-reading completion classifier and shared event policy."""
from dataclasses import dataclass, asdict
import numpy as np
import torch
from torch import nn

CLASSES = ['non_punch', 'straight', 'hook']
ARCHITECTURE = dict(version='completion-gru-v1', inputs=6, projection=32, hidden=64,
                    classes=CLASSES, missingDecay=.9, maxMissingSteps=4)


class CompletionGRU(nn.Module):
    def __init__(self, regularized=True):
        super().__init__()
        self.projection = nn.Sequential(nn.Linear(6, 32), nn.LayerNorm(32), nn.ReLU())
        self.gru = nn.GRUCell(32, 64)
        self.dropout = nn.Dropout(.15 if regularized else 0)
        self.head = nn.Linear(64, 3)

    def initial(self, batch, device):
        return torch.zeros(batch, 64, device=device), torch.zeros(batch, dtype=torch.long, device=device)

    def step(self, x, valid, state=None):
        h, missing = state if state is not None else self.initial(len(x), x.device)
        x = torch.where(valid[:, None], x, torch.zeros_like(x))
        candidate = self.gru(self.projection(x), h)
        missing = torch.where(valid, torch.zeros_like(missing), missing+1)
        retained = h*ARCHITECTURE['missingDecay']
        retained = torch.where((missing > ARCHITECTURE['maxMissingSteps'])[:, None], torch.zeros_like(h), retained)
        h = torch.where(valid[:, None], candidate, retained)
        return self.head(self.dropout(h)), (h, missing)

    def forward(self, x, mask, state=None):
        logits = []
        for i in range(x.shape[1]):
            y, state = self.step(x[:, i], mask[:, i], state)
            logits.append(y)
        return torch.stack(logits, 1), state


@dataclass(frozen=True)
class EventSettings:
    probability: float = .8
    margin: float = .2
    confirmations: int = 1
    rearm_probability: float = .6
    rearm_samples: int = 2
    cooldown_ms: float = 200.

    def __post_init__(self):
        for value in (self.probability, self.margin, self.rearm_probability):
            if not np.isfinite(value) or not 0 <= value <= 1:
                raise ValueError('Event probabilities/margin must be in [0, 1]')
        if (self.confirmations < 1 or self.rearm_samples < 1 or
                not np.isfinite(self.cooldown_ms) or self.cooldown_ms < 0):
            raise ValueError('Invalid confirmation/rearm/cooldown settings')


class CompletionEvents:
    def __init__(self, settings=EventSettings()):
        self.settings = settings
        self.last_fire = -1e30
        self.reset()

    def reset(self):
        self.armed = False
        self.clear_count = self.confirm_count = 0
        self.candidate = None

    def interrupt(self):
        # Preserve the emitted-event latch across a short gap; do not count a
        # missing sample as evidence of either a new punch or background.
        self.clear_count = self.confirm_count = 0
        self.candidate = None

    def update(self, probabilities, t, enabled=True):
        p = np.asarray(probabilities)
        if p.shape != (3,) or not np.isfinite(p).all():
            raise FloatingPointError('Invalid completion probabilities')
        c = self.settings
        order = np.argsort(p)
        top, margin = float(p[order[-1]]), float(p[order[-1]]-p[order[-2]])
        label = CLASSES[order[-1]] if top >= c.probability and margin >= c.margin else 'abstain'
        if p[0] >= c.rearm_probability:
            self.clear_count += 1
            if self.clear_count >= c.rearm_samples:
                self.armed = True
        else:
            self.clear_count = 0
        if enabled and label in ('straight', 'hook'):
            self.confirm_count = self.confirm_count+1 if self.candidate == label else 1
            self.candidate = label
        else:
            self.confirm_count = 0
            self.candidate = None
        cooldown = max(0., c.cooldown_ms-(t-self.last_fire))
        blockers = []
        if label not in ('straight', 'hook'):
            blockers.append('no_completed_punch')
        if not self.armed:
            blockers.append('needs_background_rearm')
        if self.confirm_count < c.confirmations:
            blockers.append('prediction_confirmation')
        if cooldown:
            blockers.append('event_cooldown')
        if not enabled:
            blockers.append('recovery_or_emission_disabled')
        fire = None if blockers else label
        f = dict(classification=label, argmaxClass=CLASSES[order[-1]],
                 probabilities=dict(zip(CLASSES, map(float, p))), topProbability=top, probabilityMargin=margin,
                 minProbability=c.probability, minMargin=c.margin, armed=self.armed,
                 confirmationCount=self.confirm_count, confirmationRequired=c.confirmations,
                 rearmCount=self.clear_count, rearmRequired=c.rearm_samples,
                 cooldownRemainingMs=cooldown, blockedBy=blockers)
        if fire:
            self.armed, self.last_fire = False, t
            self.confirm_count = 0
        f['armedAfterDecision'] = self.armed
        return f, fire


def stream_events(probabilities, mask, settings=EventSettings()):
    policy = CompletionEvents(settings)
    fresh = 0
    missing = 0
    result = []
    for i, (p, valid) in enumerate(zip(probabilities, mask)):
        if not valid:
            fresh = 0
            missing += 1
            policy.interrupt()
            if missing > ARCHITECTURE['maxMissingSteps']:
                policy.reset()
            continue
        missing = 0
        fresh += 1
        _, label = policy.update(p, i*40., enabled=fresh >= 2)
        if label:
            result.append(dict(index=i, timeMs=i*40., label=label))
    return result
