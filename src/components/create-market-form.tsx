'use client';

import { useState } from 'react';

type MarketData = Record<string, unknown>;

type Status = 'idle' | 'loading' | 'success' | 'error';

export function CreateMarketForm() {
  const [question, setQuestion] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [market, setMarket] = useState<MarketData | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;

    setStatus('loading');
    setMarket(null);
    setErrorMsg('');

    try {
      const res = await fetch('/api/generate-market', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      });

      const data = await res.json();

      if (!res.ok || data.error) {
        setErrorMsg(data.error ?? 'Unknown error');
        setStatus('error');
        return;
      }

      setMarket(data.market);
      setStatus('success');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Network error');
      setStatus('error');
    }
  }

  return (
    <div className="cmf">
      <form onSubmit={handleSubmit} className="cmf__form">
        <label className="cmf__label" htmlFor="market-question">
          Describe your prediction market
        </label>
        <textarea
          id="market-question"
          className="cmf__textarea"
          placeholder="e.g. Will the next global temperature record be set before 2026?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={4}
          disabled={status === 'loading'}
        />
        <div className="cmf__footer">
          <span className="cmf__hint">
            Powered by Grok · outputs a machine-readable JSON schema
          </span>
          <button
            type="submit"
            className="cmf__submit"
            disabled={status === 'loading' || !question.trim()}
          >
            {status === 'loading' ? (
              <>
                <span className="cmf__spinner" />
                Compiling…
              </>
            ) : (
              <>
                <span>◈</span> Generate
              </>
            )}
          </button>
        </div>
      </form>

      {status === 'error' && (
        <div className="cmf__error">
          <span className="cmf__error-icon">✕</span>
          {errorMsg}
        </div>
      )}

      {status === 'success' && market && (
        <div className="cmf__result">
          <div className="cmf__result-header">
            <span className="cmf__result-dot" />
            <span className="cmf__result-label">Market schema compiled</span>
            <button
              className="cmf__copy"
              onClick={() => navigator.clipboard.writeText(JSON.stringify(market, null, 2))}
            >
              Copy JSON
            </button>
          </div>
          <pre className="cmf__code">{JSON.stringify(market, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
