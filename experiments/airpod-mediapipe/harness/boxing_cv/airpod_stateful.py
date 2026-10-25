"""Separate stateful completion mode. CV is never a punch input."""
from dataclasses import asdict
from pathlib import Path
import time
import numpy as np
import torch

from .imu_stateful import CompletionEvents, EventSettings
from .model_bundle import load_model
from .airpod_model import _ModelExperimentMixin
from .calibrated_experiment import Experiment


class StatefulDetector:
    punch_evidence = 'imu_stateful_model'

    def __init__(self, model_path, hand, settings):
        self.model, self.info = self.load_bundle(model_path, hand)
        self.model_path, self.hand, self.cfg = str(Path(model_path).resolve()), hand, settings
        self.profile = None
        self.emission_enabled = True
        self.events = CompletionEvents(EventSettings(**self.info['eventPolicy']))
        self.reset()
        with torch.inference_mode():
            self.model.step(torch.zeros(1, 6), torch.ones(1, dtype=torch.bool))

    @property
    def armed(self): return self.events.armed

    def load_bundle(self, model_path, hand):
        return load_model(model_path, hand)

    @property
    def last_fire(self): return self.events.last_fire

    @last_fire.setter
    def last_fire(self, value): self.events.last_fire = value

    def reset(self):
        self.state = None
        self.last_t = None
        self.fresh = self.updates = 0
        self.events.reset()

    def pause(self):
        self.fresh = 0
        self.events.interrupt()

    def metadata(self):
        return dict(bundle=self.model_path, weightsSha256=self.info['weightsSha256'],
            modelType='completion_gru', selected='completion_gru', channelNames=self.info['channelNames'],
            classes=self.info['classes'], normalization=self.info['normalization'],
            stream=self.info['stream'], eventPolicy=self.info['eventPolicy'], device='cpu',
            sampling='One update per new native IMU reading, approximately 25 Hz; no future interpolation',
            legacyPunchThresholdsUsed=False, scope='Stateful completed-action classification; physical latency requires independent labels')

    def predict(self, x, t, missing, recovery):
        """Single-reading update; buffered mode overrides only history evaluation."""
        with torch.inference_mode():
            if recovery == 'short_gap_state_decayed':
                for _ in range(missing):
                    _, self.state = self.model.step(torch.zeros(1,6), torch.zeros(1,dtype=torch.bool), self.state)
            logits, self.state = self.model.step(torch.from_numpy(x[None]), torch.ones(1,dtype=torch.bool), self.state)
            probabilities = logits.softmax(-1)[0].numpy()
        return probabilities, {}

    def consume(self, t):
        return {}

    def process(self, s, pose=None):
        if self.profile is None:
            return dict(statefulMode=True, modelMode=True, state='uncalibrated'), None
        if self.profile.get('hand', self.hand) != self.hand:
            raise ValueError('Calibration/model hand mismatch')
        if np.dot(s['up'], self.profile['up']) < .95:
            self.reset()
            return dict(statefulMode=True, modelMode=True, state='orientation_inconsistent'), None
        t = s['t']; delta = 40. if self.last_t is None else t-self.last_t
        if delta <= 0:
            self.reset()
            return dict(statefulMode=True, modelMode=True, state='invalid_sensor_clock'), None
        missing = max(0, int(round(delta/40))-1)
        recovery = 'continuous'
        if delta > self.info['stream']['shortGapMaxMs']:
            self.reset(); recovery = 'long_gap_state_reset'
        elif missing:
            self.pause(); recovery = 'short_gap_state_decayed'
        self.last_t = t
        p = self.profile
        basis = np.asarray([p[k] for k in ('forward','sideways','up')])
        x = np.r_[basis@(s['a']-p['accelBiasReferenceG']), basis@s['w']]
        physical_channels = x.tolist()
        x = ((x-np.array(self.info['normalization']['mean']))/self.info['normalization']['scale']).astype(np.float32)
        if not np.isfinite(x).all(): raise FloatingPointError('Nonfinite live IMU vector')
        started = time.perf_counter()
        probabilities, history_features = self.predict(x, t, missing, recovery)
        duration = (time.perf_counter()-started)*1000
        self.fresh += 1; self.updates += 1
        ready = self.fresh >= self.info['stream']['recoveryValidSamples']
        features, label = self.events.update(probabilities, t, enabled=ready and self.emission_enabled)
        features.update(statefulMode=True, modelMode=True, state='prediction' if ready else 'recovering',
            predictionFresh=True, modelExecutionMs=duration, recovery=recovery,
            gapMs=delta, missingUpdates=missing, consecutiveFreshSamples=self.fresh, recurrentUpdates=self.updates,
            historySpanMs=0, sensorAgeMs=s['ageMs'], validFraction=1.,
            windowStartSensorTimestampSec=None, windowEndSensorTimestampSec=t/1000,
            retainedState=True, sampling='native approximately 25 Hz')
        features.update(channelOrder=['a_forward','a_side','a_up','w_forward','w_side','w_up'],
                        calibratedChannels=physical_channels, normalizedChannels=x.tolist())
        features.update(history_features)
        event = None
        if label:
            features.update(self.consume(t))
            event = dict(type='punch_'+self.hand, punchType=label, sensorTimestampSec=t/1000,
                sensorReceiveUnixMs=s['received'], sequence=s['sequence'], onsetSensorTimestampSec=t/1000,
                features=dict(features), experimental=True, punchEvidence=self.punch_evidence,
                modelWeightsSha256=self.info['weightsSha256'], modelProbability=features['topProbability'],
                probabilities=features['probabilities'], targetMeaning='completed_action',
                modelWindowStartSensorTimestampSec=features['windowStartSensorTimestampSec'],
                modelWindowEndSensorTimestampSec=features['windowEndSensorTimestampSec'])
        return features, event


class _StatefulMixin(_ModelExperimentMixin):
    detector_type = StatefulDetector

    def invalidate(self, reason, calibration=False):
        if not calibration and not self.calibrating and reason in ('stale','sensor_gap'):
            self.detector.pause()
            self.sensor_state = reason
            if self.trial:
                self.trial['invalidReason'] = reason
            return [dict(kind='stateful_gap_pause', reason=reason, policy='No prediction while stale; decide retain/reset on next sensor timestamp')]
        return super().invalidate(reason, calibration)

    def prompt(self, now):
        return super().prompt(now).replace('MODEL DETECTION:', 'STATEFUL COMPLETION:')
