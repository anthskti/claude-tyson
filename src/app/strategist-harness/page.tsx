'use client';

import { useState } from 'react';
import type { StrategyRequest } from '../../../coach/strategist';
import '../harness.css';

const example: StrategyRequest = {
  windowId: '12',
  matchId: '3',
  revision: 2,
  attempts: 10,
  landed: 6,
  leftAttempts: 4,
  rightAttempts: 6,
  straights: 7,
  hooks: 3,
  slips: 2,
  blocks: 1,
  hitsTaken: 4,
  trackingCoverage: 0.94,
  profile: { leftAttempts: 25, rightAttempts: 31, straights: 34, hooks: 22, punchesLanded: 28 },
  strategy: {
    aggression: 0.55,
    punchIntervalMs: 1400,
    jabWeight: 0.4,
    straightWeight: 0.4,
    hookWeight: 0.35,
    leftBias: 0,
    defenseRate: 0.25,
    telegraphMs: 650,
    explanation: 'Baseline tactics',
  },
};

export default function StrategistHarnessPage() {
  const [requestText, setRequestText] = useState(() => JSON.stringify(example, null, 2));
  const [result, setResult] = useState<unknown>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function runStrategist() {
    setLoading(true);
    setError('');
    setResult(undefined);
    try {
      const request = JSON.parse(requestText) as StrategyRequest;
      const response = await fetch('/api/strategist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      const data: unknown = await response.json();
      if (!response.ok) throw new Error(`Request failed (${response.status}): ${JSON.stringify(data)}`);
      setResult(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Request failed.');
    } finally {
      setLoading(false);
    }
  }

  function loadExample() {
    setRequestText(JSON.stringify(example, null, 2));
    setResult(undefined);
    setError('');
  }

  return (
    <main className="harness-page">
      <header className="harness-header">
        <a className="back-link" href="/">‹ <span>Claude Tyson</span></a>
        <div className="header-tag"><span className="status-dot" /> LOCAL TOOL</div>
      </header>

      <section className="harness-intro">
        <p className="eyebrow">BOT TUNING LAB</p>
        <h1>Strategist</h1>
        <p className="intro-copy">Explore how fight data shapes the bot’s next tactical adjustment.</p>
      </section>

      <section className="harness-grid" aria-label="Strategist request and response">
        <article className="harness-card request-card">
          <div className="card-heading">
            <div><p className="eyebrow">INPUT</p><h2>Fight window</h2></div>
            <button className="quiet-button" type="button" onClick={loadExample}>Reset example</button>
          </div>
          <label className="sr-only" htmlFor="request-json">Fight window JSON</label>
          <textarea id="request-json" spellCheck={false} value={requestText}
            onChange={event => setRequestText(event.target.value)} />
          <div className="card-footer">
            <span>Contract safe · left bias −1 to 1</span>
            <button className="run-button" type="button" onClick={runStrategist} disabled={loading}>
              {loading ? <><span className="spinner" /> Thinking</> : <>Run strategist <span aria-hidden="true">↗</span></>}
            </button>
          </div>
        </article>

        <article className="harness-card response-card" aria-live="polite">
          <div className="card-heading">
            <div><p className="eyebrow">OUTPUT</p><h2>Strategy response</h2></div>
            <span className={`response-badge ${result ? 'ready' : ''}`}>{loading ? 'RUNNING' : result ? 'COMPLETE' : 'WAITING'}</span>
          </div>
          {error ? <div className="error-panel"><strong>Couldn’t run strategist</strong><p>{error}</p></div> : null}
          {result ? <pre className="result-json">{JSON.stringify(result, null, 2)}</pre> : null}
          {!error && !result ? <div className="empty-state">
            <div className="empty-icon">✳</div>
            <p>Your response will appear here.</p>
            <span>Requests use the same endpoint as the live game.</span>
          </div> : null}
          <div className="response-note"><span className="lock-icon">⌑</span> API key stays on the server</div>
        </article>
      </section>

      <footer className="harness-footer">Strategy is advisory. Match state and tactics remain server-authoritative.</footer>
    </main>
  );
}
