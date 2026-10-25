// Small webcam preview for camera input, so the player can see whether they're in frame.
// The video comes from the browser (getUserMedia) and never leaves the page; the dots are
// the classifier's head/wrist markers, so they show what it actually tracks. The same
// video feeds in-browser classification (browserCv.ts).

import type { Guard } from './contract';
import type { VideoSource } from './browserCv';
import type { CameraMarkers } from './guard';

const W = 240;
const H = 180;
const STALE_MS = 500;

export class CameraFeed implements VideoSource {
  readonly root = document.createElement('div');
  private videoEl = document.createElement('video');
  private failure: string | null = null;
  private testVideo = false;
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private stream: MediaStream | null = null;
  private markers: CameraMarkers = {};
  private guards: Record<'left' | 'right', Guard> = { left: 'neutral', right: 'neutral' };
  private markersAt = -Infinity;
  private note = '';
  private raf = 0;

  constructor(parent: HTMLElement) {
    this.root.className = 'camera-feed';
    this.videoEl.muted = true;
    this.videoEl.playsInline = true;
    this.canvas.width = W * 2;
    this.canvas.height = H * 2;
    this.root.append(this.videoEl, this.canvas);
    this.root.style.display = 'none';
    parent.appendChild(this.root);
  }

  async show() {
    this.root.style.display = 'block';
    if (!this.raf) this.raf = requestAnimationFrame(this.draw);
    if (this.stream || this.testVideo) return;
    // `?cvVideo=/clip.mp4` plays a same-origin recording in place of the webcam, for
    // testing camera input without a camera.
    const clip = new URLSearchParams(location.search).get('cvVideo');
    if (clip) {
      this.testVideo = true;
      Object.assign(this.videoEl, { src: clip, loop: true });
      await this.videoEl.play().catch(() => (this.failure = `cannot play ${clip}`));
      return;
    }
    try {
      this.failure = null;
      // 640x480 is what the detector was tuned on (cv-mvp's capture default).
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
      this.videoEl.srcObject = this.stream;
      await this.videoEl.play();
      this.note = '';
    } catch (e) {
      // Markers still draw on a dark box, which is enough to tell if you're in frame.
      this.note = 'video blocked · markers only';
      this.failure = e instanceof DOMException && e.name === 'NotAllowedError'
        ? 'camera blocked: allow camera access for this site'
        : 'no camera available';
    }
  }

  video(): HTMLVideoElement | null {
    return this.stream || this.testVideo ? this.videoEl : null;
  }

  error(): string | null {
    return this.failure ?? (this.videoEl.error ? 'camera video cannot be decoded' : null);
  }

  hide() {
    this.root.style.display = 'none';
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.videoEl.srcObject = null;
    if (this.testVideo) {
      this.videoEl.pause();
      this.videoEl.removeAttribute('src');
      this.testVideo = false;
    }
  }

  update(markers: CameraMarkers, guards: Record<'left' | 'right', Guard>) {
    this.markers = markers;
    this.guards = guards;
    this.markersAt = performance.now();
  }

  private draw = () => {
    this.raf = requestAnimationFrame(this.draw);
    const { ctx } = this;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    const m = performance.now() - this.markersAt < STALE_MS ? this.markers : {};
    const tracked = [m.head, m.left, m.right].filter(Boolean).length;
    this.root.dataset.framed = tracked === 3 ? 'all' : tracked > 0 ? 'some' : 'none';

    // Markers are unmirrored image coords; the video is shown mirrored like a selfie.
    const at = (p: { x: number; y: number }) => [(1 - p.x) * w, p.y * h] as const;
    if (m.head) {
      const [x, y] = at(m.head);
      ctx.strokeStyle = '#2ecc71';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(x, y, 26, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const hand of ['left', 'right'] as const) {
      const p = m[hand];
      if (!p) continue;
      const [x, y] = at(p);
      const block = this.guards[hand] === 'block';
      ctx.fillStyle = block ? '#3498db' : hand === 'left' ? '#e74c3c' : '#f1c40f';
      ctx.beginPath();
      ctx.arc(x, y, block ? 16 : 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = 'bold 22px ui-sans-serif, system-ui';
      ctx.fillStyle = '#fff';
      ctx.fillText(hand === 'left' ? 'L' : 'R', x + 16, y - 12);
    }

    const label = tracked === 3 ? 'in frame' : tracked === 0 ? 'not tracked' : 'partly in frame';
    ctx.font = 'bold 22px ui-sans-serif, system-ui';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, h - 36, w, 36);
    ctx.fillStyle = '#fff';
    ctx.fillText(this.note ? `${label} · ${this.note}` : label, 12, h - 11);
  };
}
