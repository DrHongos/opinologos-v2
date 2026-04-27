'use client';

import { useState, useRef, useEffect } from 'react';
import { useWallets } from '@privy-io/react-auth';
import {
  createWalletClient,
  createPublicClient,
  custom,
  parseEventLogs,
  parseUnits,
} from 'viem';
import {
  LMSR_HOOK_ADDRESS,
  COLLATERAL_TOKEN,
  ORACLE_ACCOUNT,
  FPMM_ABI,
  ERC20_ABI,
} from '@/lib/contracts';
import { getChain } from '@/lib/chain';

// ── Types ─────────────────────────────────────────────────────────────────────

interface MarketOutcome {
  outcomeIndex: number;
  label: string | null;
}

interface PickedMarket {
  id: string;
  slug: string;
  question: string;
  condition_id: string | null;
  outcomes: MarketOutcome[];
  end_time: string | null;
}

interface ComboOutcome {
  aIdx: number;
  bIdx: number;
  label: string;
}

type Hash = `0x${string}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function trunc(h: string, front = 8, back = 6) {
  return h.length > front + back + 3 ? `${h.slice(0, front)}…${h.slice(-back)}` : h;
}

async function getClients(wallet: { address: string; getEthereumProvider: () => Promise<unknown> }) {
  const provider = await wallet.getEthereumProvider();
  const chain = getChain();
  const walletClient = createWalletClient({
    account: wallet.address as Hash,
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

function buildComboOutcomes(marketA: PickedMarket, marketB: PickedMarket): ComboOutcome[] {
  const combos: ComboOutcome[] = [];
  for (let aIdx = 0; aIdx < marketA.outcomes.length; aIdx++) {
    for (let bIdx = 0; bIdx < marketB.outcomes.length; bIdx++) {
      combos.push({
        aIdx,
        bIdx,
        label: `${marketA.outcomes[aIdx]?.label ?? `#${aIdx}`} × ${marketB.outcomes[bIdx]?.label ?? `#${bIdx}`}`,
      });
    }
  }
  return combos;
}

// ── Shared sub-components ─────────────────────────────────────────────────────

const STEP_LABELS = ['Select A', 'Select B', 'Create OS', 'Fund', 'Complete'];

function StepIndicator({ current }: { current: number }) {
  return (
    <div className="cmw__progress">
      {STEP_LABELS.map((label, i) => {
        const n = i + 1;
        const done = current > n;
        const active = current === n;
        return (
          <div key={n} className="cmw__step-item">
            <div className={`cmw__step-num ${active ? 'cmw__step-num--active' : done ? 'cmw__step-num--done' : ''}`}>
              {done ? '✓' : n}
            </div>
            <span className={`cmw__step-label ${active ? 'cmw__step-label--active' : done ? 'cmw__step-label--done' : ''}`}>
              {label}
            </span>
            {i < STEP_LABELS.length - 1 && (
              <div className={`cmw__connector ${done ? 'cmw__connector--done' : ''}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function Field({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="cmw__field">
      <span className="cmw__field-label">{label}</span>
      <span className={mono ? 'cmw__field-mono' : 'cmw__field-value'}>{value}</span>
    </div>
  );
}

function TxField({ label, hash, chain }: { label: string; hash: string; chain: ReturnType<typeof getChain> }) {
  const explorer = chain.blockExplorers?.default?.url;
  return (
    <div className="cmw__field">
      <span className="cmw__field-label">{label}</span>
      {explorer ? (
        <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noopener noreferrer" className="cmw__field-link">
          {trunc(hash)} ↗
        </a>
      ) : (
        <span className="cmw__field-mono">{trunc(hash)}</span>
      )}
    </div>
  );
}

function ErrorBanner({ msg }: { msg: string }) {
  return (
    <div className="cmw__error"><span>✕</span><span>{msg}</span></div>
  );
}

function ActionBar({ label, onClick, loading, disabled }: {
  label: string; onClick: () => void; loading: boolean; disabled?: boolean;
}) {
  return (
    <div className="cmw__actions">
      <button className="cmf__submit" onClick={onClick} disabled={loading || disabled}>
        {loading ? <><span className="cmf__spinner" /> Working…</> : <><span>◈</span> {label}</>}
      </button>
    </div>
  );
}

// ── Market picker ─────────────────────────────────────────────────────────────

