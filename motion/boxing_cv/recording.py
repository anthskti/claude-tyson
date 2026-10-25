"""AVI recording on a stable canvas, including cameras that change resolution."""
import cv2
import numpy as np


class VideoRecorder:
    def __init__(self, path, fps, size):
        self.path = str(path)
        self.width, self.height = map(int, size)
        if any(n <= 0 or n % 2 for n in (self.width, self.height)):
            raise ValueError('AVI recording width and height must be positive even integers')
        self.writer = cv2.VideoWriter(self.path, cv2.VideoWriter_fourcc(*'MJPG'), fps,
                                      (self.width, self.height))
        self.frames = 0
        if not self.writer.isOpened():
            self.writer.release()
            raise RuntimeError('Cannot open AVI writer')

    def write(self, frame, timestamp_ms):
        """Preserve aspect ratio and return metadata for the written frame.

        Inference retains the original frame. Sidecar dimensions/content rectangle
        allow its source-pixel coordinates to be mapped onto the encoded canvas.
        """
        if frame.dtype != np.uint8 or frame.ndim != 3 or frame.shape[2] != 3:
            raise ValueError('AVI recording requires uint8 BGR frames')
        h, w = frame.shape[:2]
        if not h or not w:
            raise ValueError('Cannot record an empty frame')
        scale = min(self.width/w, self.height/h)
        rw, rh = max(1, round(w*scale)), max(1, round(h*scale))
        x, y = (self.width-rw)//2, (self.height-rh)//2
        if (w, h) == (self.width, self.height):
            encoded = np.ascontiguousarray(frame)
        else:
            encoded = np.zeros((self.height, self.width, 3), dtype=np.uint8)
            resized = cv2.resize(frame, (rw, rh), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)
            encoded[y:y+rh, x:x+rw] = resized
        self.writer.write(encoded)
        self.frames += 1
        return dict(timestamp_ms=timestamp_ms, source_width=w, source_height=h,
                    encoded_width=self.width, encoded_height=self.height,
                    content_rect=dict(x=x, y=y, width=rw, height=rh))

    def close(self):
        self.writer.release()
        if self.frames:
            # Check after finalization, off the IMU thread. OpenCV write() has no
            # return status and can silently drop frames with invalid dimensions.
            cap = cv2.VideoCapture(self.path)
            try:
                saved = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) if cap.isOpened() else 0
            finally:
                cap.release()
            if saved != self.frames:
                raise RuntimeError(f'AVI recording incomplete: {saved} frames saved, {self.frames} submitted')
