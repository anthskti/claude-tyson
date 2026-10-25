import type { Identity } from 'spacetimedb';
import { DbConnection, tables } from '../module_bindings';
import { poseOf, type MotionEvent, type Observation } from '../cv/contract';
import { RING_COUNT } from '../scene/arena';

// Thin wrapper over the generated SpacetimeDB bindings: connection, subscriptions,
// a derived view of "my current match" and of every ring, and throttled CV forwarding.
//
// Subscriptions cover live matches, the bot exhibition, and my own latest match, never
// the whole history: every spectator would otherwise download every fight ever played.

const URI = process.env.NEXT_PUBLIC_STDB_HOST ?? 'ws://localhost:3000';
const DB_NAME = process.env.NEXT_PUBLIC_STDB_DB ?? 'claude-tyson';
const POSE_SEND_INTERVAL_MS = 50; // 20 Hz keeps well inside the server's 250 ms freshness budget

type Conn = DbConnection;
export type FighterRow = ReturnType<Conn['db']['fighter']['iter']> extends Iterable<infer R> ? R : never;
export type AttackRow = ReturnType<Conn['db']['attack']['iter']> extends Iterable<infer R> ? R : never;
export type MatchRow = ReturnType<Conn['db']['fightMatch']['iter']> extends Iterable<infer R> ? R : never;
export type StrategyRow = ReturnType<Conn['db']['botStrategy']['iter']> extends Iterable<infer R> ? R : never;
export type ResultRow = ReturnType<Conn['db']['fightResult']['iter']> extends Iterable<infer R> ? R : never;
export type ProfileRow = ReturnType<Conn['db']['fighterProfile']['iter']> extends Iterable<infer R> ? R : never;
export type FightWindowRow = ReturnType<Conn['db']['fightWindow']['iter']> extends Iterable<infer R> ? R : never;

export interface MatchView {
  match: MatchRow;
  me: FighterRow;
  opponent: FighterRow;
  strategy?: StrategyRow;
}

/** What one ring shows: its live match, or an exhibition that just ended. */
export interface RingView {
  ring: number;
  match?: MatchRow;
  fighters: FighterRow[]; // by slot
}

export interface ServerEvents {
  onStatus(status: 'connecting' | 'online' | 'offline', detail?: string): void;
  onAttack(attack: AttackRow, view: MatchView): void;
  onAttackResolved(attack: AttackRow, view: MatchView): void;
  /** Any ring's attacks, mine included, for the arena's third-person boxers. */
  onRingAttack(attack: AttackRow): void;
  onRingAttackResolved(attack: AttackRow): void;
  onError(message: string): void;
  onChange(): void;
  onFightWindow?: (window: FightWindowRow, strategy: StrategyRow | undefined) => void;
}

export function tokenKey(): string {
  // ?player=2 keeps a separate identity slot; mostly useful with a duplicated tab.
  const slot = new URLSearchParams(location.search).get('player') ?? '1';
  return `claude-tyson.token.${slot}`;
}

