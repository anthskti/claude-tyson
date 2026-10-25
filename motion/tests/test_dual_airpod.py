from dataclasses import asdict
from io import StringIO
import json
from pathlib import Path
from queue import Queue, Empty
from threading import Event, Thread
from types import SimpleNamespace
import time

import numpy as np
import pytest
import torch

from boxing_cv.calibrated_airpod import Settings
from boxing_cv.calibrated_runtime import SensorLoop, AsyncLogs
from boxing_cv.dual_airpod import input_paths, source_types, SideSink, build_engines, draw_dual
from boxing_cv.imu_stateful import EventSettings


def test_two_inputs_must_be_distinct_files_including_aliases(tmp_path):
    left=tmp_path/'left.jsonl';right=tmp_path/'right.jsonl'
    left.touch();right.touch()
    assert input_paths(left=left,right=right)==dict(left=left,right=right)
    alias=tmp_path/'alias';alias.symlink_to(left)
    with pytest.raises(ValueError,match='different source'):input_paths(left=left,right=alias)
    manifest=tmp_path/'streams.json';manifest.write_text(json.dumps(dict(left=left.name,right=right.name)))
    assert input_paths(manifest)==dict(left=left,right=right)
    with pytest.raises(ValueError):input_paths(manifest,left,right)
    with pytest.raises(ValueError):input_paths(left=left)


@pytest.fixture(params=[False, True], ids=["outward", "fast"])
def engines(monkeypatch, request):
    import boxing_cv.airpod_outward as live
    class ControlledModel:
        def step(self,x,valid,state=None):
            motion=float(x[0,0]);p=[.99,.005,.005] if motion==0 else [.005,.99,.005] if motion>0 else [.005,.005,.99]
            return torch.log(torch.tensor([p])),None
    def load(path,hand, *, target=None):
        return ControlledModel(),dict(eventPolicy=asdict(EventSettings(confirmations=2)),
            normalization=dict(mean=[0]*6,scale=[1]*6),weightsSha256=hand,annotationVersion='test',
            stream=dict(shortGapMaxMs=200,recoveryValidSamples=2),channelNames=[],classes=[])
    monkeypatch.setattr(live,'load_model',load)
    monkeypatch.setattr(live,'resolve_model',lambda hand,bud,explicit=None,registry=None:Path('/tmp')/hand)
    result=build_engines(Settings(),'pair',100000,fast=request.param)
    for side,e in result.items():
        e.detector.profile=dict(hand=side,forward=[1,0,0],sideways=[0,1,0],up=[0,0,1],accelBiasReferenceG=[0,0,0])
        e.calibrating=False
    return result


def row(side,index,motion=0,now=None):
    return dict(kind='sample',sessionId=side+'-source',sequence=index,sensorLocation=side,
        sensorTimestampSec=index*.04,receiveUnixMs=100000+index*40 if now is None else now,
        userAcceleration=dict(x=motion,y=0,z=0),rotationRate=dict(x=0,y=0,z=0),
        gravity=dict(x=0,y=0,z=-1),attitude=dict(x=0,y=0,z=0,w=1))


def feed(e,r):return e.handle(dict(kind='imu',row=r,nowUnixMs=r['receiveUnixMs']))


def test_interleaved_punches_do_not_share_history_or_cooldown(engines):
    left,right=engines['left'],engines['right']
    assert left.detector.model is not right.detector.model
    for i in range(4):
        feed(left,row('left',i));feed(right,row('right',i))
    feed(left,row('left',4,1));events=feed(left,row('left',5,1))
    event=next(x for x in events if x['kind']=='event')
    assert event['type']=='punch_left' and event['punchType']=='straight'
    assert len(left.detector.history)==0 and len(right.detector.history)==4
    # Right can fire at the same sensor times despite left's active cooldown.
    feed(right,row('right',4,-1));events=feed(right,row('right',5,-1))
    event2=next(x for x in events if x['kind']=='event')
    assert event2['type']=='punch_right' and event2['punchType']=='hook'
    assert event2['eventId']!=event['eventId'] and event2['sampleMs']==event['sampleMs']
    left.handle(dict(kind='command',key='r',nowUnixMs=100250))
    assert left.detector.profile is None and right.detector.profile is not None


def test_wrong_side_source_never_becomes_other_hand_punch(engines):
    right=engines['right'];original_left_profile=engines['left'].detector.profile
    for i in range(8):
        results=feed(right,row('left',i,1))
        assert not any(x['kind']=='event' for x in results)
    assert right.detector.profile is None
    assert engines['left'].detector.profile is original_left_profile


def test_gap_on_one_side_does_not_reset_the_other(engines):
    for i in range(4):
        for side,e in engines.items():feed(e,row(side,i))
    feed(engines['left'],row('left',20))
    assert len(engines['left'].detector.history)==1
    assert len(engines['right'].detector.history)==4 and engines['right'].detector.armed


