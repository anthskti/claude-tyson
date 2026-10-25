import { CvProvider as HaniProvider } from '../../../cv-mvp/web/cv-provider.js';
import type { CvProvider, Observation, MotionEvent } from './contract';
import { SimulatedCvProvider } from './simulatedProvider';

export class RealCvProvider implements CvProvider {
  readonly source = 'live' as const;
  private inner: InstanceType<typeof HaniProvider> | null = null;
  private fallback: SimulatedCvProvider | null = null;
  private fallbackTimer = 0;

  start(onSample: (obs: Observation, events: MotionEvent[]) => void) {
    let gotSample = false;

    // If no good/degraded sample arrives within 3s, fall back to keyboard sim.
    // 'calibrating' samples don't count — those mean the server is up but the user needs to stand in frame.
    // Add ?sim to the URL to skip straight to keyboard simulation.
    this.fallbackTimer = window.setTimeout(() => {
      if (!gotSample) {
        console.log('[cv] no tracking signal — falling back to keyboard simulation (start Python server + calibrate, or use ?sim)');
        this.inner?.close();
        this.inner = null;
        this.fallback = new SimulatedCvProvider();
        this.fallback.start(onSample);
      }
    }, 3000);

    this.inner = new HaniProvider({
      url: 'ws://127.0.0.1:8765',
      onSample: ({ sample, events }) => {
        // Any sample means the server is reachable — cancel the sim fallback.
        // Even 'calibrating' means the server is up; the user just needs to step into frame.
        if (!gotSample) {
          gotSample = true;
          clearTimeout(this.fallbackTimer);
          console.log('[cv] real CV server connected — waiting for good tracking');
        }
        onSample(sample.observation as unknown as Observation, events as unknown as MotionEvent[]);
      },
    });
    this.inner.connect({ fightId: 'local', roundId: '0', atMs: 0 } as Parameters<typeof this.inner.connect>[0])
      .catch(() => {/* fallbackTimer handles this */});
  }

  stop() {
    clearTimeout(this.fallbackTimer);
    this.inner?.close();
    this.inner = null;
    this.fallback?.stop();
    this.fallback = null;
  }
}
