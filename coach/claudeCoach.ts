// Server-side Claude coach: CoachRequest -> CoachResponse (contract §9).
// Runs in a Next.js route or the Bun dev server; the API key never reaches the browser.
// Claude must answer through a forced tool call, then we validate: length, allowed tactics,
// and no advice about signals the input can't detect. Any failure -> offline coach.

import type { Capability, CoachRequest, CoachResponse } from "../shared/contracts";
import { offlineCoachResponse } from "./offlineCoach";

export interface ClaudeCoachOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

export const DEFAULT_COACH_MODEL = "claude-haiku-5-5"; // fast tier: live coaching needs low latency
const MAX_WORDS = 18;
const MAX_BODY_BYTES = 32_000;

type Tactic = NonNullable<CoachResponse["suggestedTactic"]>;

/** Tactics the game can actually do with these inputs. No body shots exist in the game. */
export function allowedTactics(caps: Capability[]): Tactic[] {
  const t: Tactic[] = ["attack_head", "mix_punches", "change_rhythm"];
  if (caps.includes("guard") || caps.includes("dodge") || caps.includes("lean")) t.push("defend");
  return t;
}

const PUNCH_WORDS = /\b(jab|jabs|cross|crosses|hook|hooks|uppercut|uppercuts)\b/i;
// advice about the PLAYER's guard can't be checked without guard tracking; "he's blocking" (the CPU) is fine
const GUARD_WORDS = /\b(your guard|guard up|keep your hands|hands up|hands back|chin down|block (it|them|that|his|the)|cover up)\b/i;
const NEVER_WORDS = /\b(body shot|body shots|liver|ribs|stomach|harder|stronger|power|form|technique|stance|footwork|feet)\b/i;

/** Returns a reason string if the advice talks about something the game can't observe. */
export function rejectReason(advice: string, req: CoachRequest): string | null {
  const caps = req.capabilities ?? [];
  const words = advice.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "empty";
  if (words.length > MAX_WORDS + 4) return "too_long";
  if (NEVER_WORDS.test(advice)) return "unsupported_signal";
  if (!caps.includes("punch_types") && PUNCH_WORDS.test(advice)) return "punch_types_unsupported";
  if (!caps.includes("guard") && GUARD_WORDS.test(advice)) return "guard_unsupported";
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, "").trim();
  if (req.previousCoachLines.some((l) => norm(l) === norm(advice))) return "repeat";
  return null;
}

function systemPrompt(caps: Capability[]): string {
  const can = [
    caps.includes("punch_types")
      ? "punch types (jab, cross, hook, uppercut) are detected"
      : "punches are only detected as LEFT hand or RIGHT hand; never name punch types",
    caps.includes("guard") ? "guard (hands at face) is detected" : "guard/blocking is NOT detected; never mention guard, blocking or hands up",
    caps.includes("dodge") || caps.includes("lean") ? "head slips/leans left and right are detected" : "dodging is NOT detected",
    "all punches target the head; there are no body shots",
  ];
  return [
    "You are the corner coach in Claude Tyson, a webcam boxing game. The player fights a CPU boxer.",
    "You see compact stats for the last few seconds, not video. Give ONE short, energetic, actionable tip the player can use in the next punch exchange.",
    "",
    "What this game can observe right now:",
    ...can.map((c) => `- ${c}`),
    "",
    "Rules:",
    `- Max ${MAX_WORDS} words. Spoken aloud mid-fight, so plain words, no lists, no numbers unless essential.`,
    "- Base the tip on patterns in the data (repeated weaknesses beat one-off mistakes). Cite the evidence you used.",
    "- Never comment on strength, technique, form, footwork or body shots. This is game coaching, not real combat or medical advice.",
    "- Don't repeat or paraphrase a line in previousCoachLines.",
    "- If the evidence is too thin, set skip=true.",
    "- trigger=fight_end: give a 1-2 sentence wrap-up of what worked and one thing to try next fight (max 30 words).",
  ].join("\n");
}

