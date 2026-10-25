"""Separate outward target with the existing consumable priority-buffer policy."""
from .airpod_buffered import BufferedDetector, _BufferedMixin
from .calibrated_experiment import Experiment
from .model_bundle import TARGET, load_model
from .outward_models import REGISTRY, resolve_model


class OutwardDetector(BufferedDetector):
    punch_evidence = 'imu_outward_model'
    target = TARGET

    def load_bundle(self, model_path, hand):
        return load_model(model_path, hand, target=self.target)

    def metadata(self):
        result = super().metadata()
        result.update(modelType='outward_gru', selected='outward_gru', targetMeaning=self.target,
                      annotationVersion=self.info['annotationVersion'],
                      scope=self.info.get('scope', 'First outward-turnaround proxy; no requirement for full gesture settling'),
                      demoOnly=self.info.get('demoOnly', False))
        return result

    def process(self, sample, pose=None):
        features, event = super().process(sample, pose)
        features.update(outwardMode=True, targetMeaning=self.target)
        if event:
            event['targetMeaning'] = self.target
            event['features'].update(outwardMode=True, targetMeaning=self.target)
        return features, event


class _OutwardMixin(_BufferedMixin):
    detector_type = OutwardDetector
    registry = REGISTRY
    display_name = 'STATEFUL OUTWARD'

    def __init__(self, settings, bud='left', *args, model_path=None, **kwargs):
        selected = resolve_model(kwargs.get('hand', 'left'), bud, model_path, self.registry)
        super().__init__(settings, bud, *args, model_path=selected, **kwargs)

    def prompt(self, now):
        prompt = super().prompt(now).replace('BUFFERED COMPLETION:', self.display_name+':')
        return prompt.replace('AIRPOD DATA', 'IPHONE DATA') if self.source_type == 'iphone' else prompt


class OutwardExperiment(_OutwardMixin, Experiment):
    pass
