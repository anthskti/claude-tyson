import io
import json
import socket
import threading
import time

import pytest

from boxing_cv.iphone_bridge import ClockSync, Lines, Receiver, PhoneCadence, encode, run_connection, choose_left, iproxy_command
from boxing_cv.calibrated_airpod import sample


def hello(session='phone-1'):
    return dict(kind='hello', protocol='airpod-usb-v1', schemaVersion=1, role='right',sessionId=session)


def motion(sequence=1):
    return dict(kind='sample',schemaVersion=1,sessionId='phone-1',sensorLocation='right',sequence=sequence,
        sensorTimestampSec=sequence*.04,receiveUnixMs=999999999999,receiveUptimeMs=1500,phoneSendUptimeMs=1501,
        userAcceleration=dict(x=.2,y=-.1,z=.7),rotationRate=dict(x=1,y=2,z=3),
        gravity=dict(x=0,y=0,z=-1),attitude=dict(x=0,y=0,z=0,w=1))


def receiver():
    r=Receiver();r.hello(hello())
    # offset +500 ms, 10 ms round trip
    r.clock.update(1000,1505,1505,1010)
    return r


def test_framing_handles_partial_and_coalesced_packets():
    f=Lines();data=encode(hello())+encode(motion())
    assert f.feed(data[:7])==[]
    assert f.feed(data[7:])==[hello(),motion()]
    with pytest.raises(ValueError):f.feed(b'x'*16385)
    with pytest.raises(ValueError):Lines().feed(b'{"a":NaN}\n')
    with pytest.raises(ValueError):Lines().feed(b'[]\n')


def test_clock_offset_rtt_and_expiry():
    c=ClockSync();c.update(1000,1505,1506,1011)
    assert c.best(1011)['offsetMs']==500
    assert c.best(1011)['rttMs']==10
    c.update(1100,1602,1602,1104)
    assert c.best(1104)['rttMs']==4
    with pytest.raises(ValueError,match='not_synchronized'):c.best(5000)
    with pytest.raises(ValueError):c.update(1000,1505,1506,2000)


def test_clocks_preserved_and_physical_data_unmodified():
    r=receiver();raw=motion();mapped=r.convert(raw,1020,100000)
    assert mapped['receiveUnixMs']==100000  # Mac time, not the unrelated phone wall clock
    assert mapped['phoneReceiveUnixMs']==999999999999
    assert mapped['phoneReceiveUptimeMs']==1500
    assert mapped['transport']['estimatedRelayMs']==20
    assert mapped['transport']['clockUncertaintyMs']==5
    for key in ('userAcceleration','rotationRate','gravity','attitude','sensorTimestampSec','sensorLocation'):
        assert mapped[key]==raw[key]
    parsed=sample(mapped,'right',100005,250)
    assert parsed['sequence']==1
    assert parsed['ageMs']==5
    with pytest.raises(ValueError):sample(mapped,'left',100005,250)


@pytest.mark.parametrize('mutation,reason',[
    ({'sensorLocation':'left'},'wrong_earbud'),
    ({'sessionId':'new'},'phone_session_changed'),
    ({'receiveUptimeMs':1000},'stale_usb_sample'),
    ({'receiveUptimeMs':3000,'phoneSendUptimeMs':3001},'future_phone_sample'),
    ({'sensorTimestampSec':float('nan')},'nonincreasing_sensor_time'),
    ({'rotationRate':{'x':1,'y':2,'z':float('nan')}},'invalid_rotationRate'),
])
def test_rejects_wrong_stale_or_invalid_data(mutation,reason):
    with pytest.raises(ValueError,match=reason):receiver().convert(dict(motion(),**mutation),1020,100000)


def test_deduplication_and_unsynced_startup():
    r=receiver();r.convert(motion(),1020,100000)
    with pytest.raises(ValueError,match='duplicate'):r.convert(motion(),1021,100001)
    r=Receiver();r.hello(hello())
    with pytest.raises(ValueError,match='not_synchronized'):r.convert(motion(),1020,100000)


def test_new_connection_has_new_identity_and_no_old_clock():
    a,b=receiver(),Receiver();b.hello(hello())
    assert a.bridge_session!=b.bridge_session
    with pytest.raises(ValueError,match='not_synchronized'):b.convert(motion(),1020,100000)


