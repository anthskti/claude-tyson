import * as THREE from 'three';

// Same mixer behaviour as the 3d-test controller: idle loops, one-shots fade in
// at full weight (never to a T-pose) and return to idle when they finish.
// Clip names follow the design contract. A missing punch falls back to Jab_L,
// which is the only punch in the current claude_bot.glb.

export type ClipSlot = 'jab' | 'cross' | 'left_hook' | 'right_hook' | 'block' | 'dodge_left' | 'dodge_right' | 'hit' | 'ko';
export type HeldSlot = 'block' | 'dodge_left' | 'dodge_right';

const CANDIDATES: Record<ClipSlot, string[]> = {
  jab: ['Jab', 'Jab_L'],
  cross: ['Cross'],
  left_hook: ['Hook_L'],
  right_hook: ['Hook_R'],
  block: ['Block'],
  dodge_left: ['Dodge_L'],
  dodge_right: ['Dodge_R'],
  hit: ['Hit_Head'],
  ko: ['KO'],
};

const PUNCH_SLOTS: ClipSlot[] = ['jab', 'cross', 'left_hook', 'right_hook'];

function usableClip(name: string): boolean {
  const n = name.toLowerCase();
  return n !== 'rigaction' && !n.includes('stance');
}

export class BoxingAnimationController {
  private mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private currentAction: THREE.AnimationAction | null = null;
  private idleAction: THREE.AnimationAction | null = null;
  private heldAction: THREE.AnimationAction | null = null;
  private fadeDuration: number;
  private isActionPlaying = false;
  private koLocked = false;
  private actionTimeout: ReturnType<typeof setTimeout> | null = null;
  private onFinished = (e: { action: THREE.AnimationAction }) => {
    if (this.koLocked) return;
    if (this.currentAction === e.action && e.action !== this.idleAction && e.action !== this.heldAction) {
      this.returnToRest();
    }
  };

  constructor(root: THREE.Object3D, clips: THREE.AnimationClip[], fadeDuration = 0.15) {
    this.mixer = new THREE.AnimationMixer(root);
    this.fadeDuration = fadeDuration;
    for (const clip of clips) {
      if (!usableClip(clip.name)) continue;
      const action = this.mixer.clipAction(clip);
      this.actions.set(clip.name, action);
      this.actions.set(clip.name.toLowerCase(), action);
    }
    this.idleAction = this.findAction(['Boxing_Idle']) ?? this.actions.values().next().value ?? null;
    this.mixer.addEventListener('finished', this.onFinished as never);
  }

  playIdle(duration = this.fadeDuration): void {
    if (this.koLocked || !this.idleAction) return;
    this.clearTimeout();
    this.heldAction = null;
    this.startLoop(this.idleAction, duration);
    this.isActionPlaying = false;
  }

  /** One-shot punch. Missing clips fall back to Jab_L. Returns false if nothing played. */
  playPunch(slot: ClipSlot): boolean {
    if (!PUNCH_SLOTS.includes(slot)) return false;
    const action = this.findAction(CANDIDATES[slot]) ?? this.findAction(CANDIDATES.jab);
    return this.playOneShot(action, 0.08);
  }

  playHit(): boolean {
    return this.playOneShot(this.findAction(CANDIDATES.hit), 0.1);
  }

  /** Loop a block or dodge until releaseHeld. A missing clip leaves the current pose alone. */
  playHeld(slot: HeldSlot): boolean {
    if (this.koLocked) return false;
    const action = this.findAction(CANDIDATES[slot]);
    if (!action) return false;
    this.heldAction = action;
    // Let a jab or hit finish, then returnToRest resumes this loop.
    if (this.isActionPlaying) return true;
    if (this.currentAction === action) return true;
    this.clearTimeout();
    this.startLoop(action, this.fadeDuration);
    this.isActionPlaying = false;
    return true;
  }

  releaseHeld(): void {
    if (this.koLocked) return;
    this.heldAction = null;
    if (!this.isActionPlaying) this.playIdle();
  }

  /** Terminal. Plays KO once when that clip exists, and ignores later combat clips. */
  playKo(): void {
    if (this.koLocked) return;
    this.koLocked = true;
    this.clearTimeout();
    this.heldAction = null;
    const action = this.findAction(CANDIDATES.ko);
    if (!action) return;
    this.arm(action, THREE.LoopOnce);
    this.fadeOutOthers(action, this.fadeDuration);
    this.currentAction = action;
    this.isActionPlaying = true;
  }

  /** Clear a finished fight so the next one can idle again. */
  reset(): void {
    this.koLocked = false;
    this.heldAction = null;
    this.playIdle();
  }

  update(delta: number): void {
    this.mixer.update(delta);
  }

  dispose(): void {
    this.clearTimeout();
    this.mixer.removeEventListener('finished', this.onFinished as never);
    this.mixer.stopAllAction();
  }

  private findAction(candidates: string[]): THREE.AnimationAction | null {
    for (const name of candidates) {
      const action = this.actions.get(name) ?? this.actions.get(name.toLowerCase());
      if (action) return action;
    }
    return null;
  }

  private playOneShot(action: THREE.AnimationAction | null, fadeTime: number): boolean {
    if (this.koLocked || !action) return false;
    this.clearTimeout();
    this.arm(action, THREE.LoopOnce);
    this.fadeOutOthers(action, fadeTime);
    this.currentAction = action;
    this.isActionPlaying = true;

    const clipDuration = action.getClip().duration;
    const safetyMs = Math.max(250, (clipDuration > 0 ? clipDuration : 0.67) * 1000 + 100);
    this.actionTimeout = setTimeout(() => {
      if (this.isActionPlaying && this.currentAction === action && !this.koLocked) this.returnToRest();
    }, safetyMs);
    return true;
  }

  private returnToRest(duration = this.fadeDuration): void {
    if (this.koLocked) return;
    this.clearTimeout();
    this.isActionPlaying = false;
    const next = this.heldAction ?? this.idleAction;
    if (!next) return;
    this.startLoop(next, duration);
  }

  private startLoop(action: THREE.AnimationAction, duration: number): void {
    this.arm(action, THREE.LoopRepeat);
    action.clampWhenFinished = false;
    this.fadeOutOthers(action, duration);
    this.currentAction = action;
  }

  private arm(action: THREE.AnimationAction, loop: THREE.AnimationActionLoopStyles): void {
    action.reset();
    action.stopFading();
    action.enabled = true;
    action.setEffectiveTimeScale(1);
    action.setEffectiveWeight(1);
    action.setLoop(loop, loop === THREE.LoopOnce ? 1 : Infinity);
    action.clampWhenFinished = loop === THREE.LoopOnce;
    action.play();
  }

  private fadeOutOthers(next: THREE.AnimationAction, duration: number): void {
    if (this.currentAction && this.currentAction !== next) {
      this.currentAction.stopFading();
      this.currentAction.fadeOut(duration);
    }
  }

  private clearTimeout(): void {
    if (this.actionTimeout) {
      clearTimeout(this.actionTimeout);
      this.actionTimeout = null;
    }
  }
}
