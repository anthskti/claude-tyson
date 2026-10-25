// Browser audio for coach cues: Cartesia via /api/tts, cached per line; falls back to the
// browser's built-in speech when TTS isn't configured, so the coach always has a voice.

import type { VoiceCue } from "../shared/contracts";

export interface CoachAudio {
  play: (cue: VoiceCue) => Promise<void>;
  stop: () => void;
  preload: (lines: { text: string; persona?: VoiceCue["persona"] }[]) => void;
  readonly engine: "cartesia" | "browser" | "unknown";
}

/** ttsUrl: null = no TTS endpoint (e.g. page opened as a file); always use the built-in voice. */
export function createCoachAudio(opts: { ttsUrl?: string | null; maxLineMs?: number } = {}): CoachAudio {
  const ttsUrl = opts.ttsUrl === undefined ? "/api/tts" : opts.ttsUrl;
  const cache = new Map<string, Promise<string | null>>();
  let available: boolean | undefined = ttsUrl === null ? false : undefined;
  let current: HTMLAudioElement | null = null;
  let finish: (() => void) | null = null;

  let probe: Promise<unknown> | null = null; // first request finds out whether TTS is configured

  function urlFor(text: string, persona: VoiceCue["persona"]): Promise<string | null> {
    if (available === false) return Promise.resolve(null);
    if (available === undefined && probe) {
      const p = probe;
      return p.then(() => {
        if (probe === p && available === undefined) probe = null; // probe failed: let the next call try again
        return urlFor(text, persona);
      });
    }
    const key = `${persona}|${text}`;
    if (!cache.has(key)) {
      cache.set(key, fetch(ttsUrl!, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, persona }),
      }).then(async (r) => {
        if (r.status === 501) { available = false; return null; }
        if (!r.ok) { cache.delete(key); return null; }
        available = true;
        return URL.createObjectURL(await r.blob());
      }).catch(() => { cache.delete(key); return null; }));
      if (available === undefined) probe = cache.get(key)!;
    }
    return cache.get(key)!;
  }

  function speakBuiltIn(text: string, done: () => void) {
    const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
    if (!synth) { setTimeout(done, Math.min(6000, 400 + text.split(" ").length * 320)); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.1;
    u.onend = done;
    u.onerror = done;
    synth.speak(u);
  }

  return {
    get engine() { return available === true ? "cartesia" : available === false ? "browser" : "unknown"; },
    play(cue) {
      return new Promise<void>((resolve) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; finish = null; current = null; resolve(); } };
        finish = done;
        const safety = setTimeout(done, opts.maxLineMs ?? 9000);
        urlFor(cue.text, cue.persona).then((url) => {
          if (settled) return;
          const end = () => { clearTimeout(safety); done(); };
          if (!url) return speakBuiltIn(cue.text, end);
          const a = new Audio(url);
          current = a;
          a.onended = end;
          a.onerror = () => speakBuiltIn(cue.text, end);
          a.play().catch(() => speakBuiltIn(cue.text, end)); // autoplay blocked -> built-in voice
        });
      });
    },
    stop() {
      current?.pause();
      if (typeof window !== "undefined") window.speechSynthesis?.cancel();
      finish?.();
    },
    preload(lines) {
      for (const l of lines) void urlFor(l.text, l.persona ?? "coach");
    },
  };
}
