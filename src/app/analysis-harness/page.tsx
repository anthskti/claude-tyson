'use client';

import { useState } from 'react';
import type { AnalysisRequest, AnalysisResponse } from '../../../coach/analysis';
import '../harness.css';

const example: AnalysisRequest = {
  matchId: '3',
  playerName: 'Anthony',
  playerHealth: 6.4,
  won: false,
  reason: 'ko',
  attempts: 24,
  landed: 11,
  straights: 15,
  hooks: 9,
  slips: 5,
  blocks: 3,
  hitsTaken: 12,
};

export default function AnalysisHarnessPage() {
  const [requestText, setRequestText] = useState(() => JSON.stringify(example, null, 2));
  const [result, setResult] = useState<AnalysisResponse>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function runAnalysis() {
    setLoading(true);
    setError('');
    setResult(undefined);
    try {
      const request = JSON.parse(requestText) as AnalysisRequest;
      const response = await fetch('/api/analysis', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      const data = await response.json() as AnalysisResponse | { error?: string };
      if (!response.ok) throw new Error(`Request failed (${response.status}): ${JSON.stringify(data)}`);
      setResult(data as AnalysisResponse);
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
        <p className="eyebrow">POST FIGHT</p>
        <h1>Corner notes</h1>
        <p className="intro-copy">A thoughtful recap based on the patterns from one completed fight.</p>
      </section>

      <section className="harness-grid" aria-label="Post-fight analysis request and response">
        <article className="harness-card request-card">
          <div className="card-heading">
            <div><p className="eyebrow">INPUT</p><h2>Fight summary</h2></div>
            <button className="quiet-button" type="button" onClick={loadExample}>Reset example</button>
          </div>
          <label className="sr-only" htmlFor="analysis-request-json">Post-fight summary JSON</label>
          <textarea id="analysis-request-json" spellCheck={false} value={requestText}
            onChange={event => setRequestText(event.target.value)} />
          <div className="card-footer">
            <span>Completed match · health shown on a 10 HP scale</span>
            <button className="run-button" type="button" onClick={runAnalysis} disabled={loading}>
              {loading ? <><span className="spinner" /> Writing</> : <>Generate corner notes <span aria-hidden="true">↗</span></>}
            </button>
          </div>
        </article>

        <article className="harness-card response-card" aria-live="polite">
          <div className="card-heading">
            <div><p className="eyebrow">OUTPUT</p><h2>Coach’s words</h2></div>
            <span className={`response-badge ${result ? 'ready' : ''}`}>{loading ? 'WRITING' : result ? result.source.toUpperCase() : 'WAITING'}</span>
          </div>
          {error ? <div className="error-panel"><strong>Couldn’t generate analysis</strong><p>{error}</p></div> : null}
          {result ? <div className="analysis-quote">{result.text}</div> : null}
          {!error && !result ? <div className="empty-state">
            <div className="empty-icon">✳</div>
            <p>Your corner notes will appear here.</p>
            <span>Responses use only the completed fight summary.</span>
          </div> : null}
          <div className="response-note"><span className="lock-icon">⌑</span> API key stays on the server</div>
        </article>
      </section>

      <footer className="harness-footer">Analysis is saved to the completed fight and player profile.</footer>
    </main>
  );
}