// Per-tab storage: each tab is its own player, so two local tabs can PvP each other.
// The identity survives reloads of that tab but not closing it.
function readToken(): string | undefined {
  try {
    return sessionStorage.getItem(tokenKey()) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeToken(token: string) {
  try {
    sessionStorage.setItem(tokenKey(), token);
  } catch {
    /* identity just won't persist across reloads */
  }
}

export class GameServer {
  conn?: DbConnection;
  identity?: Identity;
  private lastPoseSent = 0;
  private lastPoseKey = '';
  private forwarded = new Set<string>();
  private mine?: { matchId: bigint; handle: { unsubscribe(): void } };

  private events: ServerEvents;

  constructor(events: ServerEvents) {
    this.events = events;
  }

  connect() {
    this.events.onStatus('connecting');
    DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB_NAME)
      .withToken(readToken())
      .withCompression('none')
      .onConnect((conn, identity, token) => {
        this.conn = conn;
        this.identity = identity;
        writeToken(token);
        this.bindTables(conn);
        const live = tables.fightMatch.where(m => m.status.eq('active'));
        // Exhibitions are deleted soon after they end, so this set stays tiny.
        const shows = tables.fightMatch.where(m => m.mode.eq('exhibition'));
        conn
          .subscriptionBuilder()
          .onApplied(() => {
            this.events.onStatus('online');
            this.events.onChange();
          })
          .onError(ctx => this.events.onStatus('offline', ctx.event?.message ?? 'subscription failed'))
          .subscribe([
            tables.player,
            tables.fighterProfile.where(p => p.identity.eq(identity)),
            tables.queueEntry,
            live,
            live.rightSemijoin(tables.fighter, (m, f) => m.id.eq(f.matchId)),
            live.rightSemijoin(tables.attack, (m, a) => m.id.eq(a.matchId)),
            live.rightSemijoin(tables.botStrategy, (m, s) => m.id.eq(s.matchId)),
            live.rightSemijoin(tables.fightWindow, (m, w) => m.id.eq(w.matchId)),
            shows,
            shows.rightSemijoin(tables.fighter, (m, f) => m.id.eq(f.matchId)),
            shows.rightSemijoin(tables.fightResult, (m, r) => m.id.eq(r.matchId)),
          ]);
      })
      .onConnectError((_ctx, err) => this.events.onStatus('offline', err.message))
      .onDisconnect(() => this.events.onStatus('offline', 'disconnected'))
      .build();
  }

  private bindTables(conn: DbConnection) {
    const changed = () => this.events.onChange();
    conn.db.fightMatch.onInsert(changed);
    conn.db.fightMatch.onUpdate(changed);
    conn.db.fighter.onInsert((_ctx, f) => {
      if (this.isMe(f)) this.followMatch(f.matchId);
      changed();
    });
    conn.db.fighter.onDelete(changed);
    conn.db.fightMatch.onDelete(changed);
    conn.db.player.onInsert(changed);
    conn.db.player.onUpdate(changed);
    conn.db.fighter.onUpdate(changed);
    conn.db.queueEntry.onInsert(changed);
    conn.db.queueEntry.onDelete(changed);
    conn.db.botStrategy.onInsert(changed);
    conn.db.botStrategy.onUpdate(changed);
    conn.db.fightResult.onInsert(changed);
    conn.db.fightResult.onUpdate(changed);
    conn.db.fighterProfile.onUpdate(changed);
    conn.db.fighterProfile.onInsert(changed);

    conn.db.fightWindow.onInsert((_ctx, row) => {
      const strategy = this.conn?.db.botStrategy.matchId.find(row.matchId) ?? undefined;
      this.events.onFightWindow?.(row, strategy);
    });

    conn.db.attack.onInsert((_ctx, atk) => {
      this.events.onRingAttack(atk);
      const view = this.matchView(atk.matchId);
      if (view) this.events.onAttack(atk, view);
    });
    conn.db.attack.onUpdate((_ctx, prev, atk) => {
      if (prev.result !== 'pending' || atk.result === 'pending') return;
      this.events.onRingAttackResolved(atk);
      const view = this.matchView(atk.matchId);
      if (view) this.events.onAttackResolved(atk, view);
    });
  }

  /** Keep my latest match (and its result) after it leaves the live set. */
  private followMatch(matchId: bigint) {
    if (!this.conn || (this.mine && this.mine.matchId >= matchId)) return;
    this.mine?.handle.unsubscribe();
    const handle = this.conn
      .subscriptionBuilder()
      .subscribe([
        tables.fightMatch.where(m => m.id.eq(matchId)),
        tables.fighter.where(f => f.matchId.eq(matchId)),
        tables.attack.where(a => a.matchId.eq(matchId)),
        tables.botStrategy.where(s => s.matchId.eq(matchId)),
        tables.fightResult.where(r => r.matchId.eq(matchId)),
        tables.fightWindow.where(w => w.matchId.eq(matchId)),
      ]);
    this.mine = { matchId, handle };
  }

  private isMe(f: FighterRow): boolean {
    return !!this.identity && !!f.identity && f.identity.isEqual(this.identity);
  }

  private matchView(matchId: bigint): MatchView | undefined {
    if (!this.conn) return undefined;
    const match = this.conn.db.fightMatch.id.find(matchId);
    if (!match) return undefined;
    const fighters = [...this.conn.db.fighter.iter()].filter(f => f.matchId === matchId);
    const me = fighters.find(f => this.isMe(f));
    const opponent = fighters.find(f => f !== me);
    if (!me || !opponent) return undefined;
    return { match, me, opponent, strategy: this.conn.db.botStrategy.matchId.find(matchId) ?? undefined };
  }

  /** The match I'm in, preferring an active one, else the most recent finished one. */
  currentMatch(): MatchView | undefined {
    if (!this.conn) return undefined;
    const mine = [...this.conn.db.fighter.iter()].filter(f => this.isMe(f)).map(f => f.matchId);
    const views = mine.map(id => this.matchView(id)).filter((v): v is MatchView => !!v);
    const active = views.find(v => v.match.status === 'active');
    if (active) return active;
    return views.sort((a, b) => Number(b.match.id - a.match.id))[0];
  }

  /** One entry per ring: its live match, else an exhibition still showing its result. */
  rings(): RingView[] {
    const rings: RingView[] = Array.from({ length: RING_COUNT }, (_, ring) => ({ ring, fighters: [] }));
    if (!this.conn) return rings;
    for (const m of this.conn.db.fightMatch.iter()) {
      const slot = rings[m.ring];
      if (!slot || (m.status !== 'active' && m.mode !== 'exhibition')) continue;
      // An active match always wins the ring over one that already ended.
      if (slot.match && (slot.match.status === 'active' || m.id < slot.match.id)) continue;
      slot.match = m;
    }
    for (const r of rings) {
      if (!r.match) continue;
      const id = r.match.id;
      r.fighters = [...this.conn.db.fighter.matchId.filter(id)].sort((a, b) => a.slot - b.slot);
    }
    return rings;
  }

  /** Display name for a fighter row: the player's name, or BOT / their corner. */
  nameOf(f: FighterRow | undefined): string {
    if (!f) return '—';
    if (!f.identity) return 'BOT';
    const name = this.conn?.db.player.identity.find(f.identity)?.name;
    return name || (f.slot === 0 ? 'RED' : 'BLUE');
  }

  queueLength(): number {
    return this.conn ? [...this.conn.db.queueEntry.iter()].length : 0;
  }

  result(matchId: bigint): ResultRow | undefined {
    return this.conn?.db.fightResult.matchId.find(matchId) ?? undefined;
  }

  profile(): ProfileRow | undefined {
    if (!this.conn || !this.identity) return undefined;
    return this.conn.db.fighterProfile.identity.find(this.identity) ?? undefined;
  }

  inQueue(): boolean {
    return !!this.conn && !!this.identity && !!this.conn.db.queueEntry.identity.find(this.identity);
  }

  startBotMatch() {
    this.conn?.reducers.startBotMatch({}).catch(this.report);
  }

  joinPvp() {
    this.conn?.reducers.joinPvpQueue({}).catch(this.report);
  }

  leavePvp() {
    this.conn?.reducers.leavePvpQueue({}).catch(this.report);
  }

  forfeit(matchId: bigint) {
    this.conn?.reducers.forfeit({ matchId }).catch(this.report);
  }

  applyStrategyUpdate(
    matchId: bigint,
    sourceWindowId: bigint,
    baseRevision: number,
    fields: {
      aggression: number;
      punchIntervalMs: number;
      jabWeight: number;
      straightWeight: number;
      hookWeight: number;
      uppercutWeight: number;
      leftBias: number;
      defenseRate: number;
      telegraphMs: number;
      explanation: string;
    }
  ) {
    this.conn?.reducers
      .applyStrategyUpdate({
        matchId,
        sourceWindowId,
        baseRevision,
        aggression: fields.aggression,
        punchIntervalMs: fields.punchIntervalMs,
        jabWeight: fields.jabWeight,
        straightWeight: fields.straightWeight,
        hookWeight: fields.hookWeight,
        uppercutWeight: fields.uppercutWeight,
        leftBias: fields.leftBias,
        defenseRate: fields.defenseRate,
        telegraphMs: fields.telegraphMs,
        explanation: fields.explanation,
      })
      .catch(this.report);
  }

  /** Forward one CV sample. Pose is throttled; events are never dropped or merged. */
  forwardCv(matchId: bigint, obs: Observation, events: MotionEvent[]) {
    if (!this.conn) return;
    const now = performance.now();
    const pose = poseOf(obs);
    // Send immediately when the discrete state changes so a dodge/block isn't late.
    const poseKey = `${obs.trackingState}|${pose.body}|${pose.guards.left}|${pose.guards.right}`;
    if (now - this.lastPoseSent >= POSE_SEND_INTERVAL_MS || poseKey !== this.lastPoseKey) {
      this.lastPoseSent = now;
      this.lastPoseKey = poseKey;
      this.conn.reducers
        .updatePose({
          matchId,
          cvSessionId: obs.sessionId,
          calibrationId: obs.calibrationId ?? '',
          trackingState: obs.trackingState,
          dodgeValid: obs.validity.dodge,
          punchLeftValid: obs.validity.punch_left,
          punchRightValid: obs.validity.punch_right,
          bodyState: pose.body,
          leftGuard: pose.guards.left,
          rightGuard: pose.guards.right,
          lateral: obs.features.lateralDisplacementBodyWidths ?? 0,
        })
        .catch(this.report);
    }
    for (const ev of events) {
      const key = `${ev.sessionId}:${ev.eventId}`;
      if (this.forwarded.has(key)) continue;
      this.forwarded.add(key);
      this.conn.reducers
        .submitMotionEvent({ matchId, cvSessionId: ev.sessionId, eventId: ev.eventId, eventType: ev.type, punchType: ev.punchType ?? '' })
        .catch(this.report);
    }
  }

  close() {
    this.conn?.disconnect();
    this.conn = undefined;
  }

  private report = (err: unknown) => {
    console.warn('[server]', err);
    this.events.onError(err instanceof Error ? err.message : String(err));
  };
}
