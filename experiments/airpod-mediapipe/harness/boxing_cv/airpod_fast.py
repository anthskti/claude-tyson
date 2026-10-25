"""Opt-in demo-only early prediction; original outward mode remains the default."""
from .airpod_outward import OutwardDetector, _OutwardMixin
from .calibrated_experiment import Experiment
from .model_bundle import FAST_TARGET
from .outward_models import REGISTRY

FAST_REGISTRY = REGISTRY.with_name('fast-pairs.json')


class FastDetector(OutwardDetector):
    target = FAST_TARGET
    punch_evidence = 'imu_fast_demo_model'

    def process(self, sample, pose=None):
        features, event = super().process(sample, pose)
        features['fastDemoMode'] = True
        if event:
            event['features']['fastDemoMode'] = True
        return features, event


class FastExperiment(_OutwardMixin, Experiment):
    detector_type = FastDetector
    registry = FAST_REGISTRY
    display_name = 'FAST DEMO'
