import asyncio
import json
from threading import Event

import pytest
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from boxing_cv.companion_config import website_origin, load_pairing
from boxing_cv.game_bridge import GameBridge, GameState


def test_exact_website_origin_and_pairing_file(tmp_path):
    assert website_origin('https://preview.vercel.app/')=='https://preview.vercel.app'
    assert website_origin('https://PREVIEW.vercel.app:443/')=='https://preview.vercel.app'
    assert website_origin('http://localhost:3001')=='http://localhost:3001'
    for origin in ('http://example.com','https://*.vercel.app','https://user:pass@example.com',
                   'https://example.com/path','https://example.com?token=x','https://example.com#x'):
        with pytest.raises(ValueError):website_origin(origin)
    path=tmp_path/'pairing.json'
    path.write_text(json.dumps(dict(origin='https://preview.vercel.app',token='x'*43)))
    assert load_pairing(path)==('https://preview.vercel.app','x'*43)
    path.write_text(json.dumps(dict(origin='https://preview.vercel.app',token='short')))
    with pytest.raises(ValueError):load_pairing(path)


def raw(side='left',now=1000):
    vector=dict(x=0.,y=0.,z=0.)
    return dict(kind='sample',sequence=1,sensorTimestampSec=1.,receiveUnixMs=now,sensorLocation=side,
                userAcceleration=vector,rotationRate=vector,gravity=vector,attitude=dict(vector,w=1.))


def test_raw_motion_is_same_hand_fresh_bounded_and_not_an_event():
    state=GameState('session',0)
    state.raw_sample('left',raw())
    state.connect(True)
    assert not state.sample(1000)['rawImu']
    for _ in range(100):state.raw_sample('left',dict(raw(),privateUnrelatedField='excluded'))
    state.raw_sample('left',raw('right'))
    state.raw_sample('left',dict(raw(),sequence=1.5))
    sample=state.sample(1000)
    assert len(sample['rawImu'])==64 and not sample['events']
    assert all(r['side']==r['sample']['sensorLocation']=='left' for r in sample['rawImu'])
    assert all('privateUnrelatedField' not in r['sample'] for r in sample['rawImu'])
    state.raw_sample('left',raw())
    assert not state.sample(1200)['rawImu']
    state.raw_sample('left',raw(now=1300))
    state.connect(False);state.connect(True)
    assert not state.sample(1300)['rawImu']


def test_hosted_bridge_checks_origin_and_auth_before_streaming():
    origin='https://preview.vercel.app';token='x'*43
    with pytest.raises(ValueError):GameBridge('s',0,Event(),origins=[origin])
    bridge=GameBridge('s',0,Event(),port=0,origins=[origin],auth_token=token).start()
    async def scenario():
        url=f'ws://127.0.0.1:{bridge.bound_port}'
        with pytest.raises(InvalidStatus):
            async with connect(url,origin='https://untrusted.example'):pass
        async with connect(url,origin=origin) as ws:
            await ws.send(json.dumps(dict(kind='authenticate',token='wrong')))
            with pytest.raises(ConnectionClosed) as error:await ws.recv()
            assert error.value.rcvd.code==1008
        async with connect(url,origin=origin) as ws:
            await ws.send(json.dumps(dict(kind='authenticate',token=token)))
            hello=json.loads(await ws.recv())
            assert hello['kind']=='motion_hello'
            await ws.send(json.dumps(dict(kind='ping',id=1)))
            messages=[json.loads(await asyncio.wait_for(ws.recv(),1)) for _ in range(3)]
            assert any(m['kind']=='pong' for m in messages)
            assert any(m['kind']=='cv_sample' for m in messages)
            assert all(token not in json.dumps(m) for m in messages)
    try:asyncio.run(scenario())
    finally:bridge.close()