function MarketPicker({ onSelect, excludeId }: {
  onSelect: (m: PickedMarket) => void;
  excludeId?: string;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PickedMarket[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function fetchMarkets(q: string) {
    setSearching(true);
    try {
      const url = q.trim()
        ? `/api/markets?q=${encodeURIComponent(q)}&limit=8`
        : `/api/markets?limit=8`;
      const res = await fetch(url);
      const data = await res.json();
      setResults(
        (data.markets ?? []).filter((m: PickedMarket) => m.condition_id && m.id !== excludeId),
      );
    } finally {
      setSearching(false);
    }
  }

  useEffect(() => {
    fetchMarkets('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [excludeId]);

  function handleInput(v: string) {
    setQuery(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchMarkets(v), 300);
  }

  return (
    <div className="mmw__picker">
      <div className="mmw__search-wrap">
        <span className="mmw__search-prefix">&gt;_</span>
        <input
          className="mmw__search-input"
          type="text"
          placeholder="Search markets…"
          value={query}
          onChange={e => handleInput(e.target.value)}
          autoFocus
        />
        {searching && <span className="cmf__spinner" />}
      </div>
      {results.length > 0 && (
        <div className="mmw__results">
          {results.map(m => (
            <button key={m.id} className="mmw__result" onClick={() => onSelect(m)}>
              <span className="mmw__result-q">{m.question}</span>
              <span className="mmw__result-outcomes">
                {m.outcomes.map(o => o.label).filter(Boolean).join(' · ')}
              </span>
            </button>
          ))}
        </div>
      )}
      {!searching && query.trim() && results.length === 0 && (
        <p className="mmw__no-results">No eligible markets found.</p>
      )}
    </div>
  );
}

function SelectedCard({ market, slot, onClear }: {
  market: PickedMarket; slot: 'A' | 'B'; onClear: () => void;
}) {
  return (
    <div className="mmw__selected">
      <div className="mmw__selected-header">
        <span className="mmw__selected-slot">Market {slot}</span>
        <button className="mmw__selected-clear" onClick={onClear}>✕ Change</button>
      </div>
      <p className="mmw__selected-q">{market.question}</p>
      <div className="mmw__selected-outcomes">
        {market.outcomes.map(o => (
          <span key={o.outcomeIndex} className="mmw__selected-outcome">
            {o.label ?? `#${o.outcomeIndex}`}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Recovery panel (for already-created OS with no DB entry) ──────────────────

function RecoverPanel() {
  const [osIndex, setOsIndex] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ slug: string; marketCid: string } | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);

  async function handleRecover() {
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const res = await fetch('/api/markets/recover-mixed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ osIndex: osIndex.trim() }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? 'Recovery failed');
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Recovery failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mmw__recover">
      <button className="mmw__recover-toggle" onClick={() => setOpen(o => !o)}>
        {open ? '▲' : '▼'} Recover existing OS
      </button>
      {open && (
        <div className="mmw__recover-body">
          <p className="cmw__step-sub">
            If a previous <code>createOutcomeSpace</code> TX succeeded but the market was never registered, paste the <code>osIndex</code> here to reconstruct and store it.
          </p>
          <div className="mmw__search-wrap" style={{ marginTop: '0.5rem' }}>
            <span className="mmw__search-prefix">OS</span>
            <input
              className="mmw__search-input"
              style={{ fontFamily: 'var(--font-geist-mono), monospace', fontSize: '0.82rem' }}
              type="text"
              placeholder="0x…"
              value={osIndex}
              onChange={e => setOsIndex(e.target.value)}
            />
          </div>
          {error && <ErrorBanner msg={error} />}
          {result && (
            <div className="mmw__recover-success">
              <span className="cmw__result-dot" />
              <span>Recovered: <strong>{result.slug}.declareindependence.eth</strong></span>
            </div>
          )}
          <ActionBar
            label="Recover"
            onClick={handleRecover}
            loading={loading}
            disabled={!osIndex.trim() || osIndex.trim().length < 10}
          />
        </div>
      )}
    </div>
  );
}

// ── Main wizard ────────────────────────────────────────────────────────────────

export function MixMarketsWizard() {
  const { wallets } = useWallets();
  const wallet = wallets[0];

  const [step, setStep] = useState(1);

  // Steps 1 & 2
  const [marketA, setMarketA] = useState<PickedMarket | null>(null);
  const [marketB, setMarketB] = useState<PickedMarket | null>(null);

  // Step 3 — on-chain
  const [initialWeights, setInitialWeights] = useState<number[]>([]);
  const [createOsTxHash, setCreateOsTxHash] = useState('');
  const [osIndex, setOsIndex] = useState<Hash | null>(null);
  const [outcomeTokenIds, setOutcomeTokenIds] = useState<bigint[]>([]);

  // Step 3 — off-chain registration (separate from TX so it can be retried)
  const [regStatus, setRegStatus] = useState<'idle' | 'pending' | 'done' | 'failed'>('idle');
  const [finalCid, setFinalCid] = useState('');
  const [ensSlug, setEnsSlug] = useState('');
  const [regError, setRegError] = useState('');

  // Step 4 — fund
  const [fundAmount, setFundAmount] = useState('');
  const [fundTxHash, setFundTxHash] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const chain = getChain();

  const comboOutcomes: ComboOutcome[] =
    marketA && marketB ? buildComboOutcomes(marketA, marketB) : [];

  // ── Registration (retryable, no wallet needed) ───────────────────────────

  async function handleRegister(
    osIdx: Hash,
    tokenIds: bigint[],
    mA: PickedMarket,
    mB: PickedMarket,
    combos: ComboOutcome[],
  ) {
    setRegStatus('pending');
    setRegError('');
    try {
      const condIdA = mA.condition_id as Hash;
      const condIdB = mB.condition_id as Hash;

      const endTimeA = mA.end_time ? new Date(mA.end_time).getTime() / 1000 : null;
      const endTimeB = mB.end_time ? new Date(mB.end_time).getTime() / 1000 : null;
      const endTime =
        endTimeA && endTimeB
          ? Math.min(endTimeA, endTimeB)
          : endTimeA ?? endTimeB ?? Math.floor(Date.now() / 1000) + 86400 * 365;

      const outcomeRecords = combos.map((c, i) => ({
        outcomeIndex: i,
        label: c.label,
        erc6909Id:
          tokenIds[i] !== undefined
            ? '0x' + tokenIds[i].toString(16).padStart(64, '0')
            : null,
      }));

      const mixId = crypto.randomUUID();
      const question = `${mA.question} × ${mB.question}`;
      const description = `Combined prediction market pairing "${mA.question}" with "${mB.question}".`;

      const marketJson = {
        schema: 'pm-mix-v1',
        id: mixId,
        question,
        description,
        createdAt: Math.floor(Date.now() / 1000),
        endTime,
        sourceMarkets: [
          { conditionId: condIdA, question: mA.question, slug: mA.slug, outcomes: mA.outcomes },
          { conditionId: condIdB, question: mB.question, slug: mB.slug, outcomes: mB.outcomes },
        ],
        outcomes: outcomeRecords,
        oracle: ORACLE_ACCOUNT,
        probabilityModel: {
          type: 'fpmm',
          osIndex: osIdx,
          conditions: [condIdA, condIdB],
          collateral: COLLATERAL_TOKEN,
          hook: LMSR_HOOK_ADDRESS,
        },
      };

      const uploadRes = await fetch('/api/upload-market', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: marketJson, name: `mix-${mixId}.json` }),
      });
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok || uploadData.error) throw new Error(uploadData.error ?? 'IPFS upload failed');
      const cid = uploadData.cid as string;
      setFinalCid(cid);

      const regRes = await fetch('/api/markets/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: mixId,
          question,
          questionCid: cid,
          marketCid: cid,
          osIndex: osIdx,
          conditionId: condIdA,
          description,
          endTime,
          oracle: ORACLE_ACCOUNT,
          collateral: COLLATERAL_TOKEN,
          hookAddress: LMSR_HOOK_ADDRESS,
          outcomes: outcomeRecords,
          conditions: [
            { id: condIdA, slots: mA.outcomes.length, question: mA.question },
            { id: condIdB, slots: mB.outcomes.length, question: mB.question },
          ],
        }),
      });
      const regData = await regRes.json();
      if (!regRes.ok || regData.error) throw new Error(regData.error ?? 'DB registration failed');
      setEnsSlug(regData.slug as string);

      setRegStatus('done');
      setStep(4);
    } catch (e) {
      setRegStatus('failed');
      setRegError(e instanceof Error ? e.message : 'Registration failed');
    }
  }

  // ── On-chain TX (Step 3) ─────────────────────────────────────────────────

  async function handleCreateOS() {
    if (!wallet || !marketA || !marketB) return;
    setLoading(true);
    setError('');
    setCreateOsTxHash('');
    try {
      const { walletClient, publicClient } = await getClients(wallet);
      const condIdA = marketA.condition_id as Hash;
      const condIdB = marketB.condition_id as Hash;

      const hash = await walletClient.writeContract({
        address: LMSR_HOOK_ADDRESS,
        abi: FPMM_ABI,
        functionName: 'createOutcomeSpace',
        args: [COLLATERAL_TOKEN, [condIdA, condIdB], initialWeights.map(BigInt)],
      });
      setCreateOsTxHash(hash);

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const osLogs = parseEventLogs({ abi: FPMM_ABI, eventName: 'OSCreated', logs: receipt.logs });
      if (!osLogs.length) throw new Error('OSCreated event not found in receipt');

      const { osIndex: osIdx } = osLogs[0].args;
      setOsIndex(osIdx as Hash);

      const tokenIds = (await Promise.all(
        comboOutcomes.map((_, i) =>
          publicClient.readContract({
            address: LMSR_HOOK_ADDRESS,
            abi: FPMM_ABI,
            functionName: 'outcomeTokenId',
            args: [osIdx as Hash, i],
          }),
        ),
      )) as bigint[];
      setOutcomeTokenIds(tokenIds);

      // Off-chain registration runs immediately but can be retried independently
      await handleRegister(osIdx as Hash, tokenIds, marketA, marketB, comboOutcomes);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transaction failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleFund() {
    if (!wallet || !osIndex) return;
    setLoading(true);
    setError('');
    setFundTxHash('');
    try {
      const { walletClient, publicClient } = await getClients(wallet);
      const amountWad = parseUnits(fundAmount, 18);

      const allowance = (await publicClient.readContract({
        address: COLLATERAL_TOKEN,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [wallet.address as Hash, LMSR_HOOK_ADDRESS],
      })) as bigint;

      if (allowance < amountWad) {
        const approveTx = await walletClient.writeContract({
          address: COLLATERAL_TOKEN,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [LMSR_HOOK_ADDRESS, amountWad],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTx });
      }

      const hash = await walletClient.writeContract({
        address: LMSR_HOOK_ADDRESS,
        abi: FPMM_ABI,
        functionName: 'addLiquidity',
        args: [osIndex, amountWad],
        gas: 2_000_000n,
      });
      setFundTxHash(hash);
      await publicClient.waitForTransactionReceipt({ hash });

      setStep(5);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transaction failed');
    } finally {
      setLoading(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="cmw">
      <StepIndicator current={step} />

      {!wallet && (
        <div className="cmw__wallet-required">Connect your wallet above to create a market.</div>
      )}

      {/* Step 1 — Select Market A */}
      {step === 1 && (
        <div className="cmw__body">
          <h2 className="cmw__step-title">Select first market</h2>
          <p className="cmw__step-sub">
            Pick the first prediction variable. Only markets with an active on-chain condition are shown.
          </p>
          <MarketPicker onSelect={m => { setMarketA(m); setError(''); setStep(2); }} />
          {error && <ErrorBanner msg={error} />}
          <RecoverPanel />
        </div>
      )}

      {/* Step 2 — Select Market B */}
      {step === 2 && marketA && (
        <div className="cmw__body">
          <h2 className="cmw__step-title">Select second market</h2>
          <p className="cmw__step-sub">
            Pick a different market. The outcome space will be the Cartesian product of both.
          </p>
          <SelectedCard market={marketA} slot="A" onClear={() => setStep(1)} />
          <MarketPicker
            onSelect={m => {
              setMarketB(m);
              setInitialWeights(Array(marketA.outcomes.length * m.outcomes.length).fill(1));
              setError('');
              setStep(3);
            }}
            excludeId={marketA.id}
          />
          {error && <ErrorBanner msg={error} />}
        </div>
      )}

      {/* Step 3 — Create OS */}
      {step === 3 && marketA && marketB && (
        <div className="cmw__body">
          <h2 className="cmw__step-title">Create outcome space</h2>
          <p className="cmw__step-sub">
            {comboOutcomes.length} joint outcomes ({marketA.outcomes.length} × {marketB.outcomes.length}).
            Adjust weights to seed starting probabilities.
          </p>

          <div className="mmw__pair">
            <SelectedCard market={marketA} slot="A" onClear={() => { setMarketA(null); setStep(1); }} />
            <div className="mmw__pair-x">×</div>
            <SelectedCard market={marketB} slot="B" onClear={() => { setMarketB(null); setStep(2); }} />
          </div>

          <div className="cmw__info-grid">
            <Field label="conditionId A" value={marketA.condition_id!} />
            <Field label="conditionId B" value={marketB.condition_id!} />
            <Field label="collateral" value={COLLATERAL_TOKEN} />
            <Field label="contract" value={LMSR_HOOK_ADDRESS} />
            <Field label="chain" value={`${chain.name} (${chain.id})`} mono={false} />
          </div>

          <div className="cmw__outcomes">
            {comboOutcomes.map((c, i) => {
              const total = initialWeights.reduce((s, w) => s + w, 0) || 1;
              const pct = (((initialWeights[i] ?? 1) / total) * 100).toFixed(1);
              return (
                <div key={i} className="cmw__outcome">
                  <span className="cmw__outcome-label">{c.label}</span>
                  <div className="cmw__weight-row">
                    <input
                      className="cmw__weight-input"
                      type="number" min={1} step={1}
                      value={initialWeights[i] ?? 1}
                      disabled={loading}
                      onChange={e => {
                        const v = Math.max(1, Math.round(Number(e.target.value) || 1));
                        setInitialWeights(ws => ws.map((w, j) => (j === i ? v : w)));
                      }}
                    />
                    <span className="cmw__weight-pct">{pct}%</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* After on-chain TX succeeds: show osIndex prominently so it's never lost */}
          {osIndex && (
            <div className="mmw__os-saved">
              <span className="mmw__os-saved-label">OS created</span>
              <span className="cmw__field-mono">{osIndex}</span>
            </div>
          )}

          {createOsTxHash && <TxField label="Tx" hash={createOsTxHash} chain={chain} />}

          {/* Registration status */}
          {regStatus === 'pending' && (
            <div className="mmw__reg-status">
              <span className="cmf__spinner" /> Pinning to IPFS and registering…
            </div>
          )}
          {regStatus === 'failed' && (
            <div className="cmw__body" style={{ gap: '0.75rem' }}>
              <div className="mmw__reg-warn">
                <strong>TX succeeded</strong> — osIndex is saved above. Registration failed (IPFS/DB). Retry below without paying gas again.
              </div>
              {regError && <ErrorBanner msg={regError} />}
              <ActionBar
                label="Retry registration"
                onClick={() => handleRegister(osIndex!, outcomeTokenIds, marketA, marketB, comboOutcomes)}
                loading={false}
                disabled={!osIndex}
              />
            </div>
          )}

          {error && <ErrorBanner msg={error} />}

          {/* Only show the TX button if we haven't done the on-chain TX yet */}
          {!osIndex && (
            <ActionBar
              label="Call createOutcomeSpace"
              onClick={handleCreateOS}
              loading={loading}
              disabled={!wallet}
            />
          )}
        </div>
      )}

      {/* Step 4 — Fund */}
      {step === 4 && osIndex && (
        <div className="cmw__body">
          <h2 className="cmw__step-title">Fund the market</h2>
          <p className="cmw__step-sub">Add initial collateral liquidity to seed the FPMM pool.</p>

          <div className="cmw__info-grid">
            <Field label="osIndex" value={osIndex} />
            <Field label="collateral" value={COLLATERAL_TOKEN} />
          </div>

          <div className="cmw__fund-row">
            <label className="cmw__field-label">Collateral amount (18 decimals)</label>
            <input
              className="cmw__fund-input"
              type="number" min="0" step="any" placeholder="e.g. 100"
              value={fundAmount}
              disabled={loading}
              onChange={e => setFundAmount(e.target.value)}
            />
          </div>

          {fundTxHash && <TxField label="Tx" hash={fundTxHash} chain={chain} />}
          {error && <ErrorBanner msg={error} />}
          <ActionBar
            label="Add liquidity"
            onClick={handleFund}
            loading={loading}
            disabled={!wallet || !fundAmount || Number(fundAmount) <= 0}
          />
        </div>
      )}

      {/* Step 5 — Complete */}
      {step === 5 && osIndex && marketA && marketB && (
        <div className="cmw__body">
          <div className="cmw__success">
            <div className="cmw__success-row">
              <span className="cmw__result-dot" />
              <span className="cmw__success-label">Mixed market live</span>
            </div>

            <div className="cmw__info-grid">
              <Field label="osIndex" value={osIndex} />
              <Field label="conditionId A" value={marketA.condition_id!} />
              <Field label="conditionId B" value={marketB.condition_id!} />
              {finalCid && <Field label="Market CID" value={finalCid} />}
              {ensSlug && <Field label="ENS name" value={`${ensSlug}.declareindependence.eth`} mono={false} />}
            </div>

            <div className="cmw__outcomes">
              {comboOutcomes.map((c, i) => (
                <div key={i} className="cmw__outcome">
                  <span className="cmw__outcome-label">{c.label}</span>
                  <span className="cmw__outcome-addr">
                    {outcomeTokenIds[i] !== undefined
                      ? trunc('0x' + outcomeTokenIds[i].toString(16).padStart(64, '0'), 10, 8)
                      : '—'}
                  </span>
                </div>
              ))}
            </div>

            <p className="cmw__success-note">
              Combined <code>{marketA.slug}</code> × <code>{marketB.slug}</code>.
              Resolve via <code>*.declareindependence.eth</code>.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
