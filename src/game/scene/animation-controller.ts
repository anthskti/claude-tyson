import * as THREE from 'three';

export type ClipSlot = 'jab' | 'cross' | 'left_hook' | 'right_hook' | 'block' | 'dodge_left' | 'dodge_right' | 'hit' | 'ko';
export type HeldSlot = 'block' | 'dodge_left' | 'dodge_right';

const CLIPS: Record<ClipSlot, string> = {
  jab: 'Jab_L',
  cross: 'Cross_R',
  left_hook: 'Hook_L',
  right_hook: 'Hook_R',
  block: 'Hard_Block',
  dodge_left: 'Left_Dodge',
  dodge_right: 'Right_Dodge',
  hit: 'Hit_Head',
  ko: 'Knockout',
};
const IDLE_CLIP = 'Boxing_Idle';
const IDLE_STEP_CLIP = 'Boxing_Idle_Right';
const USED_CLIPS = new Set([IDLE_CLIP, IDLE_STEP_CLIP, ...Object.values(CLIPS)]);
const IDLE_STEP_MIN_MS = 3000;
const IDLE_STEP_MAX_MS = 7000;
const MAX_DEFENSE_HOLD_MS = 2000;
const DEFENSE_PAUSE_AT_SECONDS: Record<HeldSlot, number> = {
  block: 0.33,
  dodge_left: 0.25,
  dodge_right: 0.25,
};
const PUNCH_SLOTS: ClipSlot[] = ['jab', 'cross', 'left_hook', 'right_hook'];

export class BoxingAnimationController {
  private mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private currentAction: THREE.AnimationAction | null = null;
  private idleAction: THREE.AnimationAction | null = null;
  private idleStepAction: THREE.AnimationAction | null = null;
  private heldAction: THREE.AnimationAction | null = null;
  private heldSlot: HeldSlot | null = null;
  private fadeDuration: number;
  private isActionPlaying = false;
  private playingVariation = false;
  private koLocked = false;
  private actionTimeout: ReturnType<typeof setTimeout> | null = null;
  private idleStepTimer: ReturnType<typeof setTimeout> | null = null;
  private holdAtSeconds: number | null = null;
  private defenseHoldStartedAt = 0;
  private onFinished = (event: { action: THREE.AnimationAction }) => {
    if (this.koLocked || this.currentAction !== event.action || event.action === this.idleAction) return;
    if (event.action === this.heldAction) {
      this.isActionPlaying = false;
      event.action.paused = true;
      if (this.holdAtSeconds !== null) event.action.time = this.holdAtSeconds;
      return;
    }
    this.returnToRest();
  };

  constructor(root: THREE.Object3D, clips: THREE.AnimationClip[], fadeDuration = 0.15) {
    this.mixer = new THREE.AnimationMixer(root);
    this.fadeDuration = fadeDuration;
    for (const clip of clips) {
      if (USED_CLIPS.has(clip.name)) this.actions.set(clip.name, this.mixer.clipAction(clip));
    }
    this.idleAction = this.actions.get(IDLE_CLIP) ?? null;
    this.idleStepAction = this.actions.get(IDLE_STEP_CLIP) ?? null;
    this.mixer.addEventListener('finished', this.onFinished as never);
  }

  playIdle(duration = this.fadeDuration): void {
    if (this.koLocked || !this.idleAction) return;
    this.clearActionTimeout();
    this.heldAction = null;
    this.heldSlot = null;
    this.holdAtSeconds = null;
    this.startLoop(this.idleAction, duration);
    this.isActionPlaying = false;
    this.playingVariation = false;
    this.scheduleIdleStep();
  }

  playPunch(slot: ClipSlot): boolean {
    if (!PUNCH_SLOTS.includes(slot)) return false;
    return this.playOneShot(this.actions.get(CLIPS[slot]) ?? null, 0.08);
  }

  playHit(): boolean {
    return this.playOneShot(this.actions.get(CLIPS.hit) ?? null, 0.1);
  }

  /** Play a defense clip to its authored pause point, then hold until release or the 2s cap. */
  playHeld(slot: HeldSlot): boolean {
    if (this.koLocked) return false;
    const action = this.actions.get(CLIPS[slot]);
    if (!action) return false;
    this.heldAction = action;
    this.heldSlot = slot;
    this.holdAtSeconds = Math.min(DEFENSE_PAUSE_AT_SECONDS[slot], action.getClip().duration);
    this.defenseHoldStartedAt = performance.now();
    if (this.isActionPlaying) return true;
    if (this.currentAction === action) return true;
    this.clearActionTimeout();
    this.clearIdleStepTimer();
    this.playOneShot(action, this.fadeDuration);
    this.heldAction = action;
    this.heldSlot = slot;
    this.holdAtSeconds = Math.min(DEFENSE_PAUSE_AT_SECONDS[slot], action.getClip().duration);
    this.defenseHoldStartedAt = performance.now();
    return true;
  }

