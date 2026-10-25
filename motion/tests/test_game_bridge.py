import json
import socket
from threading import Event
import time
import pytest
from boxing_cv.game_bridge import GameState, GameBridge


def pose(t=1000):
    return dict(timestampMs=t, trackingState='good',validity=dict(dodge=True),calibrationId='head',
                features=dict(lateralDisplacementBodyWidths=0),markers={'head':{'x':.5,'y':.3}},
                pose=dict(body='neutral',guards=dict(left='neutral',right='neutral')))


def punch(side='left', t=1000, number=1):
    return dict(eventId=f'{side}-{number}',sessionId='native-'+side,type='punch_'+side,punchType='hook',
        sampleMs=t,detectedMs=t,detectedUnixMs=t,qualityKind='model_softmax_not_calibrated_accuracy',
        calibrationId='cal-'+side,features={},receiptToEventMs=2)


def ready(state,t=1000):
    state.update_pose(pose(t))
    for side in ('left','right'):
        state.update_side(side,dict(sensorState='fresh',receivedUnixMs=t,calibrated=True,inferenceState='prediction'))


def test_canonical_session_full_class_mapping_and_no_hand_markers():
    state=GameState('root',0);state.connect(True);ready(state)
    state.punch('left',punch());state.punch('right',punch('right'))
    packet=state.sample(1010)
    assert packet['status']['ready']
    assert [e['punchType'] for e in packet['events']]==['left_hook','right_hook']
    assert all(e['sessionId']=='root' and e['qualityScore'] is None and e['onsetMs'] is None for e in packet['events'])
    assert packet['events'][0]['features']['nativeSessionId']=='native-left'
    assert set(packet['observation']['markers'])=={'head'}
    assert state.sample(1020)['events']==[]


def test_independent_loss_recalibration_and_pose_freshness():
    state=GameState('root',0);state.connect(True);ready(state)
    state.update_side('right',dict(sensorState='usb_disconnected',receivedUnixMs=1000,calibrated=False))
    state.punch('left',punch());state.punch('right',punch('right'))
    p=state.sample(1020)
    assert p['observation']['trackingState']=='degraded'
    assert p['observation']['validity']==dict(dodge=True,punch_left=True,punch_right=False)
    assert [e['type'] for e in p['events']]==['punch_left']
    assert not p['status']['ready']
    p=state.sample(1250)
    assert p['observation']['trackingState']=='lost' and not any(p['observation']['validity'].values())
    assert p['observation']['pose']['body']=='neutral'


def test_offline_backlog_stale_events_and_overflow_fail_closed():
    state=GameState('root',0,max_events=2);ready(state)
    state.punch('left',punch());state.connect(True)
    assert not state.sample(1010)['events']
    for i in range(3):state.punch('left',punch(number=i))
    p=state.sample(1010)
    assert p['status']['overflow'] and not p['events'] and not any(p['observation']['validity'].values())
    state.connect(False);state.connect(True);ready(state,1200)
    state.punch('left',punch(t=1000))
    assert not state.sample(1200)['events']
    with pytest.raises(ValueError):state.punch('left',punch('right'))


def test_websocket_origin_single_client_ping_disconnect_and_no_replay():
    from websockets.sync.client import connect
    from websockets.exceptions import InvalidStatus,ConnectionClosed
    with socket.socket() as probe:probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
    camera=Event();b=GameBridge('root',time.time()*1000,camera,port).start()
    try:
        with pytest.raises(InvalidStatus):connect(f'ws://127.0.0.1:{port}',origin='https://untrusted.example')
        with connect(f'ws://127.0.0.1:{port}',origin='http://localhost:3001') as ws:
            assert json.loads(ws.recv())['kind']=='motion_hello'
            assert camera.is_set()
            ws.send(json.dumps(dict(kind='ping',id=7)))
            while True:
                p=json.loads(ws.recv(timeout=2))
                if p['kind']=='pong':break
            assert p['id']==7 and p['hostUnixMs']>0
            with connect(f'ws://127.0.0.1:{port}',origin='http://localhost:3001') as second:
                with pytest.raises(ConnectionClosed):second.recv(timeout=2)
        deadline=time.monotonic()+2
        while b.state.connected and time.monotonic()<deadline:time.sleep(.01)
        assert not b.state.connected and not camera.is_set()
    finally:b.close()
