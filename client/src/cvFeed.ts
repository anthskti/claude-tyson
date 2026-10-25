// Small webcam PiP overlay drawn in the bottom-left during gameplay.
// Shows the webcam feed + pose marker dots so the player can see how the CV perceives them.

import type { Observation } from './cv/contract';

export class CvFeed {
  private wrap: HTMLElement;
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private stream: MediaStream | null = null;
  private latest: Observation | null = null;
  private raf = 0;

  constructor() {
    this.wrap = document.createElement('div');
    this.wrap.id = 'cv-feed';

    this.video = document.createElement('video');
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = true;

    this.canvas = document.createElement('canvas');
    this.canvas.width = 160;
    this.canvas.height = 120;
    this.ctx = this.canvas.getContext('2d')!;

    this.wrap.appendChild(this.video);
    this.wrap.appendChild(this.canvas);
    document.body.appendChild(this.wrap);

    this.startCamera();
    this.loop();
  }

  private async startCamera() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 320, height: 240, facingMode: 'user' },
        audio: false,
      });
      this.video.srcObject = this.stream;
    } catch {
      // Camera unavailable — hide the pip
      this.wrap.style.display = 'none';
    }
  }

  /** Call this every time a new CV observation arrives. */
  update(obs: Observation) {
    this.latest = obs;
  }

  private loop() {
    this.raf = requestAnimationFrame(() => this.loop());
    const obs = this.latest;
    const W = this.canvas.width;
    const H = this.canvas.height;
    this.ctx.clearRect(0, 0, W, H);

    if (!obs) return;

    const state = obs.trackingState;
    const markers = obs.markers;

    // Tracking state border is drawn by CSS class, update here
    this.wrap.dataset.state = state;

    // Draw dots for each marker (coords are unmirrored; video is CSS-mirrored)
    const dot = (nx: number, ny: number, color: string, r = 5) => {
      // Mirror x to match the mirrored video display
      const px = (1 - nx) * W;
      const py = ny * H;
      this.ctx.beginPath();
      this.ctx.arc(px, py, r, 0, Math.PI * 2);
      this.ctx.fillStyle = color;
      this.ctx.fill();
    };

    if (markers.head) dot(markers.head.x, markers.head.y, '#00f5ff', 4);
    if (markers.left) dot(markers.left.x, markers.left.y, '#f0a828', 5);
    if (markers.right) dot(markers.right.x, markers.right.y, '#cc88ff', 5);

    // Label
    this.ctx.font = 'bold 9px monospace';
    this.ctx.fillStyle = state === 'good' ? '#39ff14' : state === 'calibrating' ? '#f0a828' : '#ff2929';
    this.ctx.fillText(state.toUpperCase(), 4, 12);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach(t => t.stop());
    this.wrap.remove();
  }
}
