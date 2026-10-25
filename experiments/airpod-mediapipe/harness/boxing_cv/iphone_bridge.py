"""Right AirPod or iPhone IMU -> USB/iproxy -> source-pinned Mac motion JSONL.

Explicit source selection; existing AirPod transport remains unchanged.
Monotonic ping/pong estimates phone->Mac offset; wall clocks are never compared.
"""
import argparse
from collections import Counter, deque
from contextlib import ExitStack
import json
import math
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import uuid

from .calibrated_airpod import matches_source

ROOT = Path(__file__).resolve().parents[1]
MAX_LINE = 16384


def number(value):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


def encode(row):
    return (json.dumps(row, separators=(',', ':'), allow_nan=False)+'\n').encode()


class Lines:
    """Bounded framing, including fragmented and coalesced TCP packets."""
    def __init__(self): self.pending = b''

    def feed(self, data):
        parts = (self.pending + data).split(b'\n')
        self.pending = parts.pop()
        if len(self.pending) > MAX_LINE or any(len(x) > MAX_LINE for x in parts):
            raise ValueError('oversize_phone_row')
        rows = []
        for line in parts:
            row = json.loads(line)
            if not isinstance(row, dict): raise ValueError('phone_row_not_object')
            encode(row)  # reject nonfinite JSON before archival
            rows.append(row)
        return rows


class ClockSync:
    def __init__(self): self.observations = deque(maxlen=16)

    def update(self, t0, t1, t2, t3):
        if not all(number(x) for x in (t0,t1,t2,t3)) or t2 < t1 or t3 < t0:
            raise ValueError('invalid_clock_exchange')
        rtt = (t3-t0)-(t2-t1)
        if rtt < -1 or rtt > 100: raise ValueError('clock_rtt_too_large')
        offset = ((t1-t0)+(t2-t3))/2  # phone monotonic - Mac monotonic
        self.observations.append(dict(at=t3, rttMs=max(0,rtt), offsetMs=offset))

    def best(self, now):
        recent = [x for x in self.observations if 0 <= now-x['at'] <= 3000]
        if not recent: raise ValueError('clock_not_synchronized')
        return min(recent, key=lambda x:x['rttMs'])


