"""Bounded completion inference with a consumable timestamp-priority history.

Owned by the sensor worker; UI reads diagnostic snapshots, never this heap.
No CV inputs, offline completion timestamps, or future readings are used.
"""
import heapq
import itertools

import numpy as np
import torch

from .airpod_stateful import StatefulDetector, _StatefulMixin
from .calibrated_experiment import Experiment


class PriorityHistory:
    def __init__(self, duration_ms=2000.):
        if not np.isfinite(duration_ms) or duration_ms <= 0:
            raise ValueError('History duration must be positive and finite')
        self.duration_ms = duration_ms
        self.heap = []
        self.counter = itertools.count()
        self.latest = self.consumed_through = -float('inf')

    def __len__(self):
        return len(self.heap)

    def push(self, timestamp_ms, vector):
        vector = np.asarray(vector, dtype=np.float32)
        if not np.isfinite(timestamp_ms) or vector.shape != (6,) or not np.isfinite(vector).all():
            raise ValueError('History requires a finite timestamp and six finite channels')
        if timestamp_ms <= self.consumed_through or timestamp_ms < self.latest-self.duration_ms:
            return False
        self.latest = max(timestamp_ms, self.latest)
        heapq.heappush(self.heap, (timestamp_ms, next(self.counter), vector.copy()))
        while self.heap and self.heap[0][0] < self.latest-self.duration_ms:
            heapq.heappop(self.heap)
        return True

    def snapshot(self, end_ms):
        # A heap's internal array is not chronological. Sort a non-destructive
        # snapshot; priority pops are reserved for expiry and consumption.
        return [(t, x.copy()) for t, _, x in sorted(self.heap)
                if end_ms-self.duration_ms <= t <= end_ms]

    def consume_through(self, end_ms):
        count = 0
        while self.heap and self.heap[0][0] <= end_ms:
            heapq.heappop(self.heap)
            count += 1
        self.consumed_through = max(self.consumed_through, end_ms)
        return count


class BufferedDetector(StatefulDetector):
    punch_evidence = 'imu_buffered_model'

    def reset(self):
        super().reset()
        self.history = PriorityHistory()

    def metadata(self):
        result = super().metadata()
        result.update(inferencePolicy='consumable_priority_history',
                      stream=dict(self.info['stream'], historyMaxMs=2000., warmupWindowMs=0),
                      retainedState=False,
                      history=dict(container='timestamp min-heap', maxDurationMs=2000.,
                                   consumeOn='confirmed emitted straight/hook only',
                                   resetHiddenState='every snapshot; never carry expired or consumed motion',
                                   endpoint='current sensor reading; physical completion time unknown'),
                      scope='Completion model evaluated over unconsumed past <=2s; no future inputs')
        return result

    def predict(self, x, t, missing, recovery):
        self.history.push(t, x)
        snapshot = self.history.snapshot(t)
        # Start from zero for each bounded snapshot. Retaining hidden state here
        # would count overlapping readings twice and preserve consumed punches.
        state = None
        previous = None
        gaps = 0
        with torch.inference_mode():
            for timestamp, vector in snapshot:
                if previous is not None:
                    count = max(0, int(round((timestamp-previous)/40.))-1)
                    for _ in range(count):
                        _, state = self.model.step(torch.zeros(1,6), torch.zeros(1,dtype=torch.bool), state)
                    gaps += count
                logits, state = self.model.step(torch.from_numpy(vector[None]), torch.ones(1,dtype=torch.bool), state)
                previous = timestamp
            probabilities = logits.softmax(-1)[0].numpy()
        self.state = None  # No history survives outside the explicit queue.
        return probabilities, dict(bufferedMode=True, retainedState=False,
            historySpanMs=t-snapshot[0][0], historyMaxMs=self.history.duration_ms,
            bufferSamples=len(snapshot), bufferSamplesAfterDecision=len(self.history), consumedSamples=0,
            windowStartSensorTimestampSec=snapshot[0][0]/1000, windowEndSensorTimestampSec=t/1000,
            windowValidSamples=len(snapshot), windowMissingUpdates=gaps,
            validFraction=len(snapshot)/(len(snapshot)+gaps),
            completionTimeBasis='current causal prediction; exact physical endpoint unknown')

    def consume(self, t):
        count = self.history.consume_through(t)
        self.state = None
        self.fresh = 0
        # Keep the disarmed event latch and cooldown; consumption is not rearming.
        self.events.interrupt()
        return dict(consumedSamples=count, consumedThroughSensorTimestampSec=t/1000,
                    bufferSamplesAfterDecision=len(self.history))


class _BufferedMixin(_StatefulMixin):
    detector_type = BufferedDetector

    def prompt(self, now):
        return super().prompt(now).replace('STATEFUL COMPLETION:', 'BUFFERED COMPLETION:')
