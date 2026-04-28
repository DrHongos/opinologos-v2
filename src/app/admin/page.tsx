'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  keccak256,
} from 'viem';
import { getChain } from '@/lib/chain';
import { FPMM_ABI, LMSR_HOOK_ADDRESS, ORACLE_ACCOUNT } from '@/lib/contracts';
import { WalletButton } from '@/components/wallet-button';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Outcome {
  outcomeIndex: number;
  label: string | null;
}

interface Market {
  id: string;
  slug: string;
  question: string;
  description: string | null;
  end_time: string | null;
  question_cid: string | null;
  condition_id: string | null;
  os_index: string | null;
  outcomes: Outcome[];
  resolution_source: string | null;
  resolution_method: string | null;
  resolution_notes: string | null;
}

interface ResearchResult {
  resolvable: boolean;
  confidence: number;
  winningOutcomeIndex: number | null;
  payouts: number[];
  reasoning: string;
  sources: string[];
}

interface FeeParams {
  baseFee: string;
  minFee: string;
  maxFee: string;
  alpha: string;
  beta: string;
  volNeutral: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pct(v: string) {
  const n = parseFloat(v);
  return isNaN(n) ? '?' : (n / 10000).toFixed(4) + '%';
}

function multiplier(v: string) {
  const n = parseFloat(v);
  return isNaN(n) ? '?' : (n / 1_000_000).toFixed(3) + 'x';
}

function timeUntil(iso: string | null) {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'Expired';
  const days = Math.floor(diff / 86_400_000);
  if (days > 30) return `${Math.floor(days / 30)}mo`;
  if (days > 1) return `${days}d`;
  const h = Math.floor(diff / 3_600_000);
  return h > 0 ? `${h}h` : '<1h';
}

async function getClients(wallet: { address: string; getEthereumProvider: () => Promise<unknown> }) {
  const provider = await wallet.getEthereumProvider();
  const chain = getChain();
  const walletClient = createWalletClient({
    account: wallet.address as `0x${string}`,
    chain,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transport: custom(provider as any),
  });
  const publicClient = createPublicClient({
    chain,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transport: custom(provider as any),
  });
  return { walletClient, publicClient };
}

// ── Agent Panel ───────────────────────────────────────────────────────────────

interface AgentRunResult {
  processed: number;
  resolved: string[];
  nudged: string[];
  skipped: string[];
  errors: string[];
}

function AgentPanel() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AgentRunResult | null>(null);
  const [error, setError] = useState('');

