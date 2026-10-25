import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
import torch

from boxing_cv.airpod_fast import FAST_REGISTRY, FastDetector
from boxing_cv.calibrated_airpod import Settings
from boxing_cv.dual_airpod import build_engines
from boxing_cv.game_bridge import GameState
from boxing_cv.model_bundle import FAST_TARGET, load_model
from boxing_cv.outward_models import resolve_model


def test_fast_bundles_are_separate_and_default_hashes_unchanged():
    original_hashes={
        'left':'bfe98d1f69f3b91260e855a06bf1a57773364cb691c8e7a1a83ad99403a0f3fa',
        'right':'7966be091a3074b415c56c0447fbf587973c09162a8385893966652dcb562a25'}
    for side in ('left','right'):
        original=resolve_model(side,side)
        fast=resolve_model(side,side,registry=FAST_REGISTRY)
        assert original != fast
        assert hashlib.sha256((original/'weights.pt').read_bytes()).hexdigest()==original_hashes[side]
        model,info=load_model(fast,side,target=FAST_TARGET)
        assert info['baseModel']['weightsSha256']==original_hashes[side]
        assert info['eventPolicy']['confirmations']==1
        assert info['demoOnly'] and info['override'] is None
        with pytest.raises(ValueError):load_model(fast,side)
        with pytest.raises(ValueError):load_model(original,side,target=FAST_TARGET)
        with pytest.raises(ValueError):load_model(fast,'right' if side=='left' else 'left',target=FAST_TARGET)
        second,_=load_model(fast,side,target=FAST_TARGET)
        values=torch.zeros(2,15,6);mask=torch.ones(2,15,dtype=torch.bool)
        with torch.inference_mode():
            assert torch.equal(model(values,mask)[0],second(values,mask)[0])


def test_fast_engines_keep_quick_calibration_and_publish_real_mode():
    engines=build_engines(Settings(),'test',0,fast=True)
    for side,e in engines.items():
        assert isinstance(e.detector,FastDetector)
        assert e.detector.hand==e.hand==e.bud==side
        assert e.detector.metadata()['targetMeaning']==FAST_TARGET
        assert e.detector.metadata()['demoOnly'] is True
        assert Path(e.detector.model_path)==resolve_model(side,side,registry=FAST_REGISTRY)
    assert GameState('s',0).sample(0)['status']['modelMode']=='outward'
    assert GameState('s',0,model_mode='fast').sample(0)['status']['modelMode']=='fast'
    with pytest.raises(ValueError):GameState('s',0,model_mode='unknown')


def test_fast_live_predict_matches_frozen_model_and_consumes_history():
    d=FastDetector(resolve_model('left','left',registry=FAST_REGISTRY),'left',Settings())
    d.profile=dict(hand='left',forward=np.array([1.,0,0]),sideways=np.array([0.,1,0]),
        up=np.array([0.,0,1]),accelBiasReferenceG=np.zeros(3))
    physical=np.zeros((6,6),np.float32)
    for i,v in enumerate(physical):
        features,event=d.process(dict(t=i*40.,up=d.profile['up'],a=v[:3],w=v[3:],ageMs=0,received=0,sequence=i))
        assert features['fastDemoMode'] and features['targetMeaning']==FAST_TARGET
    normalized=((physical-d.info['normalization']['mean'])/d.info['normalization']['scale']).astype(np.float32)
    with torch.inference_mode():
        logits,_=d.model(torch.from_numpy(normalized[None]),torch.ones(1,6,dtype=torch.bool))
        expected=logits.softmax(-1)[0,-1].numpy()
    assert np.allclose(list(features['probabilities'].values()),expected,atol=1e-6)
    consumed=d.consume(200.)
    assert consumed['consumedSamples']==6 and not len(d.history)