function tool(caps: Capability[]) {
  return {
    name: "give_coaching",
    description: "Return one coaching line for the player, or skip.",
    input_schema: {
      type: "object",
      properties: {
        skip: { type: "boolean", description: "true if there is not enough evidence for a useful tip" },
        advice: { type: "string", description: "The spoken line." },
        evidence: { type: "array", items: { type: "string" }, maxItems: 3, description: "Short data-backed observations used." },
        tactic: { type: "string", enum: allowedTactics(caps) },
        priority: { type: "string", enum: ["low", "normal"] },
      },
      required: ["skip", "advice", "evidence", "tactic", "priority"],
    },
  };
}

/** Basic shape check on untrusted request JSON. */
export function parseCoachRequest(x: unknown): CoachRequest | null {
  const r = x as CoachRequest;
  if (!r || typeof r !== "object" || r.schemaVersion !== 1) return null;
  if (typeof r.requestId !== "string" || typeof r.fightId !== "string" || typeof r.atMs !== "number") return null;
  if (!r.player?.punches || !r.opponent?.punches || !Array.isArray(r.previousCoachLines)) return null;
  if (!["proactive", "player_question", "round_break", "fight_end"].includes(r.trigger)) return null;
  return r;
}

export async function coachWithClaude(req: CoachRequest, o: ClaudeCoachOptions = {}): Promise<CoachResponse> {
  const log = o.log ?? (() => {});
  if (!o.apiKey) return offlineCoachResponse(req);
  const caps = req.capabilities ?? [];
  const f = o.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 6000);
  try {
    // Only observable data goes to Claude: stats + public state. No frames, no hidden CPU strategy.
    const { requestId: _r, fightId: _f, ...payload } = req;
    const res = await f(`${o.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": o.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: o.model ?? DEFAULT_COACH_MODEL,
        max_tokens: 300,
        system: systemPrompt(caps),
        tools: [tool(caps)],
        tool_choice: { type: "tool", name: "give_coaching" },
        messages: [{ role: "user", content: `Fight data:\n${JSON.stringify(payload)}` }],
      }),
    });
    if (!res.ok) {
      log(`claude http ${res.status}`);
      return offlineCoachResponse(req);
    }
    const data = (await res.json()) as { content?: { type: string; name?: string; input?: any }[] };
    const call = data.content?.find((c) => c.type === "tool_use" && c.name === "give_coaching");
    const inp = call?.input;
    if (!inp || typeof inp.advice !== "string") {
      log("claude: no tool call");
      return offlineCoachResponse(req);
    }
    if (inp.skip) return { schemaVersion: 1, requestId: req.requestId, advice: "", referencedEvidence: [], source: "claude" };
    const advice = String(inp.advice).trim().replace(/\s+/g, " ");
    let reason = rejectReason(advice, req);
    if (reason === "too_long" && req.trigger === "fight_end" && advice.split(" ").length <= 34) reason = null; // wrap-ups can be longer
    if (reason) {
      log(`claude advice rejected (${reason}): ${advice}`);
      return offlineCoachResponse(req);
    }
    const tactic = allowedTactics(caps).includes(inp.tactic) ? (inp.tactic as Tactic) : undefined;
    return {
      schemaVersion: 1,
      requestId: req.requestId,
      advice,
      referencedEvidence: Array.isArray(inp.evidence) ? inp.evidence.slice(0, 3).map((e: unknown) => String(e).slice(0, 120)) : [],
      ...(tactic ? { suggestedTactic: tactic } : {}),
      source: "claude",
    };
  } catch (e) {
    log(`claude error: ${(e as Error).name}`);
    return offlineCoachResponse(req);
  } finally {
    clearTimeout(timer);
  }
}

/** HTTP handler: POST CoachRequest JSON -> CoachResponse JSON. Works as a Next.js route body. */
export async function handleCoachHttp(request: Request, o: ClaudeCoachOptions = {}): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "method" }, { status: 405 });
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return Response.json({ error: "too_large" }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return Response.json({ error: "bad_json" }, { status: 400 }); }
  const req = parseCoachRequest(body);
  if (!req) return Response.json({ error: "bad_request" }, { status: 400 });
  return Response.json(await coachWithClaude(req, o));
}