  async function handleRun() {
    setRunning(true);
    setResult(null);
    setError('');
    try {
      const res = await fetch('/api/admin/run-agent');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Agent run failed');
      setResult(data as AgentRunResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Agent run failed');
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="adm-panel">
      <div className="adm-panel__header">
        <h2 className="adm-panel__title">Agent</h2>
        <button className="adm-btn" onClick={handleRun} disabled={running}>
          {running ? 'Running…' : 'Run Agent'}
        </button>
      </div>
      {error && <div className="adm-status adm-status--err">{error}</div>}
      {result && (
        <div className="adm-research">
          <div className="adm-research__winner">
            Processed: <strong>{result.processed}</strong>
          </div>
          {result.resolved.length > 0 && (
            <div className="adm-status adm-status--ok">
              Resolved: {result.resolved.join(', ')}
            </div>
          )}
          {result.nudged.length > 0 && (
            <div className="adm-status adm-status--ok">
              Nudged: {result.nudged.join(', ')}
            </div>
          )}
          {result.skipped.length > 0 && (
            <div className="adm-research__reasoning">
              Skipped: {result.skipped.join(', ')}
            </div>
          )}
          {result.errors.length > 0 && (
            <div className="adm-status adm-status--err">
              Errors: {result.errors.join(', ')}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ── Fee Panel ─────────────────────────────────────────────────────────────────

function FeePanel({ wallet }: { wallet: { address: string; getEthereumProvider: () => Promise<unknown> } }) {
  const [params, setParams] = useState<FeeParams>({
    baseFee: '3000', minFee: '100', maxFee: '100000',
    alpha: '500000', beta: '200000', volNeutral: '0',
  });
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    const pub = createPublicClient({ chain: getChain(), transport: http() });
    const addr = LMSR_HOOK_ADDRESS;

    Promise.all([
      pub.readContract({ address: addr, abi: FPMM_ABI, functionName: 'baseFee' }).catch(() => null),
      pub.readContract({ address: addr, abi: FPMM_ABI, functionName: 'minFee' }).catch(() => null),
      pub.readContract({ address: addr, abi: FPMM_ABI, functionName: 'maxFee' }).catch(() => null),
      pub.readContract({ address: addr, abi: FPMM_ABI, functionName: 'alpha' }).catch(() => null),
      pub.readContract({ address: addr, abi: FPMM_ABI, functionName: 'beta' }).catch(() => null),
      pub.readContract({ address: addr, abi: FPMM_ABI, functionName: 'volNeutral' }).catch(() => null),
    ]).then(([base, min, max, a, b, vn]) => {
      setParams({
        baseFee:    base    != null ? String(base)    : '3000',
        minFee:     min     != null ? String(min)     : '100',
        maxFee:     max     != null ? String(max)     : '100000',
        alpha:      a       != null ? String(a)       : '500000',
        beta:       b       != null ? String(b)       : '200000',
        volNeutral: vn      != null ? String(vn)      : '0',
      });
    }).finally(() => setFetching(false));
  }, []);

  async function handleUpdate() {
    setLoading(true);
    setStatus(null);
    try {
      const { walletClient, publicClient } = await getClients(wallet);
      const hash = await walletClient.writeContract({
        address: LMSR_HOOK_ADDRESS,
        abi: FPMM_ABI,
        functionName: 'setFeeParams',
        args: [
          BigInt(params.baseFee),
          BigInt(params.minFee),
          BigInt(params.maxFee),
          BigInt(params.alpha),
          BigInt(params.beta),
          BigInt(params.volNeutral),
        ],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setStatus({ ok: true, msg: `Fee params updated. tx: ${hash.slice(0, 10)}…` });
    } catch (e) {
      setStatus({ ok: false, msg: e instanceof Error ? e.message : 'Transaction failed' });
    } finally {
      setLoading(false);
    }
  }

  function field(key: keyof FeeParams, label: string, hint: string) {
    return (
      <div className="adm-field">
        <label className="adm-field__label">{label}</label>
        <input
          className="adm-field__input"
          type="number"
          value={params[key]}
          onChange={e => setParams(p => ({ ...p, [key]: e.target.value }))}
          disabled={fetching}
        />
        <span className="adm-field__hint">{hint}</span>
      </div>
    );
  }

  return (
    <section className="adm-panel">
      <h2 className="adm-panel__title">Fee Parameters</h2>
      <p className="adm-panel__sub">All values in 1e6 basis. 1 000 000 = 100%.</p>
      {fetching ? (
        <div className="adm-loading">Reading chain…</div>
      ) : (
        <>
          <div className="adm-fee-grid">
            {field('baseFee',    'Base Fee',    pct(params.baseFee))}
            {field('minFee',     'Min Fee',     pct(params.minFee))}
            {field('maxFee',     'Max Fee',     pct(params.maxFee))}
            {field('alpha',      'Alpha (dir)', multiplier(params.alpha))}
            {field('beta',       'Beta (vol)',  multiplier(params.beta))}
            {field('volNeutral', 'Vol Neutral', params.volNeutral)}
          </div>
          {status && (
            <div className={`adm-status ${status.ok ? 'adm-status--ok' : 'adm-status--err'}`}>
              {status.msg}
            </div>
          )}
          <button className="adm-btn" onClick={handleUpdate} disabled={loading}>
            {loading ? 'Sending tx…' : 'Update Fee Params'}
          </button>
        </>
      )}
    </section>
  );
}

// ── Market Row ────────────────────────────────────────────────────────────────

function MarketRow({ market, wallet }: {
  market: Market;
  wallet: { address: string; getEthereumProvider: () => Promise<unknown> };
}) {
  const [research, setResearch] = useState<ResearchResult | null>(null);
  const [researching, setResearching] = useState(false);
  const [researchErr, setResearchErr] = useState('');
  const [reporting, setReporting] = useState(false);
  const [reportStatus, setReportStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [expanded, setExpanded] = useState(false);

  const outcomeLabels = market.outcomes.map(o => ({
    id: o.outcomeIndex,
    label: o.label ?? `Outcome ${o.outcomeIndex}`,
  }));

  async function handleResearch() {
    setResearching(true);
    setResearchErr('');
    setResearch(null);
    setReportStatus(null);
    setExpanded(true);
    try {
      const res = await fetch('/api/admin/research-resolution', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: market.question,
          description: market.description,
          outcomes: outcomeLabels,
          resolution: {
            source: market.resolution_source,
            method: market.resolution_method,
            notes: market.resolution_notes,
          },
          endTime: market.end_time ? Math.floor(new Date(market.end_time).getTime() / 1000) : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Research failed');
      setResearch(data as ResearchResult);
    } catch (e) {
      setResearchErr(e instanceof Error ? e.message : 'Research failed');
    } finally {
      setResearching(false);
    }
  }

  async function handleReport() {
    if (!research || !market.question_cid) return;
    setReporting(true);
    setReportStatus(null);
    try {
      const questionId = keccak256(new TextEncoder().encode(market.question_cid)) as `0x${string}`;
      const payouts = research.payouts.map(BigInt);

      const { walletClient, publicClient } = await getClients(wallet);
      const hash = await walletClient.writeContract({
        address: LMSR_HOOK_ADDRESS,
        abi: FPMM_ABI,
        functionName: 'reportPayouts',
        args: [questionId, payouts],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setReportStatus({ ok: true, msg: `Resolved. tx: ${hash.slice(0, 10)}…` });
    } catch (e) {
      setReportStatus({ ok: false, msg: e instanceof Error ? e.message : 'Transaction failed' });
    } finally {
      setReporting(false);
    }
  }

  const isResolvable = research?.resolvable && (research.confidence ?? 0) >= 70;
  const timeLeft = timeUntil(market.end_time);

  return (
    <div className={`adm-market ${expanded ? 'adm-market--expanded' : ''}`}>
      <div className="adm-market__header" onClick={() => setExpanded(e => !e)}>
        <div className="adm-market__info">
          <span className="adm-market__q">{market.question}</span>
          <div className="adm-market__meta">
            <span className={`adm-time ${timeLeft === 'Expired' ? 'adm-time--expired' : ''}`}>{timeLeft}</span>
            {market.outcomes.slice(0, 4).map(o => (
              <span key={o.outcomeIndex} className="adm-outcome-chip">{o.label ?? `#${o.outcomeIndex}`}</span>
            ))}
          </div>
        </div>
        <div className="adm-market__actions" onClick={e => e.stopPropagation()}>
          <button
            className="adm-btn adm-btn--sm"
            onClick={handleResearch}
            disabled={researching}
          >
            {researching ? 'Researching…' : 'Research'}
          </button>
        </div>
        <span className="adm-market__chevron">{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div className="adm-market__body">
          {researching && <div className="adm-loading">Grok is researching this market…</div>}
          {researchErr && <div className="adm-status adm-status--err">{researchErr}</div>}

          {research && (
            <div className="adm-research">
              <div className="adm-research__confidence">
                <span className="adm-research__conf-label">Confidence</span>
                <div className="adm-research__conf-bar">
                  <div
                    className="adm-research__conf-fill"
                    style={{
                      width: `${research.confidence}%`,
                      background: research.confidence >= 70 ? '#22c55e' : research.confidence >= 40 ? '#f59e0b' : '#ef4444',
                    }}
                  />
                </div>
                <span className="adm-research__conf-pct">{research.confidence}%</span>
                <span className={`adm-research__verdict ${isResolvable ? 'adm-research__verdict--yes' : 'adm-research__verdict--no'}`}>
                  {isResolvable ? 'RESOLVABLE' : 'NOT YET'}
                </span>
              </div>

              {research.winningOutcomeIndex !== null && (
                <div className="adm-research__winner">
                  Winner: <strong>{outcomeLabels[research.winningOutcomeIndex]?.label ?? `Outcome ${research.winningOutcomeIndex}`}</strong>
                  &nbsp;· Payouts: [{research.payouts.join(', ')}]
                </div>
              )}

              <p className="adm-research__reasoning">{research.reasoning}</p>

              {research.sources.length > 0 && (
                <div className="adm-research__sources">
                  {research.sources.map((s, i) => (
                    <span key={i} className="adm-source">{s}</span>
                  ))}
                </div>
              )}

              {isResolvable && !reportStatus && (
                <button
                  className="adm-btn adm-btn--resolve"
                  onClick={handleReport}
                  disabled={reporting || !market.question_cid}
                >
                  {reporting ? 'Reporting payout…' : `Report Payout → [${research.payouts.join(', ')}]`}
                </button>
              )}

              {!market.question_cid && isResolvable && (
                <div className="adm-status adm-status--err">Cannot resolve: question_cid missing</div>
              )}
            </div>
          )}

          {reportStatus && (
            <div className={`adm-status ${reportStatus.ok ? 'adm-status--ok' : 'adm-status--err'}`}>
              {reportStatus.msg}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Markets Panel ─────────────────────────────────────────────────────────────

function MarketsPanel({ wallet }: { wallet: { address: string; getEthereumProvider: () => Promise<unknown> } }) {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/markets?limit=100');
      const data = await res.json();
      setMarkets(data.markets ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load markets');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <section className="adm-panel">
      <div className="adm-panel__header">
        <h2 className="adm-panel__title">Open Markets</h2>
        <button className="adm-btn adm-btn--sm" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      {error && <div className="adm-status adm-status--err">{error}</div>}
      {loading && <div className="adm-loading">Loading markets…</div>}
      {!loading && markets.length === 0 && (
        <div className="adm-empty">No markets found.</div>
      )}
      <div className="adm-markets-list">
        {markets.map(m => (
          <MarketRow key={m.id} market={m} wallet={wallet} />
        ))}
      </div>
    </section>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const { ready, authenticated } = usePrivy();
  const { wallets } = useWallets();
  const wallet = wallets[0];
  const address = wallet?.address?.toLowerCase();
  const oracleAddr = ORACLE_ACCOUNT.toLowerCase();
  const isOracle = !!address && !!oracleAddr && oracleAddr !== '0x' && address === oracleAddr;

  if (!ready) {
    return (
      <div className="adm-page">
        <div className="adm-loading adm-loading--full">Initializing…</div>
      </div>
    );
  }

  return (
    <div className="adm-page">
      <header className="adm-header">
        <div className="adm-header__left">
          <Link href="/" className="adm-header__back">← Home</Link>
          <span className="adm-header__sep">/</span>
          <span className="adm-header__crumb">Admin</span>
        </div>
        <div className="adm-header__right">
          {authenticated && wallet && (
            <div className={`adm-oracle-badge ${isOracle ? 'adm-oracle-badge--ok' : 'adm-oracle-badge--warn'}`}>
              <span className="adm-oracle-badge__dot" />
              {isOracle ? 'Oracle Connected' : 'Not Oracle'}
            </div>
          )}
          <WalletButton />
        </div>
      </header>

      {!authenticated && (
        <div className="adm-gate">
          <span className="adm-gate__icon">◈</span>
          <p className="adm-gate__msg">Connect the oracle wallet to access the admin dashboard.</p>
        </div>
      )}

      {authenticated && !isOracle && (
        <div className="adm-gate">
          <span className="adm-gate__icon adm-gate__icon--warn">⚠</span>
          <p className="adm-gate__msg">
            Connected wallet is not the oracle account.
          </p>
          <p className="adm-gate__sub">
            Expected: <code className="adm-code">{ORACLE_ACCOUNT}</code>
          </p>
          <p className="adm-gate__sub">
            Connected: <code className="adm-code">{wallet?.address ?? '—'}</code>
          </p>
        </div>
      )}

      {authenticated && isOracle && wallet && (
        <main className="adm-main">
          <AgentPanel />
          <FeePanel wallet={wallet} />
          <MarketsPanel wallet={wallet} />
        </main>
      )}
    </div>
  );
}
