// Client-side adaptation loop orchestrator.
// Every fightWindow from SpacetimeDB → ask Claude to mutate botStrategy → evaluate if it helped.
//
// State machine: idle → requesting → applied → (next window) evaluating → idle

import type { GameServer, StrategyRow, FightWindowRow } from "./net/server";

export interface AdaptationHistory {
  windowId: string;
  outcome: "improved" | "worsened" | "inconclusive";
  explanation: string;
}

export interface StrategistRequest {
  windowId: string;
  matchId: string;
  strategyRevision: number;
  window: {
    playerLanded: number;
    playerAttempts: number;
    playerHealth: number;
    botHealth: number;
    trackingCoverage: number;
    playerJabs: number;
    playerStraights: number;
    playerHooks: number;
    playerUppercuts: number;
    playerSlips: number;
    playerBlocks: number;
    playerCaught: number;
    botAttacks: number;
  };
  strategy: {
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
  };
  history: AdaptationHistory[];
}

export interface StrategistResponse {
  skip: boolean;
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

interface PendingEval {
  windowId: bigint;
  preBotHealth: number;
  prePlayerLanded: number;
  prePlayerAttempts: number;
  explanation: string;
}

export interface AdaptationManagerOptions {
  server: GameServer;
  requestStrategist: (req: StrategistRequest) => Promise<StrategistResponse>;
  onAdaptation: (outcome: string, explanation: string) => void;
  /** Fires immediately when a strategy is APPLIED (before evaluation). Use to trigger wheel + dialogue. */
  onStrategyApplied?: (explanation: string) => void;
  log: (msg: string) => void;
}

type State = "idle" | "requesting" | "applied";

export class AdaptationManager {
  private state: State = "idle";
  private pending: PendingEval | null = null;
  private history: AdaptationHistory[] = [];
  private opts: AdaptationManagerOptions;
  private activeMatchId: bigint | undefined;

  constructor(opts: AdaptationManagerOptions) {
    this.opts = opts;
  }

