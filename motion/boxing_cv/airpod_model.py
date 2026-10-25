import math, time
def host_delay_ms(end, start):
    """Unknown/invalid clock pairs stay unknown, rather than becoming zero."""
    if (not isinstance(end, (float, int)) or not isinstance(start, (float, int)) or
            not math.isfinite(end) or not math.isfinite(start) or end < start):
        return None
    return end-start

class _ModelExperimentMixin:
    detector_type = None
    def __init__(self, *args, model_path, **kwargs):
        kwargs['require_complete_hook_calibration'] = False
        super().__init__(*args, **kwargs)
        self.detector = self.detector_type(model_path, self.hand, self.cfg)
        self._confirmation_start = None
        self.last_model_event = None

    def prompt(self, now):
        if self.calibrating or self.trial or not self.sensor_ready(now):
            return super().prompt(now)
        status = 'ARMED' if self.detector.armed else 'WAITING for confident non-punch to arm'
        return f'MODEL DETECTION: {status}. 1 straight | 2 hook | 3 twist | 4/5 dodge | 6 flick. R recalibrates.'

    def handle(self, entry):
        started = time.perf_counter()
        received = entry.get('row', {}).get('receiveUnixMs', entry['nowUnixMs']) if isinstance(entry.get('row', {}), dict) else entry['nowUnixMs']
        self.detector.emission_enabled = not self.calibrating and (
            not self.trial or self.trial['startUnixMs'] <= received <= self.trial['endUnixMs'])
        results = super().handle(entry)
        completed = entry['nowUnixMs']+(time.perf_counter()-started)*1000
        if (self.calibrating or self.sensor_state != 'fresh' or any(r['kind'] in
                ('trial_started', 'trial_finished', 'trial_cancelled', 'calibration_invalidated', 'profile') for r in results)):
            self._confirmation_start = None
        # Process diagnostic evidence first: the base engine returns its event
        # before the feature row. Cached predictions must not restart the timer.
        for result in results:
            if result['kind'] != 'imu_features':
                continue
            result['inputToDecisionMs'] = host_delay_ms(completed, result.get('receiveUnixMs'))
            if not result.get('predictionFresh'):
                continue
            label, count = result.get('classification'), result.get('confirmationCount', 0)
            if (not result.get('emissionEnabled') or label not in ('straight', 'hook') or count < 1):
                self._confirmation_start = None
            elif count == 1:
                self._confirmation_start = (label, completed)
        for result in results:
            if result['kind'] == 'event':
                result.pop('onsetSensorTimestampSec', None)
                result['onsetMs'] = None
                result['timestampBasis'] = 'Latest IMU callback receipt and model decision; physical onset unknown'
                result['qualityKind'] = 'model_softmax_not_calibrated_accuracy'
                result['detectedUnixMs'] = completed
                result['detectedMs'] = round(completed-self.origin_unix_ms)
                candidate = self._confirmation_start
                first = candidate[1] if candidate and candidate[0] == result['punchType'] else None
                result.update(receiptToEventMs=host_delay_ms(completed, result.get('sensorReceiveUnixMs')),
                              firstQualifyingPredictionUnixMs=first,
                              confirmationToEventMs=host_delay_ms(completed, first),
                              physicalCompletionToEventMs=None,
                              latencyBasis='Host callback receipt / first qualifying prediction to decision; excludes unknown Bluetooth and physical completion delay')
                result['features'].update({k: result[k] for k in
                    ('receiptToEventMs', 'confirmationToEventMs', 'physicalCompletionToEventMs')})
                self.last_model_event = result
                self._confirmation_start = None
            elif result['kind'] == 'imu_features':
                result['decisionUnixMs'] = completed
            elif result['kind'] == 'profile':
                result['profile']['legacyHookEvidenceUsedForDetection'] = False
                result['profile']['warnings'] = []
        return results

    def finish_reviews(self):
        # Never run the legacy punch detector in model mode, even for diagnostics.
        self.pending_reviews = []
        return iter(())
