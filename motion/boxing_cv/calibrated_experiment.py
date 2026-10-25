"""Replayable calibration/label flow. All commands, clocks and raw rows are inputs."""
from collections import Counter
import math
import numpy as np
from .calibrated_airpod import build_profile, sample, matches_source

LABELS = {'1': 'straight', '2': 'hook', '3': 'wrist_twist', '4': 'dodge_side', '5': 'dodge_turn', '6': 'short_flick'}
PLAN = ['quiet'] + ['straight']*3 + ['hook']*3
LEGACY_PLAN = ['quiet'] + [LABELS[key] for key in '12345' for _ in range(3)]
INSTRUCTIONS = {
    'quiet': 'Hold guard STILL for the whole recording.',
    'straight': 'One LEFT straight toward camera, then return to guard.',
    'hook': 'One smooth LEFT horizontal hook; pause briefly at the end, then return.',
    'wrist_twist': 'One outward LEFT wrist flick/twist. Keep arm/torso still.',
    'dodge_side': 'One sideways dodge; keep fists in guard. Alternate sides.',
    'dodge_turn': 'One torso-turning dodge with fists in guard.',
    'short_flick': 'One sharp, SHORT forward fist flick. This should NOT count as a punch.',
}


class Experiment:
    def __init__(self, settings, bud='left', session='experiment', origin_unix_ms=0, calibration_plan=None, require_fresh_start=True, defer_reviews=False, require_complete_hook_calibration=True, hand='left', calibration_policy='standard'):
        if hand not in ('left', 'right') or bud not in ('left', 'right'):
            raise ValueError('Punching hand and physical earbud must each be left or right')
        self.hand = hand
        self.source_type = 'airpod'
        self.cfg, self.bud, self.session = settings, bud, session
        self.origin_unix_ms = origin_unix_ms
        self.require_fresh_start = require_fresh_start
        self.require_complete_hook_calibration = require_complete_hook_calibration
        self.notice = None
        self.defer_reviews = defer_reviews
        self.pending_reviews = []
        self.plan = list((['quiet', 'straight', 'hook'] if calibration_policy == 'quick' else PLAN) if calibration_plan is None else calibration_plan)
        self.detector = None  # installed by the model mixin before any inputs
        self.calibration_policy = calibration_policy
        self.pose = None
        self.sensor_session = self.last_t = None
        self.trials = []
        self.trial = None
        self.calibrating = True
        self.profile_revision = 0
        self.event_count = 0
        self.trial_count = 0
        self.last_features = {}
        self.sensor_state = 'waiting'
        self.last_receive = None

    def sensor_ready(self, now):
        return (self.sensor_state == 'fresh' and self.last_receive is not None
                and 0 <= now-self.last_receive <= self.cfg.max_age_ms)

    def instruction(self, label):
        return INSTRUCTIONS[label].replace('LEFT', self.hand.upper())

    def prompt(self, now):
        if not self.trial and self.require_fresh_start and not self.sensor_ready(now):
            return 'WAITING FOR LIVE AIRPOD DATA. Start collector and check --airpod-log. Trials are disabled.'
        if self.trial:
            if now < self.trial['startUnixMs']:
                return f"GET READY {max(1, math.ceil((self.trial['startUnixMs']-now)/1000))}: " + self.instruction(self.trial['label'])
            return f"RECORDING {max(0, (self.trial['endUnixMs']-now)/1000):.1f}s: " + self.instruction(self.trial['label'])
        if self.calibrating:
            return (self.notice+' ' if self.notice else '') + f"CAL {len(self.trials)+1}/{len(self.plan)}: SPACE when ready. " + self.instruction(self.plan[len(self.trials)])
        if not self.detector.profile or not self.detector.profile['hookRotationConsistent']:
            return 'HOOKS DISABLED: hook calibration incomplete/inconsistent. Press R to recalibrate.'
        return 'DETECTION ON: STRAIGHTS + HOOKS. Tests: 1 straight | 2 hook | 3 twist | 4 side dodge | 5 turning dodge | 6 flick.'

    def retry_hooks(self, profile):
        """Keep two agreeing hooks when available; otherwise redo the hook set.

        Never enable hooks using a majority vote alone: all three retained/new
        trials must agree before a usable profile is installed.
        """
        passed = profile['hookDirectionTrialPassed']
        keep = passed if sum(passed) >= 2 else [False]*3
        hook_trials = [tr for tr in self.trials if tr['label'] == 'hook']
        rejected = [tr['id'] for tr, ok in zip(hook_trials, keep) if not ok]
        self.trials = [tr for tr in self.trials if tr['id'] not in rejected]
        self.plan = [tr['label'] for tr in self.trials] + ['hook']*len(rejected)
        self.detector.profile = None
        self.detector.reset()
        self.notice = f'HOOK CALIBRATION NEEDS {len(rejected)} REPEAT(S); earlier valid trials kept.'
        return dict(kind='calibration_retry', reason='hook_direction_inconsistent_or_insufficient',
                    retryLabel='hook', retryCount=len(rejected), rejectedTrialIds=rejected,
                    keptTrialIds=[tr['id'] for tr in self.trials],
                    hookCalibrationMethod=profile['hookCalibrationMethod'],
                    hookOnsetYawRadS=profile['hookOnsetYawRadS'],
                    hookDirectionEvidence=profile['hookDirectionEvidence'], message=self.notice)

    def invalidate(self, reason, calibration=False):
        self.detector.reset()
        self.sensor_state = reason
        output = []
        if self.trial:
            self.trial['invalidReason'] = reason
        if calibration:
            self.notice = None
            self.detector.profile = None
            self.trials = []
            self.calibrating = True
            self.trial = None
            output.append(dict(kind='calibration_invalidated', reason=reason))
        return output

    def handle(self, entry):
        now = entry['nowUnixMs']
        kind = entry['kind']
        output = []
        if kind == 'command':
            key = entry['key']
            if key == 'r':
                return self.invalidate('manual_reset', calibration=True)
            if key == 'x':
                self.trial = None
                self.detector.reset()
                return [dict(kind='trial_cancelled')]
            if self.trial:
                return []
            label = self.plan[len(self.trials)] if self.calibrating and key == 'space' else None
            if not self.calibrating:
                label = LABELS.get(key) or (getattr(self, 'last_label', 'straight') if key == 'space' else None)
            if label:
                if self.require_fresh_start and not self.sensor_ready(now):
                    return [dict(kind='trial_blocked', reason='no_fresh_sensor_data', sensorState=self.sensor_state,
                                 message='No live AirPod data. Start the collector and point --airpod-log at its current motion.jsonl.')]
                self.notice = None
                self.last_label = label
                self.trial_count += 1
                self.trial = dict(id=self.trial_count, label=label, split='calibration' if self.calibrating else 'validation',
                                  startUnixMs=now+2000, endUnixMs=now+4000, samples=[], events=[], features=[])
                # Do not carry a gesture from the previous trial into this one.
                self.detector.reset()
                output.append(dict(kind='trial_started', **{k: v for k, v in self.trial.items() if k not in ('samples', 'features', 'events')}))
        elif kind == 'pose':
            # UI freshness only. No wrist features or pose evidence enter punches.
            self.pose = dict(receiveUnixMs=now, valid=bool(entry['record'].get('pose')))
        elif kind == 'imu':
            row = entry['row']
            if not isinstance(row, dict):
                return self.invalidate('malformed')
            row_kind = row.get('kind')
            if row_kind != 'sample':
                state = str(row.get('state', row_kind))
                # A reconnection/new source may reset the orientation reference.
                return self.invalidate(state, calibration=row_kind in ('status', 'metadata'))
            try:
                s = sample(row, self.bud, now, self.cfg.max_age_ms, self.source_type)
            except ValueError as error:
                reason = str(error)
                output.extend(self.invalidate(reason, calibration=not matches_source(row, self.bud, self.source_type)))
                output.append(dict(kind='sensor_rejected', reason=reason, sequence=row.get('sequence')))
                return output
            if self.sensor_session != s['sessionId']:
                if self.sensor_session is not None:
                    output.extend(self.invalidate('new_sensor_session', calibration=True))
                self.sensor_session, self.last_t = s['sessionId'], None
                self.detector.last_fire = -1e30
            if self.last_t is not None:
                if s['t'] <= self.last_t:
                    output.extend(self.invalidate('nonincreasing_sensor_time'))
                    output.append(dict(kind='sensor_rejected', reason='nonincreasing_sensor_time', sequence=s['sequence']))
                    return output
                if s['t']-self.last_t > self.cfg.max_gap_ms:
                    output.extend(self.invalidate('sensor_gap'))
            self.last_t, self.last_receive, self.sensor_state = s['t'], s['received'], 'fresh'
            features, event = self.detector.process(s)
            if features['state'] == 'orientation_inconsistent':
                return self.invalidate('orientation_reference_changed', calibration=True)
            trial = self.trial
            collecting = trial and trial['startUnixMs'] <= s['received'] <= trial['endUnixMs']
            if collecting:
                trial['samples'].append(s)
                trial['features'].append(features)
            # Candidate features during all states; accepted punches only outside calibration/countdown.
            allowed = not self.calibrating and (not trial or collecting)
            if event and allowed:
                self.event_count += 1
                event.update(kind='event', schemaVersion=2, eventId=f'{self.session}-imu-{self.event_count:06d}',
                             sessionId=self.session, sideConvention='player_anatomical',
                             trackingState='imu_valid', qualityScore=None, qualityKind='not_estimated',
                             calibrationId=f'{self.session}-imu-cal-{self.profile_revision}',
                             detectedUnixMs=now,
                             sampleMs=round(s['received']-self.origin_unix_ms),
                             detectedMs=round(now-self.origin_unix_ms),
                             onsetMs=round(s['received']-self.origin_unix_ms-(s['t']-event['onsetSensorTimestampSec']*1000)),
                             timestampBasis='sensor receipt aligned to host session; not physical onset',
                             trialId=trial['id'] if collecting else None)
                output.append(event)
                if collecting:
                    trial['events'].append(event['punchType'])
            features = dict(features, kind='imu_features', sequence=s['sequence'], sensorTimestampSec=s['t']/1000,
                            receiveUnixMs=s['received'], decisionUnixMs=now, trialId=trial['id'] if collecting else None,
                            label=trial['label'] if collecting else None, split=trial['split'] if collecting else 'free',
                            emissionEnabled=bool(allowed), referenceAccelerationG=s['a'].tolist(),
                            referenceRotationRadS=s['w'].tolist())
            self.last_features = features
            output.append(features)
        elif kind == 'tick':
            if self.last_receive is not None and now-self.last_receive > self.cfg.max_age_ms:
                if self.sensor_state != 'stale':
                    output.extend(self.invalidate('stale'))
            if self.trial and now >= self.trial['endUnixMs']:
                tr, self.trial = self.trial, None
                rows = tr['samples']
                duration = rows[-1]['t']-rows[0]['t'] if len(rows) > 1 else 0
                valid = 'invalidReason' not in tr and len(rows) >= 20 and duration >= 1400
                summary = dict(kind='trial_finished', **{k: v for k, v in tr.items() if k not in ('samples', 'features')},
                               valid=valid, sampleCount=len(rows), sensorSpanMs=duration,
                               peakAccelG=max((float(np.linalg.norm(s['a'])) for s in rows), default=None),
                               peakGyroRadS=max((float(np.linalg.norm(s['w'])) for s in rows), default=None),
                               predictions=dict(Counter(tr['events'])),
                               maxYawRad=max((abs(f.get('signedYawRad', 0)) for f in tr['features']), default=None),
                               maxForwardG=max((f.get('forwardPeakG', 0) for f in tr['features']), default=None))
                if not valid:
                    summary['invalidReason'] = tr.get('invalidReason') or ('no_samples' if not rows else
                        'insufficient_samples' if len(rows) < 20 else 'insufficient_sensor_coverage')
                    self.notice = f"RETRY: {summary['invalidReason']} ({len(rows)} samples)."
                output.append(summary)
                if self.calibrating and valid:
                    self.trials.append(tr)
                    if len(self.trials) == len(self.plan):
                        try:
                            profile = build_profile(self.trials, self.cfg, hand=self.hand, policy=self.calibration_policy)
                        except ValueError as error:
                            output.append(dict(kind='calibration_failed', reason=str(error)))
                            self.trials = []
                        else:
                            if self.require_complete_hook_calibration and not profile['hookRotationConsistent']:
                                output.append(self.retry_hooks(profile))
                                return output
                            self.profile_revision += 1
                            self.detector.profile = profile
                            self.detector.reset()
                            self.calibrating = False
                            output.append(dict(kind='profile', calibrationId=f'{self.session}-imu-cal-{self.profile_revision}',
                                               sensorSessionId=self.sensor_session, profile=profile))
                            self.pending_reviews.append((profile, list(self.trials)))
                            if not self.defer_reviews:
                                output.extend(self.finish_reviews())
                self.detector.reset()
        return output


    def finish_reviews(self):
        self.pending_reviews = []
        return iter(())
