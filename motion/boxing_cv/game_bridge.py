"""Local-only game publisher. Sensor callbacks never wait for browser/network IO."""
import asyncio
from collections import deque
import json
import math
import secrets
from threading import Event, Lock, Thread
import time

SIDES = ('left', 'right')
MAX_EVENT_AGE_MS = 150


class GameState:
    def __init__(self, session, origin_unix_ms, max_events=128, model_mode='outward'):
        if model_mode != 'outward': raise ValueError('Unknown model mode')
        self.model_mode = model_mode
        self.session, self.origin = session, origin_unix_ms
        self.lock = Lock()
        self.sides = {}
        self.raw = deque(maxlen=64)
        self.pose = None
        self.events = deque()
        self.max_events = max_events
        self.connected = False
        self.overflow = False
        self.seq = 0
        self.dropped = 0

    def connect(self, enabled):
        with self.lock:
            self.connected = enabled
            self.raw.clear()
            self.events.clear()  # Never replay offline/calibration punches into a new game client.
            self.overflow = False

    def update_side(self, side, status):
        with self.lock:
            self.sides[side] = status

    def raw_sample(self, side, row):
        # Native API fields stay on the same computer; never enter reducer payloads.
        if not isinstance(row,dict) or row.get('kind')!='sample' or row.get('sensorLocation')!=side: return
        keys=('kind','sequence','sensorTimestampSec','receiveUnixMs','sensorLocation',
              'userAcceleration','rotationRate','gravity','attitude')
        selected={k:row[k] for k in keys if k in row}
        if len(selected)!=len(keys): return
        if not isinstance(selected['sequence'],int) or isinstance(selected['sequence'],bool) or selected['sequence']<0: return
        values=[selected[k] for k in ('sequence','sensorTimestampSec','receiveUnixMs')]
        for k,axes in [('userAcceleration','xyz'),('rotationRate','xyz'),('gravity','xyz'),('attitude','xyzw')]:
            if not isinstance(selected[k],dict) or any(axis not in selected[k] for axis in axes): return
            selected[k]={axis:selected[k][axis] for axis in axes}
            values.extend(selected[k].values())
        if not all(isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v) for v in values): return
        with self.lock:
            if self.connected: self.raw.append(dict(side=side, sample=selected))

    def update_pose(self, obs, events=()):
        with self.lock:
            self.pose = obs
            for event in events:
                self._append(event, 'pose')

    def punch(self, side, event):
        if event.get('type') != 'punch_'+side or event.get('punchType') not in ('straight','hook'):
            raise ValueError('Wrong-hand or unclassified event at game boundary')
        with self.lock:
            self._append(event, side)

    def _append(self, event, source):
        if not self.connected:
            self.dropped += 1
            return
        if len(self.events) >= self.max_events:
            self.events.clear()
            self.overflow = True
            return
        self.events.append((dict(event), source))

    def sample(self, now=None):
        now = time.time()*1000 if now is None else now
        with self.lock:
            pose, statuses = self.pose, dict(self.sides)
            events, self.events = list(self.events), deque()
            raw, self.raw = list(self.raw), deque(maxlen=64)
            overflow = self.overflow
            self.seq += 1
            seq = self.seq
        sides = {}
        for side in SIDES:
            state = statuses.get(side, {})
            fresh = state.get('sensorState') == 'fresh' and 0 <= now-state.get('receivedUnixMs', 0) <= 150
            ready = fresh and bool(state.get('calibrated')) and state.get('inferenceState') not in ('orientation_inconsistent','invalid_sensor_clock')
            sides[side] = dict(state, fresh=fresh, ready=ready and not overflow)
        pose_fresh = bool(pose and 0 <= now-(self.origin+pose['timestampMs']) <= 200)
        dodge = bool(pose_fresh and pose['validity']['dodge'] and not overflow)
        tracking = ('good' if all(sides[s]['ready'] for s in SIDES) else 'degraded') if dodge else (
            'calibrating' if pose_fresh and pose['trackingState']=='calibrating' else 'lost')
        obs = dict(schemaVersion=1, kind='observation', sessionId=self.session,
            timestampMs=pose['timestampMs'] if pose else now-self.origin, availableMs=now-self.origin,
            trackingState=tracking, validity=dict(dodge=dodge, punch_left=sides['left']['ready'], punch_right=sides['right']['ready']),
            calibrationId=pose.get('calibrationId') if pose else None,
            markers={'head':pose['markers']['head']} if dodge and 'head' in pose['markers'] else {},
            features=dict(pose['features']) if dodge else {}, qualityScore=None,
            pose=pose['pose'] if dodge else dict(body='neutral',guards=dict(left='neutral',right='neutral')),
            reason=None if dodge else 'Keep head in frame; calibration and pose freshness are required for combat')
        mapped = []
        for event, source in events:
            decision = event.get('detectedUnixMs', self.origin+event['detectedMs'])
            if overflow or not 0 <= now-decision <= MAX_EVENT_AGE_MS:
                self.dropped += 1
                continue
            if source in SIDES and not sides[source]['ready']:
                self.dropped += 1
                continue
            if source=='pose' and not dodge:
                self.dropped += 1
                continue
            e = dict(schemaVersion=1, eventId=event['eventId'], sessionId=self.session,
                type=event['type'], onsetMs=event.get('onsetMs'), sampleMs=event['sampleMs'],
                detectedMs=event['detectedMs'], sideConvention='player_anatomical',
                trackingState=tracking, qualityScore=None, qualityKind=event['qualityKind'],
                calibrationId=event.get('calibrationId'), experimental=True,
                features=dict(event.get('features',{}), nativeSessionId=event['sessionId'],
                    nativeEventId=event['eventId'], inputStream=source, detectedUnixMs=decision,
                    receiptToEventMs=event.get('receiptToEventMs'), confirmationToEventMs=event.get('confirmationToEventMs'),
                    transport=event.get('transport')))
            if source in SIDES:
                e['punchType'] = source+'_'+event['punchType']
            mapped.append(e)
        return dict(contractVersion=1, kind='cv_sample', source='live', fightId='local', roundId='local',
                    seq=seq, observation=obs, events=mapped, sentUnixMs=now,
                    rawImu=[r for r in raw if 0 <= now-r['sample']['receiveUnixMs'] <= 150],
                    status=dict(modelMode=self.model_mode, sides=sides, ready=dodge and all(sides[s]['ready'] for s in SIDES),
                                droppedEvents=self.dropped, overflow=overflow))


