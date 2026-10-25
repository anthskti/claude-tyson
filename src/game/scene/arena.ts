import * as THREE from 'three';
import { loadRing } from './ring';
import { Boxer, cornerOf, type AnyPunch } from './boxer';
import type { Body, Guard } from '../cv/contract';
import type { AttackRow, RingView } from '../net/server';

// The multiplayer arena: RING_COUNT rings in a 2 × 2 grid, each showing whatever match the
// server put there, both fighters third-person and driven only by server rows.
//
// The ring in focus sits at the origin, where the first-person scene in main.ts lives, so
// the rest of the arena is laid out around whoever is looking. While the player fights,
// their own ring is hidden here and drawn first-person instead, and the arena turns so
// they look out from their own corner: the first-person camera always faces -Z, which is
// red's view, so blue sees the arena turned half way round. Either way one of the two
// fighters faces the neighbouring row of rings.

// Keep in step with RING_COUNT in spacetimedb/src/index.ts.
export const RING_COUNT = 4;
// The ring model is ~11 m post to post, ~12.3 m with its apron.
const SPACING_M = 16;
const COLUMNS = 2;
const BODY_WIDTH_M = 0.55;
// Facing each other across the centre, a step closer than the first-person distance.
const CORNER_Z = 1.1;

function gridPosition(ring: number): THREE.Vector3 {
  const col = ring % COLUMNS;
  const row = Math.floor(ring / COLUMNS);
  const rows = Math.ceil(RING_COUNT / COLUMNS);
  return new THREE.Vector3((col - (COLUMNS - 1) / 2) * SPACING_M, 0, (row - (rows - 1) / 2) * SPACING_M);
}

class RingStage {
  readonly root = new THREE.Group();
  readonly light = new THREE.SpotLight(0xfff4e0, 90, 18, Math.PI / 5, 0.5, 1.4);
  // Slot 0 (red) stands on +Z facing -Z; slot 1 (blue) faces it.
  readonly boxers: [Boxer, Boxer] = [
    new Boxer({ position: new THREE.Vector3(0, 0, CORNER_Z), facing: Math.PI }),
    new Boxer({ position: new THREE.Vector3(0, 0, -CORNER_Z) }),
  ];
  private matchId?: bigint;
  private bots: [boolean, boolean] = [true, true];

  constructor() {
    this.light.position.set(0, 9, 0);
    this.root.add(this.light, this.light.target, ...this.boxers.map(b => b.root));
  }

  sync(view: RingView) {
    const match = view.match;
    for (const b of this.boxers) b.root.visible = !!match;
    if (!match) {
      this.matchId = undefined;
      return;
    }
    if (match.id !== this.matchId) {
      this.matchId = match.id;
      for (const b of this.boxers) b.standUp();
    }
    view.fighters.forEach((f, slot) => {
      const boxer = this.boxers[slot];
      if (!boxer) return;
      this.bots[slot] = !f.identity;
      // The PvE bot keeps the Claude look; humans and exhibition bots wear their corner.
      boxer.setLook(match.mode === 'bot' && !f.identity ? 'claude' : cornerOf(slot));
      // A fighter's own right is +X for red (facing -Z) and -X for blue.
      boxer.targetLateral = (slot === 0 ? 1 : -1) * f.lateral * BODY_WIDTH_M * 0.5;
      if (f.identity) boxer.setPose(f.bodyState as Body, f.leftGuard as Guard, f.rightGuard as Guard);
      if (f.health <= 0) boxer.knockout();
    });
  }

  owns(matchId: bigint): boolean {
    return this.matchId === matchId;
  }

  attack(atk: AttackRow) {
    this.boxers[atk.attackerSlot]?.throwPunch(atk.hand as 'left' | 'right', atk.punchType as AnyPunch, 0, 0);
  }

  resolved(atk: AttackRow) {
    const defender = 1 - atk.attackerSlot;
    // Bots choose their defence at impact, so it only shows now.
    if (this.bots[defender]) this.boxers[defender].showDefense(atk.defenderBody as Body, atk.defenderGuard);
    if (atk.result === 'landed') this.boxers[defender].takeHit();
  }

  update(dt: number, now: number) {
    if (!this.root.visible) return;
    for (const b of this.boxers) if (b.root.visible) b.update(dt, now);
  }
}

export class Arena {
  readonly root = new THREE.Group();
  private stages: RingStage[] = [];
  private focus = -1;
  private hideFocus = false;
  private turned = false;

  constructor() {
    this.root.visible = false;
    for (let i = 0; i < RING_COUNT; i++) {
      const stage = new RingStage();
      this.stages.push(stage);
      this.root.add(stage.root);
    }
    // Share the asset load and reveal all four ring copies in the same frame.
    void Promise.all(this.stages.map(() => loadRing())).then(rings => {
      rings.forEach((ring, i) => this.stages[i].root.add(ring));
      this.root.visible = true;
    });
    this.setFocus(null, false);
  }

  /**
   * Centre on a ring for spectating or fighting. Null keeps the shared grid origin
   * between the four rings for the lobby camera.
   */
  setFocus(ring: number | null, hide: boolean, turned = false) {
    if (ring === this.focus && hide === this.hideFocus && turned === this.turned) return;
    this.focus = ring;
    this.hideFocus = hide;
    this.turned = turned;
    this.root.rotation.y = turned ? Math.PI : 0;
    const origin = ring === null ? new THREE.Vector3() : gridPosition(ring);
    this.stages.forEach((stage, i) => {
      stage.root.position.copy(gridPosition(i)).sub(origin);
      stage.root.visible = !(hide && i === ring);
      // The main key light already covers the ring at the origin.
      stage.light.visible = ring === null || i !== ring;
    });
  }

  sync(rings: RingView[]) {
    rings.forEach((view, i) => this.stages[i]?.sync(view));
  }

  attack(atk: AttackRow) {
    this.stages.find(s => s.owns(atk.matchId))?.attack(atk);
  }

  resolved(atk: AttackRow) {
    if (atk.result === 'cancelled' || atk.result === 'unscorable') return;
    this.stages.find(s => s.owns(atk.matchId))?.resolved(atk);
  }

  update(dt: number, now: number) {
    for (const s of this.stages) s.update(dt, now);
  }
}
