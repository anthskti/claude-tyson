// AI Transparency Log — shows Claude's live decisions, adaptations, and analysis.
// Toggle with the [AI LOG] button in the HUD or the backtick key.

export type LogEntryType = "window" | "strategy" | "outcome" | "coach" | "analysis" | "error";

interface LogEntry {
  type: LogEntryType;
  text: string;
  ts: number;
}

const TYPE_LABEL: Record<LogEntryType, string> = {
  window:   "DATA",
  strategy: "ADAPT",
  outcome:  "EVAL",
  coach:    "COACH",
  analysis: "ANALYSIS",
  error:    "ERROR",
};

const TYPE_COLORS: Record<LogEntryType, string> = {
  window:   "#00f5ff",
  strategy: "#cc88ff",
  outcome:  "#ffd700",
  coach:    "#4fc3f7",
  analysis: "#39ff14",
  error:    "#ff2929",
};

const MAX_ENTRIES = 150;

export class DebugLog {
  private panel: HTMLElement;
  private listEl: HTMLElement;
  private countEl: HTMLElement;
  private entries: LogEntry[] = [];
  private visible = false;

  constructor() {
    this.panel = document.createElement("div");
    this.panel.id = "ai-log";
    this.panel.innerHTML = `
      <div class="al-header">
        <span class="al-title">AI TRANSPARENCY LOG</span>
        <button class="al-close" title="Close (or press \`)">✕</button>
      </div>
      <div class="al-legend">
        <span style="color:#00f5ff">DATA</span> fight windows ·
        <span style="color:#cc88ff">ADAPT</span> Claude strategy ·
        <span style="color:#ffd700">EVAL</span> outcome ·
        <span style="color:#4fc3f7">COACH</span> live tips ·
        <span style="color:#39ff14">ANALYSIS</span> post-fight
      </div>
      <div class="al-list"></div>`;
    document.body.appendChild(this.panel);
    this.listEl = this.panel.querySelector(".al-list")!;

    // Toggle button injected into the HUD
    const btn = document.createElement("button");
    btn.id = "ai-log-btn";
    btn.innerHTML = `🧠 <span id="ai-log-count">0</span>`;
    btn.title = "AI Transparency Log";
    btn.addEventListener("click", () => this.toggle());
    document.body.appendChild(btn);
    this.countEl = btn.querySelector("#ai-log-count")!;

    this.panel.querySelector(".al-close")!.addEventListener("click", () => this.toggle());
  }

  add(type: LogEntryType, text: string) {
    this.entries.unshift({ type, text, ts: Date.now() });
    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES;
    this.countEl.textContent = String(this.entries.length);
    if (this.visible) this.render();
  }

  toggle() {
    this.visible = !this.visible;
    this.panel.style.display = this.visible ? "flex" : "none";
    if (this.visible) this.render();
  }

  private render() {
    this.listEl.innerHTML = this.entries
      .map((e) => {
        let color = TYPE_COLORS[e.type];
        if (e.type === "outcome") color = e.text.startsWith("KEPT") ? "#39ff14" : "#ff6b6b";
        const d = new Date(e.ts);
        const ts = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;
        const label = TYPE_LABEL[e.type];
        return `<div class="al-entry">
          <span class="al-ts">${ts}</span>
          <span class="al-label" style="color:${color}">${label}</span>
          <span class="al-text">${escHtml(e.text)}</span>
        </div>`;
      })
      .join("");
  }
}

function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]!);
}
