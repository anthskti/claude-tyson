"""Rolling hand bursts and independent head dodges. No camera/model dependencies."""
from collections import deque
from dataclasses import asdict
import math
import statistics
import uuid
from .config import Config
from .features import SIDES, hand_features, body_features


def check(key, label, value, operator, threshold, unit=''):
    passed = value >= threshold if operator == '>=' else value <= threshold if operator == '<=' else value == threshold
    return dict(key=key, label=label, value=value, operator=operator, threshold=threshold, unit=unit, passed=passed)


def regression(history):
    """Least-squares slopes use real source seconds, not assumed camera FPS."""
    times = [(v[0]-history[0][0])/1000 for v in history]
    mean_t = statistics.mean(times)
    variance = sum((t-mean_t)**2 for t in times)
    means = [statistics.mean(row[i] for row in history) for i in (1, 2, 3)]
    slopes = [sum((t-mean_t)*(v[i]-mean) for t, v in zip(times, history))/variance
              for i, mean in zip((1, 2, 3), means)]
    return slopes[2]/statistics.mean(v[3] for v in history), math.hypot(*slopes[:2])


class Detector:
    def __init__(self, config=None, session_id=None, on_event=None):
        self.cfg = (config or Config()).validate()
        self.session_id = session_id or uuid.uuid4().hex[:12]
        self.on_event = on_event or (lambda event: None)
        self.serial = self.calibration_serial = 0
        self.last_t = None
        self.hands = {s: self._hand_state() for s in SIDES}
        self.reset_calibration()

    @staticmethod
    def _hand_state(last_fire=-1e12):
        return dict(history=deque(), last_fire=last_fire, latched=False, release_since=None)

    def reset_calibration(self):
        # Manual reset starts fresh history but cannot bypass an existing cooldown.
        self.hands = {s: self._hand_state(v['last_fire']) for s, v in self.hands.items()}
        self.calibration = None
        self.head_samples = deque()
        self.head_filter = None
        self.body_loss_since = None
        self.dodge = dict(phase='unarmed', since=None, side=None)

    def _event(self, kind, onset, t, detected, features):
        self.serial += 1
        punch = kind.startswith('punch_')
        event = dict(schemaVersion=2, eventId=f'{self.session_id}-{self.serial:06d}', sessionId=self.session_id,
                     type=kind, onsetMs=onset, sampleMs=t, detectedMs=detected,
                     sideConvention='player_anatomical', trackingState='hand_valid' if punch else 'body_valid',
                     qualityScore=None, qualityKind='not_estimated', features=features,
                     calibrationId=None if punch else self.calibration['id'], experimental=True)
        self.on_event(event)
        return event

    def _punch(self, side, hand, reason, t, detected):
        s, c = self.hands[side], self.cfg
        if hand is None:
            self.hands[side] = self._hand_state(s['last_fire'])
            return dict(phase='warming', stage='tracking', message=reason, conditions=[], blockers=['hand_tracking']), None
        history = s['history']
        if history and t-history[-1][0] > c.max_gap_ms:
            s = self.hands[side] = self._hand_state(s['last_fire'])
            history = s['history']
        history.append((t, hand['x'], hand['y'], hand['size']))
        while len(history) > 2 and history[1][0] <= t-c.window_ms:
            history.popleft()
        span = t-history[0][0]
        ready = len(history) >= 4 and span >= c.window_ms
        growth, speed = regression(history) if ready else (0.0, 0.0)
        # Release refers only to a local slowdown, never a position or guard size.
        if s['latched'] and ready:
            if growth < c.growth_enter*c.release_fraction:
                s['release_since'] = t if s['release_since'] is None else s['release_since']
                if t-s['release_since'] >= c.release_ms:
                    s.update(latched=False, release_since=None)
            else:
                s['release_since'] = None
        elapsed = t-s['last_fire']
        release_elapsed = t-s['release_since'] if s['release_since'] is not None else 0
        conditions = [check('history_span', 'History span', span, '>=', c.window_ms, 'ms'),
                      check('history_samples', 'History samples', len(history), '>=', 4),
                      check('growth', 'Growth rate', growth, '>=', c.growth_enter, '/s'),
                      check('speed', 'Movement speed', speed, '>=', c.speed_enter, 'width/s'),
                      check('cooldown', 'Cooldown left', max(0, c.cooldown_ms-elapsed), '<=', 0, 'ms'),
                      check('release', 'Burst released', not s['latched'], '==', True)]
        fired = all(v['passed'] for v in conditions)
        event = None
        if fired:
            event = self._event('punch_'+side, history[0][0], t, detected,
                                dict(rule='recent_hand_motion', growthRate=growth, movementSpeed=speed,
                                     windowSpanMs=span, handednessScore=hand['handednessScore']))
            s.update(latched=True, release_since=None, last_fire=t)
        phase = 'warming' if not ready else 'latched' if s['latched'] else 'cooldown' if elapsed < c.cooldown_ms else 'ready'
        return dict(phase=phase, stage='fired' if fired else 'warming' if not ready else 'entry',
                    message='PUNCH ACCEPTED' if fired else 'Warming up' if not ready else '',
                    rule='recent_hand_motion', conditions=conditions,
                    blockers=[v['key'] for v in conditions if not v['passed']],
                    growthRate=growth, movementSpeed=speed, releaseElapsedMs=release_elapsed,
                    releaseRequiredMs=c.release_ms, releaseThreshold=c.growth_enter*c.release_fraction), event

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
        if not isinstance(t, (int, float)) or not math.isfinite(t) or (self.last_t is not None and t <= self.last_t):
            raise ValueError('Detector requires strictly increasing finite timestamps')
        if record['width'] <= 0 or record['height'] <= 0:
            raise ValueError('Frame dimensions must be positive')
        if self.last_t is not None and t-self.last_t > self.cfg.max_gap_ms:
            self.hands = {s: self._hand_state(v['last_fire']) for s, v in self.hands.items()}
            self.head_samples.clear()
            self.head_filter = None
            self.dodge = dict(phase='unarmed', since=None, side=None)
            if t-self.last_t >= self.cfg.recalibrate_after_loss_ms:
                self.calibration = None
        self.last_t = t
        detected = t if detected_ms is None else detected_ms
        hands, reasons = hand_features(record, self.cfg)
        out = dict(schemaVersion=2, timestampMs=t, trackingState='good' if len(hands) == 2 else 'degraded' if hands else 'lost',
                   features={}, markers={}, validity={}, actionDiagnostics={}, calibrationId=None)
        events = []
        for side in SIDES:
            hand = hands.get(side)
            diagnostic, event = self._punch(side, hand, reasons.get(side), t, detected)
            out['actionDiagnostics'][side] = diagnostic
            out['validity']['punch_'+side] = hand is not None
            out['features'][side] = {k: diagnostic.get(k, 0) for k in ('growthRate', 'movementSpeed')}
            if hand:
                out['markers'][side] = hand['marker']
            if event:
                events.append(event)
        events.extend(self._head(record, t, detected, out))
        out['calibrationId'] = self.calibration['id'] if self.calibration else None
        out['phases'] = dict(dodge=self.dodge['phase'], **{s: d['phase'] for s, d in out['actionDiagnostics'].items()})
        out['punchReadiness'] = {s: d['phase'] for s, d in out['actionDiagnostics'].items()}
        return out, events

    def metadata(self):
        return dict(schemaVersion=2, config=asdict(self.cfg), calibration=self.calibration, events=self.serial)
