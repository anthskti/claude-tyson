"""Pose-only dodge state machine from the working experiment harness."""
from collections import deque
import math, statistics
from .features import body_features
from .config import Config

class Detector:
    def __init__(self, config=None, session_id='pose'):
        self.cfg = config or Config()
        self.session_id = session_id
        self.serial = self.calibration_serial = 0
        self.last_t = None
        self.reset_calibration()

    def reset_calibration(self):
        self.calibration = None
        self.head_samples = deque()
        self.head_filter = None
        self.body_loss_since = None
        self.dodge = dict(phase='unarmed', since=None, side=None)

    def _event(self, kind, onset, t, detected, features):
        self.serial += 1
        return dict(schemaVersion=2, eventId=f'{self.session_id}-pose-{self.serial:06d}',
                    sessionId=self.session_id, type=kind, onsetMs=onset, sampleMs=t,
                    detectedMs=detected, sideConvention='player_anatomical', trackingState='body_valid',
                    qualityScore=None, qualityKind='not_estimated', features=features,
                    calibrationId=self.calibration['id'], experimental=True)

    def _head(self, record, t, detected, out):
        c = self.cfg
        body, reason = body_features(record, c)
        if body is None:
            self.head_samples.clear()
            self.head_filter = None
            self.dodge = dict(phase='unarmed', since=None, side=None)
            self.body_loss_since = t if self.body_loss_since is None else self.body_loss_since
            if t-self.body_loss_since >= c.recalibrate_after_loss_ms:
                self.calibration = None
            out['dodgeReadiness'] = dict(state='unavailable', reason=reason)
            return []
        self.body_loss_since = None
        if self.calibration is None:
            self.head_samples.append((t, body['head']['x'], body['head']['y'], body['scale']))
            while len(self.head_samples) > 2 and self.head_samples[1][0] <= t-c.head_init_ms:
                self.head_samples.popleft()
            scale = statistics.median(v[3] for v in self.head_samples)
            stable = max((max(v[i] for v in self.head_samples)-min(v[i] for v in self.head_samples))
                         * (record['height']/record['width'] if i == 2 else 1)/scale for i in (1, 2, 3)) <= c.head_jitter
            if t-self.head_samples[0][0] >= c.head_init_ms and len(self.head_samples) >= 4 and stable:
                self.calibration_serial += 1
                self.calibration = dict(id=f'{self.session_id}-head-{self.calibration_serial}', timestamp_ms=t,
                                        head_x=statistics.median(v[1] for v in self.head_samples), scale=scale,
                                        method='head_only', arms={})
            else:
                out['dodgeReadiness'] = dict(state='warming', reason='Hold head centered briefly',
                                             elapsedMs=t-self.head_samples[0][0], stable=stable)
                return []
        out['validity']['dodge'] = True
        out['dodgeReadiness'] = dict(state='ready', reason='Head reference available')
        out['markers']['head'] = body['head']
        x = -(body['head']['x']-self.calibration['head_x'])/self.calibration['scale']
        if self.head_filter is not None:
            old_t, old_x = self.head_filter
            alpha = 1 if not c.smoothing_ms else 1-math.exp(-(t-old_t)/c.smoothing_ms)
            x = old_x+alpha*(x-old_x)
        self.head_filter = (t, x)
        out['features']['lateralDisplacementBodyWidths'] = x
        s, events = self.dodge, []
        if s['phase'] == 'unarmed':
            if abs(x) <= c.dodge_exit:
                s['since'] = t if s['since'] is None else s['since']
                if t-s['since'] >= c.rearm_ms:
                    s.update(phase='ready', since=None)
            else:
                s['since'] = None
        elif s['phase'] == 'ready':
            if abs(x) >= c.dodge_enter:
                side = 'left' if x < 0 else 'right'
                if s['side'] != side or s['since'] is None:
                    s.update(side=side, since=t)
                if t-s['since'] >= c.dodge_hold_ms:
                    events.append(self._event('dodge_'+side, s['since'], t, detected, dict(lateralDisplacementBodyWidths=x)))
                    s.update(phase='active', since=None)
            else:
                s.update(since=None, side=None)
        elif s['phase'] == 'active':
            if abs(x) <= c.dodge_exit:
                s['since'] = t if s['since'] is None else s['since']
                if t-s['since'] >= c.rearm_ms:
                    events.append(self._event('return_neutral', s['since'], t, detected, dict(fromSide=s['side'])))
                    s.update(phase='ready', since=None, side=None)
            else:
                s['since'] = None
        return events

    def process(self, record, detected_ms=None):
        t = record['timestamp_ms']
        if not math.isfinite(t) or (self.last_t is not None and t <= self.last_t):
            raise ValueError('Pose timestamps must increase')
        if record['width'] <= 0 or record['height'] <= 0:
            raise ValueError('Invalid frame dimensions')
        if self.last_t is not None and t-self.last_t > self.cfg.max_gap_ms:
            self.head_samples.clear()
            self.head_filter = None
            self.dodge = dict(phase='unarmed', since=None, side=None)
            if t-self.last_t >= self.cfg.recalibrate_after_loss_ms:
                self.calibration = None
        self.last_t = t
        out = dict(timestampMs=t, features={}, markers={}, validity={'dodge':False})
        events = self._head(record,t,t if detected_ms is None else detected_ms,out)
        out['calibrationId'] = self.calibration['id'] if self.calibration else None
        out['trackingState'] = 'good' if out['validity']['dodge'] else ('calibrating' if out['dodgeReadiness']['state']=='warming' else 'lost')
        out['pose'] = dict(body='lean_'+self.dodge['side'] if self.dodge['phase']=='active' else 'neutral',
                           guards=dict(left='neutral',right='neutral'))
        return out, events
