"""Single-hand, calibrated IMU experiment. Pure numerical core; no camera/model IO.

Calibration labels never enter classification. Punch decisions are IMU-only.
Displacement is a bounded inertial estimate, not measured hand position.
"""
from collections import deque
from dataclasses import asdict, dataclass
import json
import math
from pathlib import Path
import numpy as np


@dataclass
class Settings:
    window_ms: float = 160
    min_span_ms: float = 80
    max_gap_ms: float = 150
    max_age_ms: float = 150
    accel_enter_g: float = .45
    straight_forward_g: float = .45
    straight_forward_fraction: float = .65
    straight_max_yaw_rad: float = .10
    hook_forward_g: float = .20
    hook_yaw_rad: float = .15
    hook_yaw_fraction: float = .30
    hook_yaw_coherence: float = .70
    hook_calibration_method: str = 'coherent_rotation'
    quiet_accel_g: float = .20
    quiet_gyro_rad_s: float = 1.0
    quiet_ms: float = 200
    cooldown_ms: float = 300
    movement_gate: bool = True
    min_movement_m: float = .12
    movement_onset_g: float = .20
    movement_max_ms: float = 320
    movement_max_gap_ms: float = 100
    movement_end_quiet_ms: float = 80
    hook_endpoint_gate: bool = False
    hook_max_endpoint_angle_deg: float = 60
    # Read old configs, but explicitly reject enabling their former CV gate.
    pose_gate: bool = False
    pose_travel_bw: float = .06
    pose_max_age_ms: float = 150

    def validate(self):
        for k, v in asdict(self).items():
            if k == 'hook_calibration_method':
                if v not in ('early_onset', 'coherent_rotation'):
                    raise ValueError('Unknown hook_calibration_method')
            elif k in ('pose_gate', 'movement_gate', 'hook_endpoint_gate'):
                if not isinstance(v, bool):
                    raise ValueError(f'{k} must be boolean')
            elif isinstance(v, bool) or not isinstance(v, (float, int)) or not math.isfinite(v) or v <= 0:
                raise ValueError(f'{k} must be finite and positive')
        if not self.min_span_ms <= self.window_ms or self.max_gap_ms > self.window_ms:
            raise ValueError('Require min_span <= window and max_gap <= window')
        for k in ('straight_forward_fraction', 'hook_yaw_fraction', 'hook_yaw_coherence'):
            if getattr(self, k) > 1:
                raise ValueError(f'{k} must be <= 1')
        if self.pose_gate:
            raise ValueError('Calibrated punches are IMU-only; pose_gate must be false. CV is for dodges only.')
        if not self.min_span_ms <= self.movement_max_ms <= 500:
            raise ValueError('Require min_span <= movement_max_ms <= 500 to bound integration drift')
        if self.movement_max_gap_ms > self.max_gap_ms or self.movement_end_quiet_ms > self.movement_max_ms:
            raise ValueError('Movement gap/quiet duration exceeds its enclosing limit')
        if not 0 < self.hook_max_endpoint_angle_deg < 90:
            raise ValueError('Hook endpoint half-angle must be between 0 and 90 degrees')
        return self

    @classmethod
    def load(cls, path=None):
        return cls(**(json.loads(Path(path).read_text()) if path else {})).validate()


def vec(row, key, names='xyz'):
    obj = row.get(key)
    if not isinstance(obj, dict) or any(isinstance(obj.get(k), bool) or not isinstance(obj.get(k), (int, float))
                                       or not math.isfinite(obj[k]) for k in names):
        raise ValueError('invalid_'+key)
    return np.array([obj[k] for k in names], dtype=float)


def unit(v):
    n = np.linalg.norm(v)
    if n < 1e-8:
        raise ValueError('degenerate_vector')
    return v/n


def rotation(q):
    """Hamilton x,y,z,w device-to-reference rotation; checked against gravity.

Core Motion q rotates measured gravity to reference down. Sign q/-q is immaterial.
Reject non-unit corruption rather than normalizing arbitrary garbage.
"""
    if not .95 <= np.linalg.norm(q) <= 1.05:
        raise ValueError('invalid_quaternion_norm')
    x, y, z, w = q/np.linalg.norm(q)
    return np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
                     [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
                     [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]])


