// Pre-fight calibration screen.
// Shows webcam feed + instructions. Auto-dismisses when tracking reaches 'good',
// or when the real provider falls back to simulated input.
// In ?sim mode this is never shown.

import type { TrackingState } from './cv/contract';

export class CalibrationScreen {
  private el: HTMLElement;
  private statusEl: HTMLElement;
  private videoEl: HTMLVideoElement;
  private dismissed = false;
  private stream: MediaStream | null = null;

  constructor(useSim: boolean) {
    this.el = document.createElement('div');
    this.el.id = 'calibration';

    this.videoEl = document.createElement('video');
    this.videoEl.autoplay = true;
    this.videoEl.playsInline = true;
    this.videoEl.muted = true;
    this.videoEl.className = 'calib-video';

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'calib-status';
    this.statusEl.textContent = 'Connecting to camera…';

    this.el.innerHTML = `
      <div class="calib-inner">
        <div class="calib-title">CLAUDE TYSON</div>
        <div class="calib-subtitle">CALIBRATION</div>
        <div class="calib-video-wrap"></div>
        <div class="calib-instructions">
          Stand <strong>2–3 metres</strong> from your webcam<br>
          Raise your hands to <strong>guard position</strong>
        </div>
      </div>`;

    this.el.querySelector('.calib-video-wrap')!.appendChild(this.videoEl);
    this.el.querySelector('.calib-inner')!.appendChild(this.statusEl);
    document.body.appendChild(this.el);

    if (useSim) {
      // Keyboard sim: skip calibration entirely
      this.dismiss();
      return;
    }

    this.startCamera();
  }

  private async startCamera() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      this.videoEl.srcObject = this.stream;
      this.statusEl.textContent = 'Waiting for pose…';
    } catch {
      this.statusEl.textContent = 'No camera — connect one and reload.';
    }
  }

  /** Called from main.ts every time cv tracking state changes. */
  onTrackingState(state: TrackingState) {
    if (this.dismissed) return;
    if (state === 'calibrating') {
      this.statusEl.textContent = 'Calibrating… hold your guard';
    } else if (state === 'good') {
      this.statusEl.textContent = '✓ Tracking good — starting…';
      this.el.classList.add('calib-ready');
      setTimeout(() => this.dismiss(), 900);
    }
  }

  /** Called when the fallback to sim kicks in (Python server unavailable). */
  onSimFallback() {
    if (this.dismissed) return;
    this.statusEl.textContent = 'No CV server — using keyboard controls';
    this.el.classList.add('calib-ready');
    setTimeout(() => this.dismiss(), 1200);
  }

  private dismiss() {
    if (this.dismissed) return;
    this.dismissed = true;
    this.el.classList.add('calib-done');
    setTimeout(() => {
      this.el.remove();
      this.stream?.getTracks().forEach(t => t.stop());
      this.stream = null;
    }, 500);
  }
}