  async onWindow(window: FightWindowRow, strategy: StrategyRow | undefined) {
    // Only process windows from the match that started during this session.
    // SpacetimeDB replays all historical rows on connect; ignoring them avoids
    // flooding the adaptation loop with stale data from previous fights.
    if (this.activeMatchId === undefined || window.matchId !== this.activeMatchId) return;
    const { log, onAdaptation, requestStrategist, server } = this.opts;

    // Evaluate the previous applied strategy before requesting a new one.
    if (this.pending && this.state === "applied") {
      const outcome = this.evaluate(window, this.pending);
      const { explanation } = this.pending;
      this.history = [...this.history.slice(-4), {
        windowId: String(this.pending.windowId),
        outcome,
        explanation,
      }];
      if (outcome === "improved") {
        log(`KEPT ✓ — ${explanation}`);
      } else {
        log(`NOTED ✗ — ${explanation} (${outcome})`);
      }
      onAdaptation(outcome, explanation);
      this.pending = null;
      this.state = "idle";
    }

    // Skip noisy or incomplete windows.
    if (window.trackingCoverage < 0.5) {
      log(`W#${window.id} skip — tracking ${(window.trackingCoverage * 100).toFixed(0)}%`);
      return;
    }

    if (this.state === "requesting") {
      log(`W#${window.id} skip — request in flight`);
      return;
    }

    if (!strategy) {
      log(`W#${window.id} skip — no strategy row`);
      return;
    }

    // Only count the punch types the game actually uses (hooks + straights).
    const playerAttempts = window.playerStraights + window.playerHooks;

    // Skip if player barely threw any punches — Claude would skip anyway.
    if (playerAttempts < 3) {
      log(`W#${window.id} skip — playerAttempts ${playerAttempts}`);
      return;
    }

    const req: StrategistRequest = {
      windowId: String(window.id),
      matchId: String(window.matchId),
      strategyRevision: strategy.revision,
      window: {
        playerLanded: window.playerLanded,
        playerAttempts,
        playerHealth: window.playerHealth,
        botHealth: window.botHealth,
        trackingCoverage: window.trackingCoverage,
        playerJabs: window.playerJabs,
        playerStraights: window.playerStraights,
        playerHooks: window.playerHooks,
        playerUppercuts: window.playerUppercuts,
        playerSlips: window.playerSlips,
        playerBlocks: window.playerBlocks,
        playerCaught: window.playerCaught,
        botAttacks: window.botAttacks,
      },
      strategy: {
        aggression: strategy.aggression,
        punchIntervalMs: strategy.punchIntervalMs,
        jabWeight: strategy.jabWeight,
        straightWeight: strategy.straightWeight,
        hookWeight: strategy.hookWeight,
        uppercutWeight: strategy.uppercutWeight,
        leftBias: strategy.leftBias,
        defenseRate: strategy.defenseRate,
        telegraphMs: strategy.telegraphMs,
        explanation: strategy.explanation,
      },
      history: this.history.slice(-3),
    };

    this.state = "requesting";
    log(`W#${window.id} player+${window.playerLanded}/${playerAttempts} hit bot-${window.botHealth}hp tracking=${(window.trackingCoverage * 100).toFixed(0)}%`);

    try {
      const response = await requestStrategist(req);

      if (response.skip) {
        log("CLAUDE: strategy already optimal");
        this.state = "idle";
        return;
      }

      log(`CLAUDE: ${response.explanation}`);
      this.opts.onStrategyApplied?.(response.explanation);

      server.applyStrategyUpdate(window.matchId, window.id, strategy.revision, {
        aggression: response.aggression,
        punchIntervalMs: response.punchIntervalMs,
        jabWeight: response.jabWeight,
        straightWeight: response.straightWeight,
        hookWeight: response.hookWeight,
        uppercutWeight: 0,
        leftBias: response.leftBias,
        defenseRate: response.defenseRate,
        telegraphMs: response.telegraphMs,
        explanation: response.explanation,
      });

      this.pending = {
        windowId: window.id,
        preBotHealth: window.botHealth,
        prePlayerLanded: window.playerLanded,
        prePlayerAttempts: window.playerStraights + window.playerHooks,
        explanation: response.explanation,
      };
      this.state = "applied";
    } catch (e) {
      log(`strategist error: ${(e as Error).message}`);
      this.state = "idle";
    }
  }

  private evaluate(nextWindow: FightWindowRow, prev: PendingEval): "improved" | "worsened" | "inconclusive" {
    const nextAttempts = nextWindow.playerStraights + nextWindow.playerHooks;

    // Need enough data to draw conclusions; if either window was too sparse, skip accuracy delta.
    const hasEnoughData = prev.prePlayerAttempts >= 8 && nextAttempts >= 8;

    const nextRate = nextAttempts > 0 ? nextWindow.playerLanded / nextAttempts : 0;
    const prevRate = prev.prePlayerAttempts > 0 ? prev.prePlayerLanded / prev.prePlayerAttempts : 0;
    const healthDelta = nextWindow.botHealth - prev.preBotHealth;

    // Bot barely lost health this window → strategy is working (player can't get through).
    if (healthDelta >= -4) return "improved";
    // Bot took significant damage → strategy worsened (player breaking through).
    if (healthDelta < -10) return "worsened";

    // Accuracy delta only reliable with enough samples.
    if (hasEnoughData) {
      if (nextRate < prevRate - 0.05) return "improved";
      if (nextRate > prevRate + 0.05) return "worsened";
    }
    return "inconclusive";
  }

  /** Format post-fight debrief text, prepending adaptation history if available. */
  getDebrief(analysis: string): string {
    if (this.history.length === 0) return analysis;
    const lines = this.history.map(
      (h) => `• ${h.outcome === "improved" ? "✓" : "✗"} ${h.explanation} (${h.outcome})`
    );
    return `${analysis}\n\nAdaptation log:\n${lines.join("\n")}`;
  }

  reset(matchId?: bigint) {
    this.state = "idle";
    this.pending = null;
    this.history = [];
    this.activeMatchId = matchId;
  }
}