def matches_source(row, bud, source_type='airpod'):
    if source_type == 'iphone':
        return (bud == 'right' and row.get('sourceType') == 'iphone'
                and row.get('sensorLocation') == 'device' and row.get('punchingHand') == 'right'
                and row.get('earbud') is None)
    return (source_type == 'airpod' and row.get('sourceType', 'airpod') == 'airpod'
            and row.get('sensorLocation') == bud)


def sample(row, bud, now, max_age, source_type='airpod'):
    if row.get('kind') != 'sample' or not matches_source(row, bud, source_type):
        raise ValueError('wrong_source_or_not_sample')
    if not isinstance(row.get('sessionId'), str) or not row['sessionId']:
        raise ValueError('invalid_session')
    for k in ('receiveUnixMs', 'sensorTimestampSec'):
        v = row.get(k)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
            raise ValueError('invalid_timestamp')
    age = now-row['receiveUnixMs']
    if not 0 <= age <= max_age:
        raise ValueError('stale_or_future_sample')
    r = rotation(vec(row, 'attitude', 'xyzw'))
    g = vec(row, 'gravity')
    if not .8 <= np.linalg.norm(g) <= 1.2:
        raise ValueError('invalid_gravity')
    return dict(t=row['sensorTimestampSec']*1000, received=row['receiveUnixMs'],
                a=r@vec(row, 'userAcceleration'), w=r@vec(row, 'rotationRate'),
                up=-unit(r@g), sequence=row.get('sequence'), ageMs=age,
                sessionId=row['sessionId'], decisionUnixMs=now)


def first_burst(rows, threshold=.25):
    for i, s in enumerate(rows):
        if np.linalg.norm(s['a']) >= threshold:
            return [v for v in rows[i:] if v['t']-s['t'] <= 120]
    raise ValueError('no_initial_acceleration_burst')


def hook_direction_evidence(rows, up, threshold, cfg):
    """First qualifying rotation in the initial stroke; never strongest whole-trial peak.

    Use the same yaw magnitude/coherence as runtime, without assuming a direction.
    Rotation share is logged, not required to identify the sign of this component.
    Runtime hook classification still requires its configured rotation share.
    This avoids fitting small counter-motion before the actual hook.
No windows after the bounded stroke horizon are allowed (return motion risk).
"""
    onset = next((i for i, s in enumerate(rows) if np.linalg.norm(s['a']) >= threshold), None)
    if onset is None:
        return dict(valid=False, reason='no_acceleration_onset')
    start = rows[onset]['t']
    for i in range(onset, len(rows)):
        if rows[i]['t']-start > cfg.movement_max_ms:
            break
        if i > onset and rows[i]['t']-rows[i-1]['t'] > cfg.movement_max_gap_ms:
            return dict(valid=False, reason='hook_calibration_sensor_gap')
        window = [s for s in rows[:i+1] if rows[i]['t']-cfg.window_ms <= s['t']]
        if len(window) < 3 or window[-1]['t']-window[0]['t'] < cfg.min_span_ms:
            continue
        dt = np.diff([s['t'] for s in window])/1000
        if np.any(dt <= 0) or np.any(dt*1000 > cfg.movement_max_gap_ms):
            continue
        yaw_rate = np.array([np.dot(s['w'], up) for s in window])
        rotation_rate = np.array([np.linalg.norm(s['w']) for s in window])
        signed = float(np.sum((yaw_rate[:-1]+yaw_rate[1:])*.5*dt))
        absolute = float(np.sum((abs(yaw_rate[:-1])+abs(yaw_rate[1:]))*.5*dt))
        rotation_sum = float(np.sum((rotation_rate[:-1]+rotation_rate[1:])*.5*dt))
        fraction = absolute/max(rotation_sum, 1e-12)
        coherence = abs(signed)/max(absolute, 1e-12)
        peak = max(float(np.linalg.norm(s['a'])) for s in window)
        if (peak >= cfg.accel_enter_g and abs(signed) >= cfg.hook_yaw_rad
                and coherence >= cfg.hook_yaw_coherence):
            return dict(valid=True, signedYawRad=signed, yawFraction=fraction, yawCoherence=coherence,
                        peakAccelG=peak, windowStartFromOnsetMs=window[0]['t']-start,
                        windowEndFromOnsetMs=window[-1]['t']-start, samples=len(window))
    return dict(valid=False, reason='no_coherent_hook_rotation_within_stroke')