class Receiver:
    """Pure validator/clock mapper; a new instance per TCP connection."""
    def __init__(self, max_relay_ms=150, source_type='airpod'):
        if source_type not in ('airpod', 'iphone'): raise ValueError('invalid_source_type')
        self.source_type = source_type
        self.bridge_session = uuid.uuid4().hex
        self.phone_session = None
        self.clock = ClockSync()
        self.last_sequence = -1
        self.last_sensor = -math.inf
        self.max_relay_ms = max_relay_ms

    def hello(self, row):
        if (row.get('kind') != 'hello' or row.get('protocol') != 'airpod-usb-v1'
                or row.get('schemaVersion') != 1 or row.get('role') != 'right'
                or not isinstance(row.get('sessionId'), str) or not row['sessionId']):
            raise ValueError('incompatible_phone_collector')
        if self.phone_session is not None: raise ValueError('unexpected_second_hello')
        if row.get('sourceType', 'airpod') != self.source_type:
            raise ValueError('source_mismatch: select the same source in the phone app and --source')
        self.phone_session = row['sessionId']

    def session_check(self, row):
        if self.phone_session is None or row.get('sessionId') != self.phone_session:
            raise ValueError('phone_session_changed')

    def convert(self, row, mono_ms, unix_ms):
        self.session_check(row)
        if not matches_source(row, 'right', self.source_type):
            raise ValueError('wrong_earbud' if self.source_type == 'airpod' else 'wrong_phone_source')
        if row.get('kind') != 'sample' or row.get('schemaVersion') != 1:
            raise ValueError('invalid_sample_schema')
        seq = row.get('sequence'); stamp = row.get('sensorTimestampSec')
        if type(seq) is not int or seq <= self.last_sequence: raise ValueError('duplicate_or_reordered_sequence')
        if not number(stamp) or stamp <= self.last_sensor: raise ValueError('nonincreasing_sensor_time')
        for k in ('receiveUnixMs','receiveUptimeMs','phoneSendUptimeMs'):
            if not number(row.get(k)): raise ValueError('invalid_phone_clock')
        for key, axes in [('userAcceleration','xyz'),('rotationRate','xyz'),('gravity','xyz'),('attitude','xyzw')]:
            if not isinstance(row.get(key),dict) or not all(number(row[key].get(a)) for a in axes):
                raise ValueError('invalid_'+key)
        norm = lambda k, axes: math.sqrt(sum(row[k][a]**2 for a in axes))
        if not .95 <= norm('attitude','xyzw') <= 1.05: raise ValueError('invalid_quaternion')
        if not .8 <= norm('gravity','xyz') <= 1.2: raise ValueError('invalid_gravity')
        # Advance sequence even when a fresh sample fails transport age checks.
        self.last_sequence, self.last_sensor = seq, stamp
        sync = self.clock.best(mono_ms)
        age = mono_ms-(row['receiveUptimeMs']-sync['offsetMs'])
        uncertainty = sync['rttMs']/2
        queue_ms = row['phoneSendUptimeMs']-row['receiveUptimeMs']
        if queue_ms < 0: raise ValueError('invalid_phone_send_time')
        if age < -uncertainty-2: raise ValueError('future_phone_sample')
        if max(0,age)+uncertainty > self.max_relay_ms or queue_ms > self.max_relay_ms:
            raise ValueError('stale_usb_sample')
        return dict(row, sessionId=self.bridge_session+':'+self.phone_session,
                    receiveUnixMs=unix_ms, receiveUptimeMs=mono_ms,
                    collectorRole='right', collector='iphone-usb-bridge-v1',
                    sourceType=self.source_type, punchingHand='right',
                    earbud='right' if self.source_type == 'airpod' else None,
                    phoneSessionId=self.phone_session, phoneReceiveUnixMs=row['receiveUnixMs'],
                    phoneReceiveUptimeMs=row['receiveUptimeMs'],
                    transport=dict(kind='usb', estimatedRelayMs=max(0,age), signedRelayEstimateMs=age,
                                   clockUncertaintyMs=uncertainty, clockRoundTripMs=sync['rttMs'],
                                   phoneQueueMs=queue_ms, phoneMinusMacOffsetMs=sync['offsetMs'],
                                   macReceiveUnixMs=unix_ms,
                                   note='Callback-to-Mac estimate; excludes sensor delivery and physical onset'))


class PhoneCadence:
    """Choose at most one real callback per 40ms slot; never interpolate or replay.

    Native collection requests 25Hz. This is a defensive upper-rate bound if iOS
    delivers faster. Timestamps remain untouched; gaps remain actual gaps.
    """
    def __init__(self):
        self.origin = None
        self.slot = -1
        self.previous = None

    def accept(self, row):
        stamp = row['sensorTimestampSec']
        if self.origin is None: self.origin = stamp
        slot = math.floor((stamp-self.origin+.005)/.04)
        if slot <= self.slot: return False
        row['inferenceSampling'] = dict(policy='one_real_callback_per_40ms_slot', targetHz=25,
            deltaMs=None if self.previous is None else (stamp-self.previous)*1000)
        self.slot, self.previous = slot, stamp
        return True


def latest_sample(path):
    with Path(path).open('rb') as handle:
        handle.seek(0,2); size=handle.tell(); handle.seek(max(0,size-32768))
        lines=handle.read().splitlines()
    for line in reversed(lines):
        try: row=json.loads(line)
        except (ValueError,UnicodeError): continue
        if isinstance(row,dict) and row.get('kind')=='sample': return row
    return None


def fresh_left(path):
    try:
        row=latest_sample(path)
        return bool(row and row.get('sensorLocation')=='left' and number(row.get('receiveUnixMs'))
                    and 0 <= time.time()*1000-row['receiveUnixMs'] < 1000)
    except OSError: return False