class Tail:
    def __init__(self):self.rows=Queue()
    def poll(self):
        result=[]
        while True:
            try:result.append(self.rows.get_nowait())
            except Empty:return result


def test_two_sensor_threads_route_to_one_event_log_without_ui(engines):
    stop=Event();combined_file=StringIO();combined=AsyncLogs({'events.jsonl':combined_file})
    local={};loops={};tails={}
    for side in ('left','right'):
        files={n:StringIO() for n in ['timeline.jsonl','diagnostics.jsonl','events.jsonl','trials.jsonl','raw-motion.jsonl']}
        local[side]=AsyncLogs(files);tails[side]=Tail()
        loops[side]=SensorLoop(engines[side],tails[side],SideSink(side,local[side],combined),stop).start()
    try:
        for i in range(8):
            now=time.time()*1000
            for side in ('left','right'):
                motion=0 if i<4 else 1 if side=='left' else -1
                tails[side].rows.put(row(side,i,motion,now))
            stop.wait(.04)
        deadline=time.monotonic()+2
        while any(loop.samples<8 for loop in loops.values()) and time.monotonic()<deadline:stop.wait(.005)
        assert all(loop.samples==8 and not loop.error for loop in loops.values())
        assert all(loop.snapshot.last_model_event is not None for loop in loops.values())
    finally:
        stop.set()
        for loop in loops.values():loop.thread.join(2)
        for sink in local.values():sink.close()
        combined.close()
    events=[json.loads(line) for line in combined_file.getvalue().splitlines()]
    assert {e['type'] for e in events}=={'punch_left','punch_right'}
    assert len(events)==2 and len({e['eventId'] for e in events})==2
    assert all(e['inputStream']==e['punchingHand']==e['earbud'] for e in events)
    # Both snapshot panels render without needing a camera or native window.
    image=draw_dual(np.zeros((480,640,3),np.uint8),{s:l.snapshot for s,l in loops.items()},'right',time.time()*1000,events)
    assert image.shape==(900,1200,3)


def test_real_models_are_loaded_independently():
    root=Path(__file__).resolve().parents[1]
    if not (root/'models/outward-pairs.json').exists():pytest.skip('Local weights not supplied')
    e=build_engines(Settings(),'real',0)
    assert e['left'].detector.info['punchingHand']=='left'
    assert e['right'].detector.info['punchingHand']=='right'
    assert e['left'].detector.info['weightsSha256']!=e['right'].detector.info['weightsSha256']
    assert e['left'].detector.history is not e['right'].detector.history


@pytest.mark.parametrize('right_source',['airpod','iphone'])
def test_complete_dual_runner_with_two_live_files_and_one_mock_camera(tmp_path,monkeypatch,engines,right_source):
    """Exercise startup, real file tails, worker joins, shared events and reports."""
    import cv2
    from boxing_cv import dual_airpod
    paths={s:tmp_path/(s+'.jsonl') for s in ('left','right')}
    for p in paths.values():p.touch()
    manifest=tmp_path/'streams.json'
    manifest.write_text(json.dumps(dict(left=str(paths['left']),right=str(paths['right']),
                                      sources=dict(left='airpod',right=right_source))))
    producer_stop=Event()
    def produce():
        producer_stop.wait(.1)
        i=0
        while not producer_stop.is_set():
            now=time.time()*1000
            for side,path in paths.items():
                motion=0 if i<10 else 1 if side=='left' else -1
                packet=row(side,i,motion,now)
                if side=='right' and right_source=='iphone':
                    packet.update(sourceType='iphone',sensorLocation='device',punchingHand='right',earbud=None)
                with path.open('a') as f:f.write(json.dumps(packet)+'\n')
            i+=1;producer_stop.wait(.04)
    producer=Thread(target=produce)
    class Camera:
        def __init__(self,*args):self.info={'synthetic':True};self.fps=25;self.finished=False;self.error=None;self.i=0
        def start(self):producer.start();return self
        def take(self,timeout):
            producer_stop.wait(.04);self.i+=1
            if self.i>38:self.finished=True;return None
            return self.i,self.i*40,np.zeros((240,320,3),np.uint8),None
        def close(self):producer_stop.set();producer.join(2)
    class Pose:
        def __init__(self,*args,**kwargs):assert kwargs['hands'] is False
        def process(self,frame,stamp):return dict(timestamp_ms=stamp,width=320,height=240,pose=[],hands=[])
        def close(self):pass
    def factory(settings,session,origin,models,fast=False):
        for e in engines.values():e.origin_unix_ms=origin
        return engines
    monkeypatch.setattr(dual_airpod,'build_engines',factory)
    monkeypatch.setattr('boxing_cv.capture.Capture',Camera)
    monkeypatch.setattr('boxing_cv.inference.Inference',Pose)
    monkeypatch.setattr(cv2,'imshow',lambda *args:None)
    monkeypatch.setattr(cv2,'waitKey',lambda *args:255)
    monkeypatch.setattr(cv2,'getWindowProperty',lambda *args:1)
    monkeypatch.setattr(cv2,'destroyAllWindows',lambda:None)
    a=SimpleNamespace(fast=engines['left'].detector.target=='early_outward_demo_v1',airpod_streams=manifest,airpod_left_log=None,airpod_right_log=None,
        airpod_left_model=None,airpod_right_model=None,headless=False,realtime=False,calibrated_config=None,
        output=tmp_path/'run',record_video=False,models=tmp_path,variant='lite',camera=0,width=320,height=240,
        bridge_port=0,fps=25,input_mirrored=False,no_mirror=False,seconds=0,save_preview=tmp_path/'panel.png')
    dual_airpod.run(a)
    state=json.loads((a.output/'run-state.json').read_text())
    assert state['error'] is None and state['poseFrames']>10
    for side in ('left','right'):
        assert state['streams'][side]['sensorSamples']>=20
        assert (a.output/side/'diagnostics.jsonl').stat().st_size > 0
        rows=[json.loads(line) for line in (a.output/side/'raw-motion.jsonl').read_text().splitlines()]
        assert {r['sensorLocation'] for r in rows}=={'device' if side=='right' and right_source=='iphone' else side}
        assert (a.output/side/'collector-motion.jsonl').exists()
    events=[json.loads(line) for line in (a.output/'events.jsonl').read_text().splitlines()]
    assert {e['type'] for e in events}=={'punch_left','punch_right'}
    right=next(e for e in events if e['type']=='punch_right')
    assert right['sourceType']==right_source
    assert right['earbud']==(None if right_source=='iphone' else 'right')
    meta=json.loads((a.output/'right/metadata.json').read_text())
    assert meta['sourceType']==right_source and meta['modelTrainingSource']=='airpod'
    assert meta['punchMode']==('airpod-stateful-fast' if a.fast else 'airpod-stateful-outward')
    assert not producer.is_alive() and (tmp_path/'panel.png').exists()