def build_profile(trials, settings=None, hand='left', policy='standard'):
    """Fit coordinate axes/sign only. Negative labels never fit entry thresholds."""
    if hand not in ('left', 'right'):
        raise ValueError('Punching hand must be left or right')
    if policy not in ('quick', 'standard'):
        raise ValueError('Unknown calibration policy')
    count = 1 if policy == 'quick' else 3
    cfg = settings or Settings()
    quiet = [s for tr in trials if tr['label'] == 'quiet' for s in tr['samples']]
    if len(quiet) < 20:
        raise ValueError('quiet_guard_needs_at_least_20_fresh_samples')
    noise = np.percentile([np.linalg.norm(s['a']) for s in quiet], 95)
    spin = np.percentile([np.linalg.norm(s['w']) for s in quiet], 95)
    if noise > .25 or spin > .8:
        raise ValueError('guard_was_not_still_repeat_calibration')
    up = unit(np.mean([s['up'] for s in quiet], axis=0))
    forwards = []
    for tr in trials:
        if tr['label'] != 'straight':
            continue
        burst = first_burst(tr['samples'], max(.25, noise*3))
        if len(burst) < 2:
            raise ValueError('straight_burst_too_short')
        # First two onset samples, not peak braking or the retraction phase.
        direction = np.mean([s['a'] for s in burst[:2]], axis=0)
        flat = direction-up*np.dot(direction, up)
        if np.linalg.norm(flat) < .5*np.linalg.norm(direction):
            raise ValueError('straight_was_mostly_vertical')
        forwards.append(unit(flat))
    if len(forwards) != count:
        raise ValueError(f'need_{count}_straights')
    forward = unit(np.mean(forwards, axis=0))
    agreement = min(float(np.dot(v, forward)) for v in forwards)
    if agreement < .8:
        raise ValueError('straight_directions_disagree_repeat_calibration')
    sideways = unit(np.cross(up, forward))
    yaw, evidence = [], []
    for tr in trials:
        if tr['label'] == 'hook':
            if cfg.hook_calibration_method == 'early_onset':
                burst = first_burst(tr['samples'], max(.25, noise*3))
                if len(burst) < 2:
                    raise ValueError('hook_burst_too_short')
                yaw.append(float(np.mean([np.dot(s['w'], up) for s in burst])))
            else:
                evidence.append(hook_direction_evidence(tr['samples'], up, max(.25, noise*3), cfg))
                try:
                    burst = first_burst(tr['samples'], max(.25, noise*3))
                    yaw.append(float(np.mean([np.dot(s['w'], up) for s in burst])))
                except ValueError:
                    yaw.append(None)
    if len(yaw) != count:
        raise ValueError(f'need_{count}_hooks')
    if cfg.hook_calibration_method == 'early_onset':
        sign = 1 if np.median(yaw) >= 0 else -1
        passed = [v*sign > .3 for v in yaw]
    else:
        directions = [1 if e['signedYawRad'] > 0 else -1 for e in evidence if e['valid']]
        sign = 1 if sum(directions) >= 0 else -1
        passed = [e['valid'] and e['signedYawRad']*sign > 0 for e in evidence]
    consistent = all(passed)
    all_samples = [s for tr in trials for s in tr['samples']]
    if any(np.dot(s['up'], up) < .95 for s in all_samples):
        raise ValueError('orientation_gravity_inconsistent_repeat_calibration')
    return dict(version=2 if cfg.hook_calibration_method == 'coherent_rotation' else 1,
                hand=hand, forward=forward.tolist(), up=up.tolist(), sideways=sideways.tolist(),
                hookSign=sign, hookRotationConsistent=consistent, forwardAgreement=agreement if count > 1 else None,
                calibrationPolicy=policy, straightTrials=len(forwards), hookTrials=len(yaw),
                quietAccelP95G=float(noise), quietGyroP95RadS=float(spin), hookOnsetYawRadS=yaw,
                hookCalibrationMethod=cfg.hook_calibration_method, hookDirectionEvidence=evidence,
                hookDirectionTrialPassed=passed,
                warnings=[] if consistent else ['Hook calibration inconsistent/insufficient; repeat the indicated hook trials.'],
                coordinateConvention='Hamilton xyzw device-to-reference; sideways = up cross forward',
                accelBiasReferenceG=np.mean([s['a'] for s in quiet], axis=0).tolist(),
                thresholdFit=False)
