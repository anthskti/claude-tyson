import type { Identity } from 'spacetimedb';
import { DbConnection, tables } from '../module_bindings';
import { poseOf, type MotionEvent, type Observation } from '../cv/contract';

// Thin wrapper over the generated SpacetimeDB bindings: connection, subscriptions,
// a derived view of "my current match", and throttled CV forwarding.

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

export interface MatchView {
  match: MatchRow;
  me: FighterRow;
  opponent: FighterRow;
  strategy?: StrategyRow;
}

export interface ServerEvents {
  onStatus(status: 'connecting' | 'online' | 'offline', detail?: string): void;
  onAttack(attack: AttackRow, view: MatchView): void;
  onAttackResolved(attack: AttackRow, view: MatchView): void;
  onChange(): void;
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
      .onConnect((conn, identity, token) => {
        this.conn = conn;
        this.identity = identity;
        writeToken(token);
        this.bindTables(conn);
        conn
          .subscriptionBuilder()
          .onApplied(() => {
            this.events.onStatus('online');
            this.events.onChange();
          })
          .subscribe([
            tables.player,
            tables.fighterProfile,
            tables.queueEntry,
            tables.fightMatch,
            tables.fighter,
            tables.attack,
            tables.botStrategy,
            tables.fightWindow,
            tables.fightResult,
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
    conn.db.fighter.onInsert(changed);
    conn.db.fighter.onUpdate(changed);
    conn.db.queueEntry.onInsert(changed);
    conn.db.queueEntry.onDelete(changed);
    conn.db.botStrategy.onInsert(changed);
    conn.db.botStrategy.onUpdate(changed);
    conn.db.fightResult.onInsert(changed);
    conn.db.fightResult.onUpdate(changed);
    conn.db.fighterProfile.onUpdate(changed);
    conn.db.fighterProfile.onInsert(changed);

    conn.db.attack.onInsert((_ctx, atk) => {
      const view = this.matchView(atk.matchId);
      if (view) this.events.onAttack(atk, view);
    });
    conn.db.attack.onUpdate((_ctx, prev, atk) => {
      if (prev.result !== 'pending' || atk.result === 'pending') return;
      const view = this.matchView(atk.matchId);
      if (view) this.events.onAttackResolved(atk, view);
    });
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
  };
}
