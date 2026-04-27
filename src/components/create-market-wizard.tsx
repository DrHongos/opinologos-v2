'use client';

import { useState } from 'react';
import { useWallets } from '@privy-io/react-auth';
import {
  createWalletClient,
  createPublicClient,
  custom,
  keccak256,
  encodePacked,
  parseEventLogs,
  parseUnits,
} from 'viem';
import {
  LMSR_HOOK_ADDRESS,
  COLLATERAL_TOKEN,
  ORACLE_ACCOUNT,
  CT_ABI,
  FPMM_ABI,
  ERC20_ABI,
} from '@/lib/contracts';
import { getChain } from '@/lib/chain';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Outcome {
  id: number;
  label: string;
  description: string;
}

interface GeneratedMarket {
  schema: string;
  id: string;
  question: string;
  description: string;
  createdAt: number;
  endTime: number;
  outcomes: Outcome[];
  resolution: { source: string; method: string; notes: string };
  oracle: string;
  attention: {
    entities: string[];
    topics: string[];
    signals: string[];
    keywords: string[];
  };
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

// ── Step indicator ─────────────────────────────────────────────────────────────

const STEP_LABELS = ['Generate', 'Prepare', 'Create OS', 'Fund', 'Complete'];

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

// ── Field display ──────────────────────────────────────────────────────────────

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
        <a
          href={`${explorer}/tx/${hash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="cmw__field-link"
        >
          {trunc(hash)} ↗
        </a>
      ) : (
        <span className="cmw__field-mono">{trunc(hash)}</span>
      )}
    </div>
  );
}

// ── Error + action bar ─────────────────────────────────────────────────────────

function ErrorBanner({ msg }: { msg: string }) {
  return (
    <div className="cmw__error">
      <span>✕</span>
      <span>{msg}</span>
    </div>
  );
}

function ActionBar({
  label,
  onClick,
  loading,
  disabled,
}: {
  label: string;
  onClick: () => void;
  loading: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="cmw__actions">
      <button
        className="cmf__submit"
        onClick={onClick}
        disabled={loading || disabled}
      >
        {loading ? <><span className="cmf__spinner" /> Working…</> : <><span>◈</span> {label}</>}
      </button>
    </div>
  );
}

// ── Main wizard ────────────────────────────────────────────────────────────────

export function CreateMarketWizard() {
  const { wallets } = useWallets();
  const wallet = wallets[0];

  // Step progression
  const [step, setStep] = useState(1);

  // Step 1 — Generate + auto-upload to IPFS
  const [question, setQuestion] = useState('');
  const [market, setMarket] = useState<GeneratedMarket | null>(null);
  const [questionCid, setQuestionCid] = useState('');
  const [questionId, setQuestionId] = useState<Hash | null>(null);

  // Step 2 — Prepare condition
  const [prepareTxHash, setPrepareTxHash] = useState('');
  const [conditionId, setConditionId] = useState<Hash | null>(null);

  // Step 3 — Create OS + auto-publish
  const [createOsTxHash, setCreateOsTxHash] = useState('');
  const [osIndex, setOsIndex] = useState<Hash | null>(null);
  const [outcomeTokenIds, setOutcomeTokenIds] = useState<bigint[]>([]);
  const [initialWeights, setInitialWeights] = useState<number[]>([]);
  const [finalCid, setFinalCid] = useState('');
  const [ensSlug, setEnsSlug] = useState('');

  // Step 4 — Fund
  const [fundAmount, setFundAmount] = useState('');
  const [fundTxHash, setFundTxHash] = useState('');

  // UI
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // ── Step handlers ─────────────────────────────────────────────────────────

  async function handleGenerate() {
    setLoading(true);
    setError('');
    try {
      const genRes = await fetch('/api/generate-market', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      const genData = await genRes.json();
      if (!genRes.ok || genData.error) throw new Error(genData.error ?? 'Generation failed');
      const m = genData.market as GeneratedMarket;
      setMarket(m);
      setInitialWeights(m.outcomes.map(() => 1));

      // Auto-pin to IPFS immediately after generation
      const upRes = await fetch('/api/upload-market', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: m, name: `market-${m.id}.json` }),
      });
      const upData = await upRes.json();
      if (!upRes.ok || upData.error) throw new Error(upData.error ?? 'IPFS upload failed');

      const cid = upData.cid as string;
      setQuestionCid(cid);
      // questionId = keccak256 of CID UTF-8 bytes — oracle uses same encoding for reportPayouts
      const qId = keccak256(new TextEncoder().encode(cid));
      setQuestionId(qId);

      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  async function handlePrepareCondition() {
    if (!wallet || !market || !questionId) return;
    setLoading(true);
    setError('');
    setPrepareTxHash('');
    try {
      const { walletClient, publicClient } = await getClients(wallet);
      const outcomeCount = market.outcomes.length;

      const hash = await walletClient.writeContract({
        address: LMSR_HOOK_ADDRESS,
        abi: CT_ABI,
        functionName: 'prepareCondition',
        args: [ORACLE_ACCOUNT, questionId, BigInt(outcomeCount)],
      });
      setPrepareTxHash(hash);

      await publicClient.waitForTransactionReceipt({ hash });

      // conditionId = keccak256(abi.encodePacked(oracle, questionId, outcomeSlotCount))
      const cId = keccak256(
        encodePacked(
          ['address', 'bytes32', 'uint256'],
          [ORACLE_ACCOUNT, questionId, BigInt(outcomeCount)],
        ),
      );
      setConditionId(cId);
      setStep(3);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transaction failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateOS() {
    if (!wallet || !conditionId || !market) return;
    setLoading(true);
    setError('');
    setCreateOsTxHash('');
    try {
      const { walletClient, publicClient } = await getClients(wallet);

      const hash = await walletClient.writeContract({
        address: LMSR_HOOK_ADDRESS,
        abi: FPMM_ABI,
        functionName: 'createOutcomeSpace',
        args: [COLLATERAL_TOKEN, [conditionId], initialWeights.map(BigInt)],
      });
      setCreateOsTxHash(hash);

      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      const osLogs = parseEventLogs({ abi: FPMM_ABI, eventName: 'OSCreated', logs: receipt.logs });
      if (!osLogs.length) throw new Error('OSCreated event not found in receipt');

      const { osIndex: osIdx } = osLogs[0].args;
      setOsIndex(osIdx as Hash);

      // Read ERC-6909 token IDs for each outcome (linear index 0..N-1)
      const tokenIds = (await Promise.all(
        Array.from({ length: market.outcomes.length }, (_, i) =>
          publicClient.readContract({
            address: LMSR_HOOK_ADDRESS,
            abi: FPMM_ABI,
            functionName: 'outcomeTokenId',
            args: [osIdx as Hash, i],
          }),
        ),
      )) as bigint[];
      setOutcomeTokenIds(tokenIds);

      // Auto-publish: build complete market JSON and pin to IPFS
      const outcomeMarkets = market.outcomes.map((o, i) => ({
        outcomeIndex: i,
        label: o.label,
        erc6909Id: tokenIds[i] !== undefined
          ? ('0x' + tokenIds[i].toString(16).padStart(64, '0'))
          : null,
      }));

      const finalMarket = {
        ...market,
        markets: outcomeMarkets,
        probabilityModel: {
          type: 'fpmm',
          osIndex: osIdx,
          conditionId,
          collateral: COLLATERAL_TOKEN,
          hook: LMSR_HOOK_ADDRESS,
        },
        ipfs: { questionCid, marketCid: null },
      };

      const uploadRes = await fetch('/api/upload-market', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: finalMarket, name: `market-complete-${market.id}.json` }),
      });
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok || uploadData.error) throw new Error(uploadData.error ?? 'Upload failed');
      const cid = uploadData.cid as string;
      setFinalCid(cid);

      const regRes = await fetch('/api/markets/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: market.id,
          question: market.question,
          questionCid,
          marketCid: cid,
          osIndex: osIdx,
          conditionId,
          description: market.description,
          endTime: market.endTime,
          oracle: market.oracle,
          collateral: COLLATERAL_TOKEN,
          hookAddress: LMSR_HOOK_ADDRESS,
          resolution: market.resolution,
          attention: market.attention,
          outcomes: outcomeMarkets,
        }),
      });
      if (regRes.ok) {
        const { slug } = await regRes.json();
        setEnsSlug(slug as string);
      }

      setStep(4);
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

      // i think this is very wrong, liquidity must be handled by the hook
      // Approve the PoolManager to pull collateral on behalf of the user
      //const pmAddress = await publicClient.readContract({
      //  address: LMSR_HOOK_ADDRESS,
      //  abi: FPMM_ABI,
      //  functionName: 'poolManager',
      //}) as Hash;

      const pmAddress = LMSR_HOOK_ADDRESS

      const allowance = await publicClient.readContract({
        address: COLLATERAL_TOKEN,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [wallet.address as Hash, pmAddress],
      }) as bigint;
      //console.log(allowance)
      if (allowance < amountWad) {
        const approveTx = await walletClient.writeContract({
          address: COLLATERAL_TOKEN,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [pmAddress, amountWad],
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

  const chain = getChain();

  return (
    <div className="cmw">
      <StepIndicator current={step} />

      {!wallet && (
        <div className="cmw__wallet-required">
          Connect your wallet above to create a market.
        </div>
      )}

      {/* Step 1 — Generate + auto-upload */}
      {step === 1 && (
        <div className="cmw__body">
          <h2 className="cmw__step-title">Describe your market</h2>
          <p className="cmw__step-sub">
            Grok will compile it into a machine-readable schema with discrete outcomes and a resolution rule, then pin it to IPFS automatically.
          </p>
          <textarea
            className="cmf__textarea"
            placeholder="e.g. Will the next global temperature record be set before 2026?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={4}
            disabled={loading}
          />
          {error && <ErrorBanner msg={error} />}
          <ActionBar label="Generate" onClick={handleGenerate} loading={loading} disabled={!question.trim()} />
        </div>
      )}

      {/* Step 2 — prepareCondition */}
      {step === 2 && market && questionId && (
        <div className="cmw__body">
          <h2 className="cmw__step-title">Prepare condition</h2>
          <p className="cmw__step-sub">
            Registers the condition on-chain. The CID is hashed to <code>questionId</code> — the oracle will use the same encoding when calling <code>reportPayouts</code>.
          </p>

          <div className="cmw__info-grid">
            <Field label="IPFS CID" value={questionCid} />
            <Field label="questionId (bytes32)" value={questionId} />
            <Field label="oracle" value={ORACLE_ACCOUNT} />
            <Field label="outcomeSlotCount" value={String(market.outcomes.length)} />
            {/* responses think its 2024... FIX IT */}
            <Field label="endTime" value={new Date(market.endTime * 1000).toLocaleDateString()} />
            <Field label="contract" value={LMSR_HOOK_ADDRESS} />
            <Field label="chain" value={`${chain.name} (${chain.id})`} mono={false} />
          </div>

          {prepareTxHash && <TxField label="Tx" hash={prepareTxHash} chain={chain} />}
          {error && <ErrorBanner msg={error} />}
          <ActionBar
            label="Call prepareCondition"
            onClick={handlePrepareCondition}
            loading={loading}
            disabled={!wallet}
          />
        </div>
      )}

      {/* Step 3 — createOutcomeSpace + auto-publish */}
      {step === 3 && conditionId && market && (
        <div className="cmw__body">
          <h2 className="cmw__step-title">Create outcome space</h2>
          <p className="cmw__step-sub">
            Set initial liquidity weights to seed the FPMM pool&apos;s starting probabilities. Weights are proportional — a 3:1 ratio gives 75% / 25%. After the transaction confirms, the complete market JSON is pinned to IPFS and registered automatically.
          </p>

          <div className="cmw__info-grid">
            <Field label="conditionId" value={conditionId} />
            <Field label="collateral" value={COLLATERAL_TOKEN} />
            <Field label="contract" value={LMSR_HOOK_ADDRESS} />
          </div>

          {(() => {
            const total = initialWeights.reduce((s, w) => s + w, 0) || 1;
            return (
              <div className="cmw__outcomes">
                {market.outcomes.map((o, i) => {
                  const pct = ((initialWeights[i] ?? 1) / total * 100).toFixed(1);
                  return (
                    <div key={i} className="cmw__outcome">
                      <span className="cmw__outcome-label">{o.label}</span>
                      <div className="cmw__weight-row">
                        <input
                          className="cmw__weight-input"
                          type="number"
                          min={1}
                          step={1}
                          value={initialWeights[i] ?? 1}
                          disabled={loading}
                          onChange={e => {
                            const v = Math.max(1, Math.round(Number(e.target.value) || 1));
                            setInitialWeights(ws => ws.map((w, j) => j === i ? v : w));
                          }}
                        />
                        <span className="cmw__weight-pct">{pct}%</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}

          {createOsTxHash && <TxField label="Tx" hash={createOsTxHash} chain={chain} />}
          {error && <ErrorBanner msg={error} />}
          <ActionBar
            label="Call createOutcomeSpace"
            onClick={handleCreateOS}
            loading={loading}
            disabled={!wallet}
          />
        </div>
      )}

      {/* Step 4 — Fund */}
      {step === 4 && osIndex && market && (
        <div className="cmw__body">
          <h2 className="cmw__step-title">Fund the market</h2>
          <p className="cmw__step-sub">
            Add initial collateral liquidity to the FPMM pool. The collateral is split proportionally across outcomes according to your chosen weights.
          </p>

          <div className="cmw__info-grid">
            <Field label="osIndex" value={osIndex} />
            <Field label="collateral" value={COLLATERAL_TOKEN} />
          </div>

          <div className="cmw__outcomes">
            {(() => {
              const total = initialWeights.reduce((s, w) => s + w, 0) || 1;
              return market.outcomes.map((o, i) => (
                <div key={i} className="cmw__outcome">
                  <span className="cmw__outcome-label">{o.label}</span>
                  <span className="cmw__weight-pct">
                    {((initialWeights[i] ?? 1) / total * 100).toFixed(1)}%
                  </span>
                </div>
              ));
            })()}
          </div>

          <div className="cmw__fund-row">
            <label className="cmw__field-label">Collateral amount (18 decimals)</label>
            <input
              className="cmw__fund-input"
              type="number"
              min="0"
              step="any"
              placeholder="e.g. 100"
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
      {step === 5 && market && osIndex && (
        <div className="cmw__body">
          <div className="cmw__success">
            <div className="cmw__success-row">
              <span className="cmw__result-dot" />
              <span className="cmw__success-label">Market live</span>
            </div>

            <div className="cmw__info-grid">
              <Field label="osIndex" value={osIndex} />
              <Field label="conditionId" value={conditionId!} />
              <Field label="Question CID" value={questionCid} />
              {finalCid && <Field label="Market CID" value={finalCid} />}
              {ensSlug && (
                <Field label="ENS name" value={`${ensSlug}.opinologos.eth`} mono={false} />
              )}
            </div>

            <div className="cmw__outcomes">
              {market.outcomes.map((o, i) => (
                <div key={i} className="cmw__outcome">
                  <span className="cmw__outcome-label">{o.label}</span>
                  <span className="cmw__outcome-addr">
                    {outcomeTokenIds[i] !== undefined
                      ? trunc('0x' + outcomeTokenIds[i].toString(16).padStart(64, '0'), 10, 8)
                      : '—'}
                  </span>
                </div>
              ))}
            </div>

            <p className="cmw__success-note">
              Share the market CID with agents and front-ends. The oracle uses{' '}
              <code>keccak256(cidBytes)</code> as <code>questionId</code> for{' '}
              <code>reportPayouts</code>. Resolve via <code>*.opinologos.eth</code>.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
