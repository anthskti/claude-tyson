"""Independent IMU loop and buffered logging for the live calibrated experiment.

Only the IMU thread owns Experiment. Pose and UI publish immutable inputs; slow
rendering/camera/video/disk work never runs in the sensor polling loop.
"""
from collections import deque
from queue import Queue, Empty, Full
from threading import Event, Thread
from types import SimpleNamespace
import json
import time
import traceback


class AsyncLogs:
    """Bounded lossless queue. Fail explicitly on overflow; never silently drop logs."""
    def __init__(self, files, max_pending=8192, profile_path=None):
        self.files = files
        self.profile_path = profile_path
        self.queue = Queue(maxsize=max_pending)
        self.error = None
        self.max_pending = 0
        self.thread = Thread(target=self._run, name='airpod-log-writer', daemon=True)
        self.thread.start()

    def submit(self, names=(), value=None, console=None):
        if self.error:
            raise RuntimeError(self.error)
        try:
            self.queue.put_nowait((names, value, console))
            self.max_pending = max(self.max_pending, self.queue.qsize())
        except Full:
            raise RuntimeError('Log writer cannot keep up; recording stopped rather than dropping evidence')

    def _run(self):
        last_flush = time.monotonic()
        try:
            while True:
                try:
                    item = self.queue.get(timeout=.2)
                except Empty:
                    item = 'flush'
                if item is None:
                    break
                if item != 'flush':
                    names, value, console = item
                    if names:
                        encoded = json.dumps(value, allow_nan=False, separators=(',', ':'))+'\n'
                        for name in names:
                            if name == '@profile':
                                if self.profile_path is not None:
                                    self.profile_path.write_text(encoded)
                            else:
                                self.files[name].write(encoded)
                    if console:
                        print(console, flush=True)
                if time.monotonic()-last_flush >= .2:
                    for handle in self.files.values():
                        handle.flush()
                    last_flush = time.monotonic()
            for handle in self.files.values():
                handle.flush()
        except Exception:
            self.error = traceback.format_exc()

    def close(self):
        if self.thread.is_alive():
            # Teardown may wait; runtime submit never blocks on this queue.
            self.queue.put(None, timeout=5)
            self.thread.join(timeout=10)
            if self.thread.is_alive():
                raise RuntimeError('Log writer did not finish; logs may be incomplete')
        if self.error:
            raise RuntimeError(self.error)