def choose_left(explicit=None):
    if explicit:
        path=Path(explicit).resolve()
        if not fresh_left(path): raise ValueError('Left log is not fresh/physical LEFT. Start the Mac single collector first.')
        return path
    candidates=sorted((ROOT/'collectors'/'runs').glob('*/motion.jsonl'),
                      key=lambda p:p.stat().st_mtime,reverse=True)
    for path in candidates[:10]:
        if fresh_left(path): return path.resolve()
    raise ValueError('No fresh LEFT stream. Open AirPodsCollector.app, connect only the left pair to Mac, click Start. Or use --left-log PATH.')


def iproxy_command(port, udid=None):
    program=shutil.which('iproxy')
    if not program:
        program=next((str(p) for p in [Path('/opt/homebrew/bin/iproxy'),Path('/usr/local/bin/iproxy')] if p.is_file()),None)
    if not program: raise ValueError('Install USB forwarding: brew install libusbmuxd')
    cmd=[program,'-l','-s','127.0.0.1']
    if udid: cmd+=['-u',udid]
    return cmd+[f'{port}:8765']


def write(handle,row):
    handle.write(encode(row).decode())  # line-buffered: visible to inference immediately


def run_connection(sock, handles, stop=lambda:False, on_accept=lambda row:None, max_relay_ms=150, source_type='airpod'):
    receiver=Receiver(max_relay_ms,source_type); framing=Lines(); pending={}; next_ping=0.
    cadence=PhoneCadence()
    started=time.monotonic(); last_pong=started; accepted=0; dropped=Counter(); last_print=0.
    delays=deque(maxlen=4096); latest_motion={}
    sock.settimeout(.05); sock.setsockopt(socket.IPPROTO_TCP,socket.TCP_NODELAY,1)
    def status(state):
        write(handles['motion'],dict(kind='status',state=state,receiveUnixMs=time.time()*1000,
                                    sessionId=receiver.bridge_session,transport='usb'))
    status('usb_connected_recalibrate')
    while not stop():
        mono=time.monotonic(); now_ms=mono*1000
        if receiver.phone_session and mono>=next_ping:
            ping_id=uuid.uuid4().hex
            pending={key:value for key,value in pending.items() if now_ms-value<3000}
            pending[ping_id]=now_ms
            sock.sendall(encode(dict(kind='ping',id=ping_id)))
            next_ping=mono+(.1 if len(receiver.clock.observations)<3 else .5)
        try: data=sock.recv(65536)
        except socket.timeout: data=None
        if data==b'': raise ConnectionError('iPhone closed the USB stream')
        if data:
            for row in framing.feed(data):
                arrival_mono=time.monotonic()*1000; arrival_unix=time.time()*1000
                write(handles['raw'],dict(macReceiveUnixMs=arrival_unix,macReceiveMonotonicMs=arrival_mono,
                                         bridgeSessionId=receiver.bridge_session,row=row))
                kind=row.get('kind')
                if kind=='hello': receiver.hello(row)
                elif kind=='pong':
                    receiver.session_check(row)
                    t0=pending.pop(row.get('id'),None)
                    if t0 is None: raise ValueError('unexpected_clock_reply')
                    try:
                        receiver.clock.update(t0,row.get('phoneReceiveUptimeMs'),row.get('phoneSendUptimeMs'),arrival_mono)
                        last_pong=time.monotonic()
                        write(handles['audit'],dict(kind='clock_sync',**receiver.clock.best(arrival_mono)))
                    except ValueError as exc:
                        write(handles['audit'],dict(kind='clock_rejected',reason=str(exc)))
                elif kind=='status':
                    receiver.session_check(row)
                    status('phone_'+str(row.get('state','unknown')))
                elif kind=='sample':
                    try: mapped=receiver.convert(row,arrival_mono,arrival_unix)
                    except ValueError as exc:
                        reason=str(exc); dropped[reason]+=1
                        write(handles['audit'],dict(kind='sample_rejected',reason=reason,
                                                   sequence=row.get('sequence'),macReceiveUnixMs=arrival_unix))
                        if reason in ('phone_session_changed','nonincreasing_sensor_time'):
                            raise ConnectionError(reason)
                        # Wrong source invalidates calibration immediately, not after a timeout.
                        if reason in ('wrong_earbud','wrong_phone_source'): status(reason)
                        continue
                    if source_type == 'iphone' and not cadence.accept(mapped):
                        dropped['cadence_skipped']+=1
                        write(handles['audit'],dict(kind='cadence_skipped',sequence=row['sequence'],
                                                   sensorTimestampSec=row['sensorTimestampSec']))
                        continue
                    write(handles['motion'],mapped); accepted+=1
                    latest_motion = {key: math.sqrt(sum(mapped[field][axis]**2 for axis in 'xyz'))
                                     for key,field in [('accelG','userAcceleration'),('gyroRadSec','rotationRate')]}
                    delays.append(mapped['transport']['estimatedRelayMs'])
                    on_accept(mapped)
                else: raise ValueError('unknown_phone_message')
        mono=time.monotonic()
        if not receiver.phone_session and mono-started>5: raise ConnectionError('No collector handshake; open app and tap Start')
        if receiver.phone_session and mono-last_pong>3: raise ConnectionError('Clock sync lost; reconnect and recalibrate right')
        if mono-last_print>=1:
            summary=dict(kind='transport_summary',macUnixMs=time.time()*1000,accepted=accepted,
                         rejected=dict(dropped),bridgeSessionId=receiver.bridge_session,
                         latestMotion=latest_motion,
                         sourceType=source_type,
                         medianRelayMs=sorted(delays)[len(delays)//2] if delays else None,
                         p95RelayMs=sorted(delays)[min(len(delays)-1,int(len(delays)*.95))] if delays else None)
            write(handles['audit'],summary)
            def ms(value): return '--' if value is None else f'{value:.1f}'
            print(f"RIGHT {source_type.upper()} USB accepted={accepted} rejected={dict(dropped)} | a={latest_motion.get('accelG',0):.2f} g gyro={latest_motion.get('gyroRadSec',0):.2f} rad/s | relay median/p95={ms(summary['medianRelayMs'])}/{ms(summary['p95RelayMs'])} ms",flush=True)
            last_print=mono


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',choices=['airpod','iphone'],default='airpod',help='Must match the phone app selector; default preserves AirPod collection')
    parser.add_argument('--left-log',type=Path,help='Default: newest fresh left stream from original Mac collector')
    parser.add_argument('--output',type=Path,help='New transport recording directory; never overwrite a run')
    parser.add_argument('--port',type=int,default=18765,help='Mac loopback port forwarded to iPhone 8765')
    parser.add_argument('--udid',help='Pin USB phone identifier; otherwise connect only one iPhone by cable')
    parser.add_argument('--launch-inference',action='store_true',help='Start existing dual outward mode once both streams are fresh')
    parser.add_argument('--record-video',action='store_true')
    parser.add_argument('--fast',action='store_true',help='Use separate early-target demo weights')
    parser.add_argument('--max-relay-ms',type=float,default=150)
    a=parser.parse_args(argv)
    if not 1024<=a.port<=65535: parser.error('Port must be 1024..65535')
    if not 0<a.max_relay_ms<=500: parser.error('--max-relay-ms must be >0 and <=500')
    left=choose_left(a.left_log); command=iproxy_command(a.port,a.udid)
    # Do not connect accidentally to a previous forwarding process.
    with socket.socket() as probe: probe.bind(('127.0.0.1',a.port))
    out=(a.output or ROOT/'runs'/(a.source+'-usb-'+time.strftime('%Y%m%d-%H%M%S'))).resolve()
    out.mkdir(parents=True,exist_ok=False)
    (out/'right').mkdir()
    right=out/'right'/'motion.jsonl'
    streams=dict(schemaVersion=1,left=str(left),right=str(right),transport='iphone-usb',
                 sources=dict(left='airpod',right=a.source),
                 roles=dict(left='Mac / left bud / left hand',right=f'iPhone / {a.source} sensor / right hand'))
    (out/'streams.json').write_text(json.dumps(streams,indent=2)+'\n')
    (out/'metadata.json').write_text(json.dumps(dict(transport='USB-only iproxy',command=command,
        sourceType=a.source,modelMode='fast' if a.fast else 'outward',punchingHand='right',earbud='right' if a.source=='airpod' else None,
        sampling='native 25 Hz request + 40ms callback selection' if a.source=='iphone' else 'unchanged headphone callbacks',
        maxRelayMs=a.max_relay_ms,clockMethod='minimum RTT monotonic ping/pong, refreshed every 500ms',
        latencyScope='Phone callback to Mac receipt only; no physical motion latency measurement'),indent=2)+'\n')
    inference=None; proxy=None; session_accepted=0
    with ExitStack() as stack:
        handles={key:stack.enter_context((out/path).open('x',buffering=1)) for key,path in
                 [('motion','right/motion.jsonl'),('raw','right/phone-raw.jsonl'),('audit','right/transport.jsonl')]}
        proxy_log=stack.enter_context((out/'iproxy.log').open('x',buffering=1))
        proxy=subprocess.Popen(command,stdout=proxy_log,stderr=subprocess.STDOUT)
        print(f'LEFT Mac: {left}\nRIGHT phone: {right}\nStreams: {out/"streams.json"}\nConnect one iPhone via USB, keep its collector open. Ctrl-C stops bridge.',flush=True)
        def on_accept(row):
            nonlocal inference, session_accepted
            session_accepted+=1
            if session_accepted>=5 and fresh_left(left):
                if not (out/'ready.json').exists():
                    (out/'ready.json').write_text(json.dumps(dict(ready=True,macUnixMs=time.time()*1000)))
                    print('Both sources fresh. Move each controller separately to verify independence.',flush=True)
                if a.launch_inference and inference is None:
                    args=[sys.executable,'-m','boxing_cv',
                          '--airpod-streams',str(out/'streams.json'),'--output',str(out/'inference')]
                    if a.record_video: args+=['--record-video']
                    if a.fast: args+=['--fast']
                    inference=subprocess.Popen(args,cwd=ROOT)
        try:
            while inference is None or inference.poll() is None:
                if proxy.poll() is not None: raise RuntimeError(f'iproxy exited. See {out/"iproxy.log"}')
                try:
                    with socket.create_connection(('127.0.0.1',a.port),timeout=1) as sock:
                        session_accepted=0
                        run_connection(sock,handles,stop=lambda: inference is not None and inference.poll() is not None,
                                       on_accept=on_accept,max_relay_ms=a.max_relay_ms,source_type=a.source)
                except (OSError,ValueError) as exc:
                    write(handles['motion'],dict(kind='status',state='usb_disconnected',receiveUnixMs=time.time()*1000))
                    write(handles['audit'],dict(kind='disconnect',reason=str(exc),macUnixMs=time.time()*1000))
                    (out/'ready.json').unlink(missing_ok=True)
                    print(f'USB waiting/reconnecting: {exc}. Right must recalibrate after reconnect.',flush=True)
                    time.sleep(1)
            if inference.returncode: raise RuntimeError(f'Inference exited with {inference.returncode}')
        except KeyboardInterrupt: pass
        finally:
            write(handles['motion'],dict(kind='status',state='usb_stopped',receiveUnixMs=time.time()*1000))
            if inference is not None and inference.poll() is None:
                import signal
                inference.send_signal(signal.SIGINT)
                try: inference.wait(timeout=10)
                except subprocess.TimeoutExpired: inference.terminate(); inference.wait(timeout=5)
            if proxy is not None:
                proxy.terminate()
                try: proxy.wait(timeout=3)
                except subprocess.TimeoutExpired: proxy.kill(); proxy.wait()
    print(f'USB logs saved: {out}',flush=True)


if __name__=='__main__':
    try: main()
    except (ValueError,OSError,RuntimeError) as exc:
        print(f'USB setup error: {exc}',file=sys.stderr); sys.exit(1)