@pytest.mark.parametrize('source_type',['airpod','iphone'])
def test_loopback_stream_pings_framing_and_raw_archive(source_type):
    server=socket.socket();server.bind(('127.0.0.1',0));server.listen();server.settimeout(3)
    failures=[];done=threading.Event();accepted=[]
    def phone():
        try:
            conn,_=server.accept()
            with conn:
                conn.settimeout(3);conn.sendall(encode(dict(hello(),sourceType=source_type)));framing=Lines();seq=0
                while not done.is_set():
                    data=conn.recv(4096)
                    if not data:break
                    for ping in framing.feed(data):
                        t=time.monotonic()*1000+75000 # phone uptime unrelated to Mac
                        pong=dict(kind='pong',id=ping['id'],sessionId='phone-1',phoneReceiveUptimeMs=t,phoneSendUptimeMs=t)
                        seq+=1
                        row=dict(motion(seq),receiveUptimeMs=t,phoneSendUptimeMs=t)
                        if source_type=='iphone':
                            row.update(sourceType='iphone',sensorLocation='device',punchingHand='right',earbud=None)
                        payload=encode(pong)+encode(row)
                        conn.sendall(payload[:13]);conn.sendall(payload[13:])
        except Exception as exc:failures.append(exc)
        finally:server.close()
    worker=threading.Thread(target=phone);worker.start()
    handles={k:io.StringIO() for k in ('raw','motion','audit')}
    def on_accept(row):
        accepted.append(row)
        if len(accepted)==3:done.set()
    try:
        with socket.create_connection(server.getsockname(),timeout=3) as sock:
            run_connection(sock,handles,done.is_set,on_accept,source_type=source_type)
    finally:
        done.set();worker.join(4)
    assert not worker.is_alive() and not failures
    assert len(accepted)==3
    assert all(r['sensorLocation']==('device' if source_type=='iphone' else 'right') and r['collectorRole']=='right' for r in accepted)
    assert all(r['sourceType']==source_type for r in accepted)
    raw=[json.loads(s) for s in handles['raw'].getvalue().splitlines()]
    assert sum(x['row']['kind']=='sample' for x in raw)==3
    assert all(r['phoneReceiveUnixMs']==999999999999 for r in accepted)
    assert all(0<=r['transport']['estimatedRelayMs']<150 for r in accepted)
    assert len({r['sessionId'] for r in accepted})==1


def test_left_log_must_be_fresh_and_actually_left(tmp_path):
    log=tmp_path/'motion.jsonl'
    log.write_bytes(encode(dict(motion(),receiveUnixMs=time.time()*1000)))
    with pytest.raises(ValueError,match='LEFT'):choose_left(log)
    log.write_bytes(encode(dict(motion(),sensorLocation='left',receiveUnixMs=time.time()*1000)))
    assert choose_left(log)==log.resolve()
    log.write_bytes(encode(dict(motion(),sensorLocation='left',receiveUnixMs=0)))
    with pytest.raises(ValueError):choose_left(log)


def test_proxy_is_usb_only_and_loopback(monkeypatch):
    monkeypatch.setattr('boxing_cv.iphone_bridge.shutil.which',lambda _: '/test/iproxy')
    assert iproxy_command(18765,'phone-udid')==['/test/iproxy','-l','-s','127.0.0.1','-u','phone-udid','18765:8765']


def test_phone_requires_explicit_selection_and_preserves_identity():
    phone=dict(motion(),sourceType='iphone',sensorLocation='device',punchingHand='right',earbud=None)
    with pytest.raises(ValueError,match='source_mismatch'):
        Receiver().hello(dict(hello(),sourceType='iphone'))
    r=Receiver(source_type='iphone')
    with pytest.raises(ValueError,match='source_mismatch'):r.hello(hello())
    r.hello(dict(hello(),sourceType='iphone'))
    r.clock.update(1000,1505,1505,1010)
    mapped=r.convert(phone,1020,100000)
    assert mapped['earbud'] is None and mapped['sensorLocation']=='device'
    parsed=sample(mapped,'right',100005,150,source_type='iphone')
    assert parsed['a'].tolist()==[.2,-.1,.7]
    for bud,source_type in [('right','airpod'),('left','iphone')]:
        with pytest.raises(ValueError):sample(mapped,bud,100005,150,source_type=source_type)
    with pytest.raises(ValueError):sample(dict(mapped,punchingHand='left'),'right',100005,150,'iphone')
    with pytest.raises(ValueError):sample(dict(mapped,earbud='right'),'right',100005,150,'iphone')


def test_phone_session_rejects_airpod_substitution():
    r=Receiver(source_type='iphone');r.hello(dict(hello(),sourceType='iphone'))
    r.clock.update(1000,1505,1505,1010)
    with pytest.raises(ValueError,match='wrong_phone_source'):r.convert(motion(),1020,100000)


@pytest.mark.parametrize('hz',[25,60,100])
def test_phone_rate_selection_preserves_real_samples_and_time(hz):
    gate=PhoneCadence();rows=[dict(sensorTimestampSec=i/hz,sequence=i) for i in range(hz*2)]
    accepted=[r for r in rows if gate.accept(r)]
    assert len(accepted)==50
    assert all(r['sensorTimestampSec']==r['sequence']/hz for r in accepted)
    assert accepted[-1]['sensorTimestampSec']>1.9
    # Gaps aren't filled, including after a suspended phone.
    row=dict(sensorTimestampSec=4.)
    assert gate.accept(row) and row['inferenceSampling']['deltaMs']>2000