def test_usb_relay_diagnostics_reach_right_event_and_preview_only(engines):
    stop=Event();combined_file=StringIO();combined=AsyncLogs({'events.jsonl':combined_file})
    files={n:StringIO() for n in ['timeline.jsonl','diagnostics.jsonl','events.jsonl','trials.jsonl','raw-motion.jsonl']}
    sink=AsyncLogs(files)
    loop=SensorLoop(engines['right'],Tail(),SideSink('right',sink,combined),stop)
    transport=dict(kind='usb',estimatedRelayMs=6,clockUncertaintyMs=2,clockRoundTripMs=4)
    try:
        for i in range(6):
            packet=dict(row('right',i,0 if i<4 else -1),transport=transport)
            loop.feed(dict(kind='imu',row=packet,nowUnixMs=packet['receiveUnixMs']))
        loop._publish(100200)
        event=loop.snapshot.last_model_event
        assert event['type']=='punch_right'
        assert event['transport']==transport
        assert event['estimatedPhoneCallbackToEventMs']==6+event['receiptToEventMs']
        assert loop.snapshot.transport==transport
        assert engines['left'].last_model_event is None
        image=draw_dual(np.zeros((480,640,3),np.uint8),{'right':loop.snapshot},'right',100200,[event])
        assert image.shape==(900,1200,3)
        loop.feed(dict(kind='imu',row=dict(kind='status',state='usb_disconnected'),nowUnixMs=100250))
        loop._publish(100250)
        assert loop.snapshot.transport is None
        assert engines['right'].detector.profile is None
        assert engines['left'].detector.profile is not None
    finally:
        sink.close();combined.close()
    merged=[json.loads(line) for line in combined_file.getvalue().splitlines()]
    assert merged[0]['transport']['estimatedRelayMs']==6


def test_phone_source_manifest_is_explicit_and_only_right(tmp_path):
    manifest=tmp_path/'streams.json'
    manifest.write_text('{}')
    assert source_types(manifest)==dict(left='airpod',right='airpod')
    manifest.write_text(json.dumps(dict(sources=dict(right='iphone'))))
    assert source_types(manifest)==dict(left='airpod',right='iphone')
    manifest.write_text(json.dumps(dict(sources=dict(left='iphone'))))
    with pytest.raises(ValueError):source_types(manifest)


def test_phone_mode_invalidates_calibration_on_wrong_source(engines):
    right=engines['right'];right.source_type='iphone'
    for i in range(4):
        r=dict(row('right',i),sourceType='iphone',sensorLocation='device',punchingHand='right',earbud=None)
        feed(right,r)
    assert right.sensor_state=='fresh' and right.detector.profile is not None
    outputs=feed(right,row('right',4,1))
    assert any(x['kind']=='calibration_invalidated' for x in outputs)
    assert right.detector.profile is None and len(right.detector.history)==0
    assert engines['left'].detector.profile is not None