class SensorLoop:
    """5ms polling independent of the pose worker and the main-thread OpenCV UI."""
    def __init__(self, engine, tail, sink, stop):
        self.engine, self.tail, self.sink, self.stop = engine, tail, sink, stop
        self.commands = Queue(maxsize=64)
        self.pose_packet = None
        self.pose_seen = None
        self.events = deque(maxlen=6)
        self.pose_events = Queue(maxsize=128)
        self.error = None
        self.outputs = deque(maxlen=1024)
        self.snapshot = None
        self.last_transport = None
        self.cycles = self.samples = 0
        self.max_cycle_ms = 0.
        self.ages = deque(maxlen=4096)
        self.thread = Thread(target=self._run, name='airpod-sensor-detector', daemon=True)

    def start(self):
        self.thread.start()
        return self

    def command(self, key):
        self.commands.put_nowait(dict(kind='command', key=key, requestedUnixMs=time.time()*1000))

    def feed(self, entry):
        from .calibrated_debug import event_line
        if entry['kind'] == 'imu':
            row = entry.get('row', {})
            self.last_transport = row.get('transport') if isinstance(row, dict) and row.get('kind') == 'sample' else None
        self.sink.submit(('timeline.jsonl',), entry)
        if entry['kind'] == 'imu' and 'raw-motion.jsonl' in self.sink.files:
            self.sink.submit(('raw-motion.jsonl',), entry['row'])
        for result in self.engine.handle(entry):
            result.update(sourceType=getattr(self.engine,'source_type','airpod'),
                          punchingHand=self.engine.hand,
                          earbud=None if getattr(self.engine,'source_type','airpod')=='iphone' else self.engine.bud)
            kind = result['kind']
            names = ['diagnostics.jsonl']
            console = None
            if kind not in ('imu_features', 'calibration_review', 'pose_evidence'):
                self.outputs.append(result)
            if kind == 'event':
                if isinstance(self.last_transport, dict):
                    result['transport'] = self.last_transport
                    receipt_delay = result.get('receiptToEventMs')
                    if receipt_delay is not None:
                        result['estimatedPhoneCallbackToEventMs'] = self.last_transport['estimatedRelayMs'] + receipt_delay
                names.append('events.jsonl')
                self.events.append(result)
                console = event_line(result)
            elif kind == 'profile':
                names.append('@profile')
            elif kind in ('trial_started','trial_finished','trial_cancelled','trial_rejected'):
                names.append('trials.jsonl')
            if kind in ('profile','calibration_failed','calibration_retry','calibration_invalidated','trial_finished','trial_blocked','trial_rejected','collection_progress'):
                console = json.dumps(result)
            self.sink.submit(tuple(names), result, console)

    def _publish(self, now):
        e = self.engine
        # Snapshot references point to completed dictionaries that are not mutated.
        prompt = e.prompt(now)
        self.snapshot = SimpleNamespace(sensor_state=e.sensor_state, last_features=e.last_features,
            hand=e.hand, bud=e.bud,
            cfg=e.cfg, origin_unix_ms=e.origin_unix_ms, pose=e.pose,
            detector=SimpleNamespace(profile=e.detector.profile, armed=e.detector.armed),
            prompt=lambda _: prompt, recent=tuple(sorted(self.events, key=lambda event: event['sampleMs'])),
            collecting_dataset=hasattr(e, 'collection_plan'))
        self.snapshot.last_model_event = getattr(e, 'last_model_event', None)
        self.snapshot.transport = self.last_transport
        self.snapshot.source_type = getattr(e,'source_type','airpod')
        self.snapshot.model_mode = hasattr(e.detector, 'model')
        if hasattr(self.sink, 'publish_snapshot'):
            self.sink.publish_snapshot(e)

    def _run(self):
        last_tick = 0.
        previous_prompt = None
        try:
            while not self.stop.is_set():
                start = time.perf_counter()
                # Keep the UI request clock separately; ordered decisions use worker time.
                while True:
                    try:
                        command = self.commands.get_nowait()
                    except Empty:
                        break
                    command['nowUnixMs'] = time.time()*1000
                    self.feed(command)
                packet = self.pose_packet
                if packet is not None and packet is not self.pose_seen:
                    self.pose_seen = packet
                    self.feed(dict(kind='pose', nowUnixMs=packet[0], record=packet[1]))
                for row in self.tail.poll():
                    now = time.time()*1000
                    if isinstance(row,dict) and row.get('kind')=='sample':
                        self.samples += 1
                        received = row.get('receiveUnixMs')
                        if isinstance(received,(float,int)):
                            self.ages.append(now-received)
                    self.feed(dict(kind='imu', nowUnixMs=now, row=row))
                while True:
                    try:
                        self.events.append(self.pose_events.get_nowait())
                    except Empty:
                        break
                now = time.time()*1000
                # 50Hz timer is enough for a 25Hz sensor; avoid logging idle 200Hz ticks.
                if time.perf_counter()-last_tick >= .02:
                    self.feed(dict(kind='tick', nowUnixMs=now))
                    last_tick = time.perf_counter()
                self._publish(now)
                prompt = self.snapshot.prompt(now)
                if prompt != previous_prompt and not self.engine.trial:
                    self.sink.submit(console=prompt)
                previous_prompt = prompt
                self.cycles += 1
                self.max_cycle_ms = max(self.max_cycle_ms,(time.perf_counter()-start)*1000)
                self.stop.wait(.005)
            if self.engine.trial:
                self.feed(dict(kind='command', key='x', nowUnixMs=time.time()*1000))
        except Exception:
            self.error = traceback.format_exc()
            self.stop.set()
