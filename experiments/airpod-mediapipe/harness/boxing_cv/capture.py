"""Bounded capture: cameras overwrite one pending frame; files use backpressure."""
from threading import Condition, Event, Thread
import json
from pathlib import Path
import time


# Producer/consumer handoff with exactly one pending decoded frame. A camera
# keeps the newest frame; a file waits so comparisons can process every frame.
class Capture:
    def __init__(self, source, origin, width=640, height=480, fps=30, input_mirrored=False):
        import cv2
        self.cv2, self.source, self.origin = cv2, source, origin
        # An integer selects a camera index; a path string selects a video file.
        # origin is the shared monotonic session clock, unaffected by wall-clock changes.
        self.live = isinstance(source, int)
        self.flip = input_mirrored
        self.cap = cv2.VideoCapture(source)
        if not self.cap.isOpened():
            self.cap.release()
            raise RuntimeError(f'Cannot open {source!r}. Check camera index/permissions, close other camera apps, or use --video/--replay.')
        # Camera properties are requests: drivers may supply different dimensions/FPS.
        # Log reported values rather than assuming these requests succeeded.
        if self.live:
            self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
            self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
            self.cap.set(cv2.CAP_PROP_FPS, fps)
            self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)  # backend may ignore this
        actual_fps = self.cap.get(cv2.CAP_PROP_FPS)
        self.fps = actual_fps if 1 <= actual_fps <= 240 else fps
        self.info = {'source': source, 'live': self.live,
                     'requested': {'width': width, 'height': height, 'fps': fps},
                     'reported': {'width': self.cap.get(cv2.CAP_PROP_FRAME_WIDTH),
                                  'height': self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT), 'fps': actual_fps},
                     'backend': self.cap.getBackendName(), 'input_mirrored': self.flip,
                     'timestampMethod': 'host_after_read' if self.live else 'file_pts_or_frame_index'}
        self.timestamps = None
        # Our recorded AVI can have irregularly spaced processed frames. Its sidecar
        # (one source timestamp per frame) restores that spacing for faithful replay.
        if not self.live:
            sidecar = Path(str(source)+'.timestamps.jsonl')
            if sidecar.exists():
                self.timestamps = [json.loads(line)['timestamp_ms'] for line in sidecar.read_text().splitlines()]
                self.info['timestampMethod'] = 'recording_sidecar'
        # Condition protects the frame slot and wakes waiting producer/consumer.
        # finished signals end-of-stream; error carries background failures to the runner.
        self.condition, self.stop = Condition(), Event()
        self.slot = None
        self.finished = False
        self.error = None
        self.reads = self.overwritten = 0
        self.thread = Thread(target=self._run, daemon=True, name='camera-capture')

    # Start capture on its own thread; return self for convenient chained setup.
    def start(self):
        self.thread.start()
        return self

    # Read/decode continuously until stopped or end-of-file. Only this producer
    # thread uses/releases the OpenCV capture device.
    def _run(self):
        previous, index = -1, 0
        try:
            while not self.stop.is_set():
                ok, frame = self.cap.read()
                if not ok:
                    if self.live:
                        self.error = 'Camera stopped producing frames. Check connection and permissions.'
                    elif self.timestamps is not None and index < len(self.timestamps):
                        self.error = f'Video has fewer frames than its timestamp sidecar ({index} vs {len(self.timestamps)})'
                    break
                read_time = time.perf_counter()
                # Canonical inference input is unmirrored. Correct selfie recordings here,
                # before landmark estimation; UI mirroring is a separate display choice.
                if self.flip:
                    frame = self.cv2.flip(frame, 1)
                # Camera timestamps use host time just after read, not sensor exposure time.
                # Files use sidecar timestamps, then decoder presentation time (PTS), with
                # frame-index/FPS fallback. MediaPipe requires strictly increasing milliseconds.
                if self.live:
                    stamp = max(previous+1, int((read_time-self.origin)*1000))
                elif self.timestamps is not None:
                    if index >= len(self.timestamps):
                        raise ValueError('Video has more frames than its timestamp sidecar')
                    stamp = self.timestamps[index]
                else:
                    pts = self.cap.get(self.cv2.CAP_PROP_POS_MSEC)
                    stamp = int(pts) if pts > previous else round(index*1000/self.fps)
                    stamp = max(previous+1, stamp)
                if stamp <= previous:
                    raise ValueError('Timestamp sidecar is not strictly increasing')
                previous = stamp
                # Files apply backpressure: wait for the consumer to take the prior frame.
                # Cameras overwrite instead: stale queued movement would add live control lag.
                with self.condition:
                    if not self.live:
                        self.condition.wait_for(lambda: self.slot is None or self.stop.is_set())
                    if self.stop.is_set():
                        break
                    if self.slot is not None:
                        self.overwritten += 1
                    self.slot = (index, stamp, frame, read_time)
                    self.reads += 1
                    self.condition.notify_all()
                index += 1
        except Exception as e:
            self.error = str(e)
        finally:
            self.cap.release()
            with self.condition:
                self.finished = True
                self.condition.notify_all()

    # Consume the pending (index, source_ms, BGR_frame, host_read_time) tuple.
    # None can mean timeout OR completion; the caller checks finished/error.
    def take(self, timeout=0.1):
        with self.condition:
            self.condition.wait_for(lambda: self.slot is not None or self.finished or self.stop.is_set(), timeout)
            item, self.slot = self.slot, None
            self.condition.notify_all()
            return item

    # Wake both sides during shutdown so a file producer waiting on a full slot
    # does not prevent the run from stopping.
    def close(self):
        self.stop.set()
        with self.condition:
            self.condition.notify_all()
        if self.thread.is_alive():
            self.thread.join(timeout=1)
