// Small webcam preview for camera input, so the player can see whether they're in frame.
// The video comes from the browser (getUserMedia) and never leaves the page; the dots are
// the CV bridge's head/wrist markers, so they show what the classifier actually tracks.

import type { Guard } from './contract';
import type { CameraMarkers } from './guard';

const W = 240;
const H = 180;
const STALE_MS = 500;

export class CameraFeed {
  readonly root = document.createElement('div');
  private video = document.createElement('video');
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
    this.video.muted = true;
    this.video.playsInline = true;
    this.canvas.width = W * 2;
    this.canvas.height = H * 2;
    this.root.append(this.video, this.canvas);
    this.root.style.display = 'none';
    parent.appendChild(this.root);
  }

  async show() {
    this.root.style.display = 'block';
    if (!this.raf) this.raf = requestAnimationFrame(this.draw);
    if (this.stream) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 }, audio: false });
      this.video.srcObject = this.stream;
      await this.video.play();
      this.note = '';
    } catch {
      // Markers still draw on a dark box, which is enough to tell if you're in frame.
      this.note = 'video blocked · markers only';
    }
  }

  hide() {
    this.root.style.display = 'none';
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.video.srcObject = null;
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
