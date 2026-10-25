"""MediaPipe Tasks API (not deprecated mp.solutions). CPU is the portable baseline."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import time


# Adapter boundary: OpenCV BGR pixels in, plain Python landmark dictionaries out.
# All punch/dodge interpretation lives in Detector, not inside MediaPipe.
class Inference:
    def __init__(self, models, variant='lite', hands=False, schedule='parallel'):
        if schedule not in ('sequential', 'parallel'):
            raise ValueError('schedule must be sequential or parallel')
        self.schedule = schedule
        self.executor = None
        # Import lazily so landmark-only replay does not need the native model runtime.
        import mediapipe as mp
        self.mp = mp
        self.pose = self.hand = None
        self.last_timestamp = -1
        root = Path(models)
        for name in [f'pose_landmarker_{variant}.task'] + (['hand_landmarker.task'] if hands else []):
            if not (root/name).is_file():
                raise FileNotFoundError(f'Missing {root/name}. Run: python scripts/download_models.py')
        base, vision = mp.tasks.BaseOptions, mp.tasks.vision
        # VIDEO mode carries tracking history across ordered timestamps. Process one
        # person, skip segmentation, and use CPU for the tested portable baseline.
        self.pose = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
            base_options=base(model_asset_path=str(root/f'pose_landmarker_{variant}.task'), delegate=base.Delegate.CPU),
            running_mode=vision.RunningMode.VIDEO, num_poses=1,
            min_pose_detection_confidence=0.5, min_pose_presence_confidence=0.5,
            min_tracking_confidence=0.5, output_segmentation_masks=False))
        try:
            if hands:
                self.hand = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
                    base_options=base(model_asset_path=str(root/'hand_landmarker.task'), delegate=base.Delegate.CPU),
                    running_mode=vision.RunningMode.VIDEO, num_hands=2,
                    min_hand_detection_confidence=0.5, min_hand_presence_confidence=0.5,
                    min_tracking_confidence=0.5))
                # The hand task has its own executor thread while pose runs on the caller.
                # These are independent model instances; a task never processes two frames at once.
                if schedule == 'parallel':
                    self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='hand-inference')
        except Exception:
            self.close()
            raise

    # Convert library objects to JSON-friendly numbers. Hands lack the pose
    # visibility/presence fields, so 1.0 here is a placeholder, not measured certainty.
    @staticmethod
    def _points(points, has_confidence=True):
        return [dict(x=float(p.x), y=float(p.y), z=float(p.z),
                     visibility=float(p.visibility) if has_confidence and p.visibility is not None else 1.0,
                     presence=float(p.presence) if has_confidence and p.presence is not None else 1.0)
                for p in points]

    def process(self, frame, timestamp_ms):
        import cv2
        # The adapter accepts only ordered source frames; it never hides time reversal.
        stamp = int(timestamp_ms)
        if stamp <= self.last_timestamp:
            raise ValueError('Inference requires strictly increasing integer milliseconds')
        self.last_timestamp = stamp
        start = time.perf_counter()
        # OpenCV decodes blue-green-red; MediaPipe expects red-green-blue.
        # Preprocessing time includes conversion and wrapping the shared input image.
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        image = self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=rgb)
        pre = time.perf_counter()
        if self.executor:
            # One frame in flight: independent task instances share immutable input.
            # Always join the hand call, even if pose fails, before releasing input.
            pending = self.executor.submit(self._detect_timed, self.hand, image, stamp)
            try:
                pose, pose_ms = self._detect_timed(self.pose, image, stamp)
            finally:
                hand, hand_ms = pending.result()
        else:
            pose, pose_ms = self._detect_timed(self.pose, image, stamp)
            hand, hand_ms = self._detect_timed(self.hand, image, stamp) if self.hand else (None, 0.0)
        end = time.perf_counter()
        # Return the first pose (if any), all detected hands, and timing evidence.
        # When tasks overlap, pose_ms + hand_ms is NOT combined wall time.
        return {'kind': 'frame', 'timestamp_ms': stamp, 'width': frame.shape[1], 'height': frame.shape[0],
                'pose': self._points(pose.pose_landmarks[0]) if pose.pose_landmarks else [],
                'hands': [{'landmarks': self._points(p, False),
                           'model_handedness': hand.handedness[i][0].category_name,
                           'handedness_score': float(hand.handedness[i][0].score)}
                          for i, p in enumerate(hand.hand_landmarks)] if hand else [],
                'timings_ms': {'preprocess': (pre-start)*1000, 'pose': pose_ms,
                               'hands': hand_ms, 'inference_total': (end-pre)*1000}}

    @staticmethod
    def _detect_timed(task, image, stamp):
        start = time.perf_counter()
        result = task.detect_for_video(image, stamp)
        return result, (time.perf_counter()-start)*1000

    # Join hand work before closing native tasks. Setting references to None makes
    # repeated cleanup safe after both normal shutdown and partial initialization.
    def close(self):
        if self.executor:
            self.executor.shutdown(wait=True, cancel_futures=True)
            self.executor = None
        if self.hand:
            self.hand.close()
            self.hand = None
        if self.pose:
            self.pose.close()
            self.pose = None