  releaseHeld(): void {
    if (this.koLocked) return;
    const wasHeld = this.currentAction === this.heldAction;
    this.heldAction = null;
    this.heldSlot = null;
    this.holdAtSeconds = null;
    if (wasHeld) {
      this.isActionPlaying = false;
      this.playIdle();
    }
  }

  playKo(): void {
    if (this.koLocked) return;
    this.koLocked = true;
    this.clearActionTimeout();
    this.clearIdleStepTimer();
    this.heldAction = null;
    this.heldSlot = null;
    this.holdAtSeconds = null;
    const action = this.actions.get(CLIPS.ko);
    if (!action) return;
    this.arm(action, THREE.LoopOnce);
    this.fadeOutOthers(action, this.fadeDuration);
    this.currentAction = action;
    this.isActionPlaying = true;
  }

  reset(): void {
    this.koLocked = false;
    this.heldAction = null;
    this.heldSlot = null;
    this.holdAtSeconds = null;
    this.playIdle();
  }

  update(delta: number): void {
    this.mixer.update(delta);
    if (this.heldAction && performance.now() - this.defenseHoldStartedAt >= MAX_DEFENSE_HOLD_MS) {
      this.releaseHeld();
    }
    if (this.heldAction && this.holdAtSeconds !== null && this.heldAction.time >= this.holdAtSeconds) {
      this.isActionPlaying = false;
      this.heldAction.time = this.holdAtSeconds;
      this.heldAction.paused = true;
    }
  }

  dispose(): void {
    this.clearActionTimeout();
    this.clearIdleStepTimer();
    this.mixer.removeEventListener('finished', this.onFinished as never);
    this.mixer.stopAllAction();
  }

  private playOneShot(action: THREE.AnimationAction | null, fadeTime: number, variation = false): boolean {
    if (this.koLocked || !action) return false;
    this.clearActionTimeout();
    this.clearIdleStepTimer();
    this.heldAction = null;
    this.heldSlot = null;
    this.holdAtSeconds = null;
    this.arm(action, THREE.LoopOnce);
    this.fadeOutOthers(action, fadeTime);
    this.currentAction = action;
    this.isActionPlaying = true;
    this.playingVariation = variation;
    const clipDuration = action.getClip().duration;
    const safetyMs = Math.max(500, (clipDuration > 0 ? clipDuration : 0.67) * 1000 + 100);
    this.actionTimeout = setTimeout(() => {
      if (this.isActionPlaying && this.currentAction === action && !this.koLocked && !this.heldAction) {
        this.returnToRest();
      }
    }, safetyMs);
    return true;
  }

  private scheduleIdleStep(): void {
    this.clearIdleStepTimer();
    if (!this.idleStepAction || this.koLocked) return;
    const delay = IDLE_STEP_MIN_MS + Math.random() * (IDLE_STEP_MAX_MS - IDLE_STEP_MIN_MS);
    this.idleStepTimer = setTimeout(() => {
      this.idleStepTimer = null;
      if (this.currentAction !== this.idleAction || this.isActionPlaying || this.heldAction) {
        this.scheduleIdleStep();
        return;
      }
      this.playOneShot(this.idleStepAction, 0.2, true);
    }, delay);
  }

  private returnToRest(): void {
    if (this.koLocked) return;
    this.clearActionTimeout();
    this.isActionPlaying = false;
    this.playingVariation = false;
    const next = this.heldAction;
    const nextSlot = this.heldSlot;
    if (next) {
      this.playOneShot(next, this.fadeDuration);
      this.heldAction = next;
      this.heldSlot = nextSlot;
      if (nextSlot) this.holdAtSeconds = Math.min(DEFENSE_PAUSE_AT_SECONDS[nextSlot], next.getClip().duration);
      this.defenseHoldStartedAt = performance.now();
      return;
    }
    this.playIdle();
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
    action.paused = false;
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

  private clearActionTimeout(): void {
    if (this.actionTimeout) {
      clearTimeout(this.actionTimeout);
      this.actionTimeout = null;
    }
  }

  private clearIdleStepTimer(): void {
    if (this.idleStepTimer) {
      clearTimeout(this.idleStepTimer);
      this.idleStepTimer = null;
    }
  }
}