class GameBridge:
    def __init__(self, session, origin_unix_ms, camera_enabled, port=8765, model_mode='outward', origins=None, auth_token=None):
        self.origins=origins or ['http://localhost:3001','http://127.0.0.1:3001']
        if auth_token is None and set(self.origins)-{'http://localhost:3001','http://127.0.0.1:3001'}:
            raise ValueError('Hosted origins require explicit pairing')
        self.auth_token=auth_token
        self.state = GameState(session, origin_unix_ms, model_mode=model_mode)
        self.camera_enabled = camera_enabled
        self.port = port
        self.error = None
        self.client = None
        self.loop = None
        self.wake = None
        self.stop_event = Event()
        self.started = Event()
        self.thread = Thread(target=self._run, name='game-websocket', daemon=True)

    def start(self):
        self.thread.start()
        if not self.started.wait(5):
            raise RuntimeError('Game bridge did not start')
        if self.error: raise RuntimeError(self.error)
        return self

    def publish_snapshot(self, side, engine):
        self.state.update_side(side, dict(sensorState=engine.sensor_state,
            receivedUnixMs=engine.last_receive or 0, calibrated=engine.detector.profile is not None and not engine.calibrating,
            calibrationId=f'{engine.session}-imu-cal-{engine.profile_revision}' if engine.detector.profile else None,
            inferenceState=engine.last_features.get('state'), prompt=engine.prompt(time.time()*1000),
            modelWeightsSha256=engine.detector.info['weightsSha256']))

    def publish_raw(self, side, row):
        self.state.raw_sample(side,row)

    def punch(self, side, event):
        self.state.punch(side, event)
        self._wake()

    def pose(self, observation, events):
        self.state.update_pose(observation, events)
        if events: self._wake()

    def _wake(self):
        if self.loop and self.wake and not self.loop.is_closed():
            self.loop.call_soon_threadsafe(self.wake.set)

    async def _send(self, socket, message):
        await asyncio.wait_for(socket.send(json.dumps(message,allow_nan=False,separators=(',',':'))),.1)

    async def _client(self, socket):
        if self.auth_token is not None:
            try:
                message=json.loads(await asyncio.wait_for(socket.recv(),3))
                supplied=message.get('token') if isinstance(message,dict) else None
                if (not isinstance(supplied,str) or not supplied.isascii() or message.get('kind')!='authenticate'
                        or not secrets.compare_digest(supplied,self.auth_token)):
                    raise ValueError('Pairing rejected')
            except (ValueError,TimeoutError,TypeError):
                await socket.close(1008,'Open the pairing link from your motion companion')
                return
            except Exception:
                return  # peer disconnected before pairing
        if self.client is not None:
            await socket.close(1008,'Only one AirPod game tab at a time')
            return
        self.client = socket
        self.state.connect(True)
        self.camera_enabled.set()
        try:
            await self._send(socket,dict(kind='motion_hello',contractVersion=1,sessionId=self.state.session))
            async def receive():
                async for data in socket:
                    msg=json.loads(data)
                    if msg.get('kind') != 'ping' or not isinstance(msg.get('id'),int):
                        await socket.close(1008,'Only clock probes are supported')
                        return
                    await self._send(socket,dict(kind='pong',id=msg['id'],hostUnixMs=time.time()*1000))
            async def publish():
                while not self.stop_event.is_set():
                    try: await asyncio.wait_for(self.wake.wait(),.02)
                    except asyncio.TimeoutError: pass
                    self.wake.clear()
                    msg=self.state.sample()
                    await self._send(socket,msg)
                    if msg['status']['overflow']:
                        await socket.close(1013,'Input queue overflow; reconnect for fresh state')
                        return
            tasks=[asyncio.create_task(receive()),asyncio.create_task(publish())]
            try:
                done,_=await asyncio.wait(tasks,return_when=asyncio.FIRST_COMPLETED)
                for task in done: task.result()
            finally:
                for task in tasks: task.cancel()
                await asyncio.gather(*tasks,return_exceptions=True)
        except (TimeoutError,ValueError):
            await socket.close(1013,'Invalid or slow local client')
        except Exception as exc:
            # ConnectionClosed is expected on mode switch/reload. Other client
            # failures are logged; acquisition keeps running independently.
            print(f'Game client closed: {exc}',flush=True)
        finally:
            self.state.connect(False)
            self.camera_enabled.clear()  # release webcam when switching back to browser CV
            self.client=None

    def _run(self):
        async def serve():
            from websockets.asyncio.server import serve
            self.loop=asyncio.get_running_loop()
            self.wake=asyncio.Event()
            async with serve(self._client,'127.0.0.1',self.port,
                origins=self.origins,max_size=4096,
                max_queue=8,write_limit=16384,ping_interval=5,ping_timeout=5,close_timeout=1) as server:
                self.bound_port=server.sockets[0].getsockname()[1]
                self.started.set()
                while not self.stop_event.is_set(): await asyncio.sleep(.02)
        try: asyncio.run(serve())
        except Exception as exc:
            self.error=repr(exc)
            self.started.set()

    def close(self):
        self.stop_event.set()
        self._wake()
        self.thread.join(timeout=5)
        if self.thread.is_alive(): raise RuntimeError('Game bridge failed to stop')
