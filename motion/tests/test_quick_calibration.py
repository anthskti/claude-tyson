import numpy as np
import pytest
from boxing_cv.calibrated_airpod import Settings, build_profile
from boxing_cv.airpod_outward import OutwardExperiment


def trials(count=1,hand='left'):
    def rows(label):
        result=[]
        for i in range(50):
            a=[.8,0,0] if label=='straight' and 8<=i<13 else [0,0,0]
            result.append(dict(t=i*40,a=np.array(a),w=np.zeros(3),up=np.array([0,0,1])))
        return result
    return [dict(label='quiet',samples=rows('quiet'))]+[dict(label='straight',samples=rows('straight')) for _ in range(count)]+[dict(label='hook',samples=rows('hook')) for _ in range(count)]


def test_quick_axes_and_hook_diagnostics_are_not_classifier_gates():
    p=build_profile(trials(),Settings(),policy='quick')
    assert p['forwardAgreement'] is None  # single trial is not an agreement measurement
    assert p['forward']==[1,0,0] and p['sideways']==[0,1,0] and p['up']==[0,0,1]
    assert p['hookTrials']==1 and not p['hookRotationConsistent']
    assert not p['thresholdFit']
    with pytest.raises(ValueError,match='need_3_straights'):build_profile(trials())
    with pytest.raises(ValueError,match='need_1_hooks'):build_profile(trials()[:-1],policy='quick')
    standard=build_profile(trials(3))
    assert standard['forward']==p['forward'] and standard['forwardAgreement']==1


def test_rest_and_direction_quality_are_still_required():
    t=trials()
    for s in t[0]['samples']:s['a']=np.ones(3)
    with pytest.raises(ValueError,match='not_still'):build_profile(t,policy='quick')
    t=trials()
    for s in t[1]['samples']:s['a']=np.array([0,0,1.])
    with pytest.raises(ValueError,match='vertical'):build_profile(t,policy='quick')


@pytest.mark.parametrize('side',['left','right'])
def test_exactly_three_trials_enable_live_model_without_hook_gate(side):
    e=OutwardExperiment(Settings(),side,'flow-'+side,100000,hand=side,calibration_policy='quick')
    index=0;results=[]
    def feed(a=0):
        nonlocal index
        now=100000+index*40
        row=dict(kind='sample',sessionId=side,sequence=index,sensorLocation=side,
            sensorTimestampSec=index*.04,receiveUnixMs=now,userAcceleration=dict(x=a,y=0,z=0),
            rotationRate=dict(x=0,y=0,z=0),gravity=dict(x=0,y=0,z=-1),attitude=dict(x=0,y=0,z=0,w=1))
        results.extend(e.handle(dict(kind='imu',row=row,nowUnixMs=now)))
        results.extend(e.handle(dict(kind='tick',nowUnixMs=now)))
        index+=1
    feed()
    for label in ['quiet','straight','hook']:
        now=100000+(index-1)*40
        results.extend(e.handle(dict(kind='command',key='space',nowUnixMs=now)))
        assert e.trial['label']==label
        start=e.trial['startUnixMs']
        for _ in range(100):
            now=100000+index*40
            feed(.8 if label=='straight' and start+160<=now<start+360 else 0)
    assert len([r for r in results if r['kind']=='trial_finished' and r['valid']])==3
    assert not e.calibrating and e.detector.profile is not None
    assert not e.detector.profile['legacyHookEvidenceUsedForDetection']
    assert 'MODEL DETECTION' not in e.prompt(100000+(index-1)*40) # outward prompt installed
    feed();feed()
    assert e.last_features['predictionFresh']
    assert e.detector.info['punchingHand']==side
