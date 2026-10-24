"""Opt-in debug view: the camera frame with landmarks and punch-type evidence drawn
on it, served as MJPEG on loopback (--preview-port). Off by default. Frames never
go over the game WebSocket; this is a separate local HTTP stream for tuning.
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Condition, Thread
import time
from .core.features import PALM, SIDES, point_ok
import math
from .punch_type import ELBOW, INWARD, POSE_WRIST, SHOULDER

HAND_LINKS = [(0, 1), (1, 2), (2, 3), (3, 4), (0, 5), (5, 6), (6, 7), (7, 8), (5, 9), (9, 10), (10, 11),
              (11, 12), (9, 13), (13, 14), (14, 15), (15, 16), (13, 17), (0, 17), (17, 18), (18, 19), (19, 20)]
POSE_LINKS = [(11, 12), (11, 13), (13, 15), (12, 14), (14, 16), (11, 23), (12, 24), (23, 24)]
# BGR. Player's left = cyan, right = orange, matching the smoke page head/wrist colors.
COLOR = {"left": (204, 221, 101), "right": (60, 160, 255)}
GOOD, WARN, DIM, WHITE = (120, 220, 120), (60, 200, 255), (110, 110, 110), (255, 255, 255)
PAGE = b"""<!doctype html><meta charset="utf-8"><title>CV preview</title>
<style>body{margin:0;background:#101923;color:#eef4f8;font:14px system-ui;text-align:center}
img{max-width:100%;height:auto}p{margin:8px}</style>
<p>Mirrored like a selfie. Dashed lines: shoulder lines (wrist at or outside = wide).
Rays from each shoulder: the elbow angle a hook needs. Labels are the player's left/right.</p><img src="/stream">"""


class Preview:
    def __init__(self, port, host="127.0.0.1", quality=70):
        import cv2
        import numpy as np

        self.cv2, self.np = cv2, np
        self.host, self.port, self.quality = host, port, quality
        self.condition = Condition()
        self.jpeg = None
        self.serial = 0
        self.flash = []  # (until_s, text, side)
        self.server = None

    def start(self):
        preview = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                if self.path == "/":
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.end_headers()
                    self.wfile.write(PAGE)
                    return
                if self.path != "/stream":
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                seen = -1
                try:
                    while True:
                        with preview.condition:
                            preview.condition.wait_for(lambda: preview.serial != seen, timeout=2)
                            jpeg, seen = preview.jpeg, preview.serial
                        if jpeg is None:
                            continue
                        self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                                         + str(len(jpeg)).encode() + b"\r\n\r\n" + jpeg + b"\r\n")
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.server = ThreadingHTTPServer((self.host, self.port), Handler)
        self.server.daemon_threads = True
        Thread(target=self.server.serve_forever, daemon=True, name="cv-preview").start()
        return self

    def close(self):
        if self.server:
            self.server.shutdown()
            self.server.server_close()

    def update(self, frame, record, packet, typer):
        """Draw on a mirrored copy of the frame (black canvas for synthetic/replay)."""
        cv2 = self.cv2
        w, h = record["width"], record["height"]
        img = cv2.flip(frame, 1) if frame is not None else self.np.zeros((h, w, 3), self.np.uint8)
        P = lambda p: (int((1 - p["x"]) * w), int(p["y"] * h))
        pose = record.get("pose", [])
        vis = typer.detector_cfg.min_visibility
        if len(pose) == 33:
            for a, b in POSE_LINKS:
                if point_ok(pose[a], 0.3) and point_ok(pose[b], 0.3):
                    cv2.line(img, P(pose[a]), P(pose[b]), WHITE if min(pose[a]["visibility"], pose[b]["visibility"]) >= vis else DIM, 2)
            if point_ok(pose[0], 0.3):
                cv2.circle(img, P(pose[0]), 7, (117, 211, 255), -1)
            for side in SIDES:
                for i in (SHOULDER[side], ELBOW[side], POSE_WRIST[side]):
                    if point_ok(pose[i], 0.3):
                        cv2.circle(img, P(pose[i]), 6, COLOR[side] if pose[i]["visibility"] >= vis else DIM, -1)
        for hand in record.get("hands", []):
            side = str(hand.get("model_handedness", "")).lower()
            pts = hand.get("landmarks", [])
            if len(pts) < 21:
                continue
            color = COLOR.get(side, DIM)
            for a, b in HAND_LINKS:
                if point_ok(pts[a]) and point_ok(pts[b]):
                    cv2.line(img, P(pts[a]), P(pts[b]), color, 1)
            if point_ok(pts[0]):
                cv2.circle(img, P(pts[0]), 6, color, 2)  # contract wrist
            c = {k: sum(pts[i][k] for i in PALM) / len(PALM) for k in ("x", "y")}
            cv2.circle(img, P(c), 4, WHITE, -1)  # palm center the core detector tracks
        self._guides(img, pose, typer, w, h, P)
        self._panel(img, record, packet, typer, w, h)
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, self.quality])
        if ok:
            with self.condition:
                self.jpeg, self.serial = buf.tobytes(), self.serial + 1
                self.condition.notify_all()

    def _guides(self, img, pose, typer, w, h, P):
        cv2 = self.cv2
        if len(pose) != 33 or not typer.scale:
            return
        aspect = h / w
        for side in SIDES:
            s = pose[SHOULDER[side]]
            if not point_ok(s, typer.detector_cfg.min_visibility):
                continue
            x, _ = P(s)
            # Shoulder line, dashed: a wrist outside it (away from the body) counts as wide.
            for y0 in range(0, h, 16):
                cv2.line(img, (x, y0), (x, min(h, y0 + 8)), COLOR[side], 1)
            # The hook elbow angle, drawn as a ray out from the shoulder (0 = arm down).
            theta = math.radians(typer.cfg.hook_elbow_angle)
            length = 0.8 * typer.scale
            end = dict(x=s["x"] - INWARD[side] * math.sin(theta) * length,
                       y=s["y"] + math.cos(theta) * length / aspect)
            cv2.line(img, P(s), P(end), COLOR[side], 2)
            cv2.putText(img, f"{typer.cfg.hook_elbow_angle:.0f}", P(end), cv2.FONT_HERSHEY_SIMPLEX, 0.5, COLOR[side], 1)
            e = pose[ELBOW[side]]
            if point_ok(e, typer.cfg.min_elbow_visibility):
                ux, uy = e["x"] - s["x"], aspect * (e["y"] - s["y"])
                angle = math.degrees(math.atan2(abs(ux), uy))
                cv2.putText(img, f"{angle:.0f}deg", (P(e)[0] + 10, P(e)[1]), cv2.FONT_HERSHEY_SIMPLEX, 0.6,
                            GOOD if angle >= typer.cfg.hook_elbow_angle else WHITE, 2)

    def _panel(self, img, record, packet, typer, w, h):
        cv2 = self.cv2
        now = time.monotonic()
        for e in packet["events"]:
            side = e["type"].split("_")[-1]
            text = (e.get("punchType") or e["type"]).upper()
            if e["type"].startswith("punch_"):
                text += f" ({side[0].upper()})"
            self.flash.append((now + 0.9, text, side))
        self.flash = [f for f in self.flash if f[0] > now][-3:]
        for i, (_, text, side) in enumerate(reversed(self.flash)):
            cv2.putText(img, text, (20, 60 + 46 * i), cv2.FONT_HERSHEY_DUPLEX, 1.4, COLOR.get(side, WHITE), 3)
        o = packet["observation"]
        cv2.putText(img, f"{o['trackingState']}  {packet['source']}", (20, h - 70), cv2.FONT_HERSHEY_SIMPLEX, 0.55, WHITE, 1)
        # Screen-left is the player's left in this mirrored view.
        for side, x in (("left", 20), ("right", w // 2 + 10)):
            m = typer._measure(side, record["timestamp_ms"], typer.cfg.window_ms) if typer.history[side] else None
            if not m:
                cv2.putText(img, f"{side[0].upper()}: no hand", (x, h - 40), cv2.FONT_HERSHEY_SIMPLEX, 0.55, DIM, 1)
                continue
            raised = m.get("elbowRaisedAny")
            out = m.get("wristOutward")
            wide = out is not None and out >= typer.cfg.hook_wrist_outside
            sweep = typer._sweeping(m) if out is not None else False
            now_angle = m.get("elbowAngleNow")
            elbow = "elbow ?" if raised is None else f"{'ELBOW UP' if raised else 'elbow down'}" + \
                (f" {now_angle:.0f}deg" if now_angle is not None else "")
            wrist = "wrist ?" if out is None else f"{'WIDE' if wide else 'in front'} {out:+.2f}"
            cv2.putText(img, f"{side[0].upper()}: {elbow}", (x, h - 40), cv2.FONT_HERSHEY_SIMPLEX, 0.55,
                        GOOD if raised else (DIM if raised is None else WHITE), 1)
            cv2.putText(img, f"{wrist}  {'SWEEP' if sweep else ''} in {m['inwardBodyWidths']:.2f}", (x, h - 16),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, WARN if wide else WHITE, 1)
