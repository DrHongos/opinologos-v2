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
} from 'viem';
import {
  LMSR_HOOK_ADDRESS,
  COLLATERAL_TOKEN,
  ORACLE_ACCOUNT,
  LMSR_B_DEFAULT,
  CT_ABI,
  LMSR_ABI,
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

const STEP_LABELS = ['Generate', 'Upload', 'Prepare', 'Create OS', 'Publish'];

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

  // Step 1 — Generate
  const [question, setQuestion] = useState('');
  const [market, setMarket] = useState<GeneratedMarket | null>(null);

  // Step 2 — Upload
  const [questionCid, setQuestionCid] = useState('');
  const [questionId, setQuestionId] = useState<Hash | null>(null);

  // Step 3 — Prepare condition
  const [prepareTxHash, setPrepareTxHash] = useState('');
  const [conditionId, setConditionId] = useState<Hash | null>(null);

  // Step 4 — Create OS
  const [createOsTxHash, setCreateOsTxHash] = useState('');
  const [osIndex, setOsIndex] = useState<Hash | null>(null);
  const [sharesToken, setSharesToken] = useState('');
  const [positions, setPositions] = useState<readonly bigint[]>([]);
  const [predictionTokens, setPredictionTokens] = useState<Hash[]>([]);

  // Step 5 — Publish
  const [finalCid, setFinalCid] = useState('');

  // UI
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // ── Step handlers ─────────────────────────────────────────────────────────

  async function handleGenerate() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/generate-market', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? 'Generation failed');
      setMarket(data.market as GeneratedMarket);
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  async function handleUpload() {
    if (!market) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/upload-market', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: market, name: `market-${market.id}.json` }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? 'Upload failed');

      const cid = data.cid as string;
      setQuestionCid(cid);

      // questionId = keccak256 of CID UTF-8 bytes — oracle must use same encoding for reportPayouts
      const qId = keccak256(new TextEncoder().encode(cid));
      setQuestionId(qId);
      setStep(3);
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
      setStep(4);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transaction failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateOS() {
    if (!wallet || !conditionId) return;
    setLoading(true);
    setError('');
    setCreateOsTxHash('');
    try {
      const { walletClient, publicClient } = await getClients(wallet);

      const hash = await walletClient.writeContract({
        address: LMSR_HOOK_ADDRESS,
        abi: LMSR_ABI,
        functionName: 'createOS',
        args: [COLLATERAL_TOKEN, [conditionId], LMSR_B_DEFAULT],
      });
      setCreateOsTxHash(hash);

      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      // Decode OSCreated event
      const osLogs = parseEventLogs({ abi: LMSR_ABI, eventName: 'OSCreated', logs: receipt.logs });
      if (!osLogs.length) throw new Error('OSCreated event not found in receipt');

      const { osIndex: osIdx, shares } = osLogs[0].args;
      setOsIndex(osIdx as Hash);
      setSharesToken(shares as string);

      // Read all position IDs from pool
      const [posIds] = await publicClient.readContract({
        address: LMSR_HOOK_ADDRESS,
        abi: LMSR_ABI,
        functionName: 'getPoolBalances',
        args: [osIdx as Hash],
      });
      setPositions(posIds);

      // Resolve each positionId → PredictionToken address
      const ptAddrs = await Promise.all(
        posIds.map((posId) =>
          publicClient.readContract({
            address: LMSR_HOOK_ADDRESS,
            abi: LMSR_ABI,
            functionName: 'prediction_tokens',
            args: [posId],
          }),
        ),
      );
      setPredictionTokens(ptAddrs as Hash[]);
      setStep(5);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transaction failed');
    } finally {
      setLoading(false);
    }
  }

  async function handlePublish() {
    if (!market || !conditionId || !osIndex) return;
    setLoading(true);
    setError('');
    try {
      const finalMarket = {
        ...market,
        markets: market.outcomes.map((o, i) => ({
          outcomeIndex: i,
          label: o.label,
          positionId: positions[i] !== undefined
            ? ('0x' + positions[i].toString(16).padStart(64, '0'))
            : null,
          predictionToken: predictionTokens[i] ?? null,
        })),
        probabilityModel: {
          type: 'lmsr',
          b: LMSR_B_DEFAULT.toString(),
          osIndex,
          sharesToken,
          conditionId,
          collateral: COLLATERAL_TOKEN,
          hook: LMSR_HOOK_ADDRESS,
        },
        ipfs: {
          questionCid,
          marketCid: null, // filled after upload (circular reference)
        },
      };

      const res = await fetch('/api/upload-market', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: finalMarket, name: `market-complete-${market.id}.json` }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? 'Upload failed');
      setFinalCid(data.cid as string);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
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

      {/* Step 1 — Generate */}
      {step === 1 && (
        <div className="cmw__body">
          <h2 className="cmw__step-title">Describe your market</h2>
          <p className="cmw__step-sub">
            Grok will compile it into a machine-readable schema with discrete outcomes and a resolution rule.
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

      {/* Step 2 — Upload metadata to IPFS */}
      {step === 2 && market && (
        <div className="cmw__body">
          <h2 className="cmw__step-title">Upload metadata</h2>
          <p className="cmw__step-sub">
            This file will be pinned to IPFS. Its CID becomes the <code>questionId</code> for the on-chain condition.
          </p>

          <div className="cmw__info-grid">
            <Field label="Question" value={market.question} mono={false} />
            <Field label="Outcomes" value={market.outcomes.map((o) => o.label).join(' · ')} mono={false} />
            <Field label="Oracle" value={ORACLE_ACCOUNT || '(NEXT_PUBLIC_ORACLE_ACCOUNT not set)'} />
            <Field label="Resolution source" value={market.resolution.source} mono={false} />
          </div>

          <div className="cmw__json-preview">
            <div className="cmw__json-header">
              <span className="cmw__result-label">Preview</span>
            </div>
            <pre className="cmf__code">{JSON.stringify(market, null, 2)}</pre>
          </div>

          {error && <ErrorBanner msg={error} />}
          <ActionBar label="Pin to IPFS" onClick={handleUpload} loading={loading} />
        </div>
      )}

      {/* Step 3 — prepareCondition */}
      {step === 3 && market && questionId && (
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

      {/* Step 4 — createOS */}
      {step === 4 && conditionId && (
        <div className="cmw__body">
          <h2 className="cmw__step-title">Create outcome space</h2>
          <p className="cmw__step-sub">
            Deploys one PredictionToken per outcome, initialises Uniswap v4 pools, and mints LP shares.
          </p>

          <div className="cmw__info-grid">
            <Field label="conditionId" value={conditionId} />
            <Field label="collateral" value={COLLATERAL_TOKEN} />
            <Field label="b (LMSR param)" value={`${LMSR_B_DEFAULT.toString()} (1000 WAD)`} />
            <Field label="contract" value={LMSR_HOOK_ADDRESS} />
          </div>

          {createOsTxHash && <TxField label="Tx" hash={createOsTxHash} chain={chain} />}
          {error && <ErrorBanner msg={error} />}
          <ActionBar
            label="Call createOS"
            onClick={handleCreateOS}
            loading={loading}
            disabled={!wallet}
          />
        </div>
      )}

      {/* Step 5 — Complete JSON and publish */}
      {step === 5 && market && osIndex && (
        <div className="cmw__body">
          <h2 className="cmw__step-title">Publish complete market file</h2>
          <p className="cmw__step-sub">
            On-chain addresses have been resolved. Uploading the final agent-readable JSON to IPFS.
          </p>

          <div className="cmw__info-grid">
            <Field label="osIndex" value={osIndex} />
            <Field label="sharesToken" value={sharesToken} />
            <Field label="conditionId" value={conditionId!} />
          </div>

          <div className="cmw__outcomes">
            {market.outcomes.map((o, i) => (
              <div key={i} className="cmw__outcome">
                <span className="cmw__outcome-label">{o.label}</span>
                <span className="cmw__outcome-addr">
                  {predictionTokens[i] ? trunc(predictionTokens[i], 10, 8) : '—'}
                </span>
              </div>
            ))}
          </div>

          {!finalCid ? (
            <>
              {error && <ErrorBanner msg={error} />}
              <ActionBar label="Publish to IPFS" onClick={handlePublish} loading={loading} />
            </>
          ) : (
            <div className="cmw__success">
              <div className="cmw__success-row">
                <span className="cmw__result-dot" />
                <span className="cmw__success-label">Market published</span>
              </div>
              <div className="cmw__info-grid">
                <Field label="Question CID" value={questionCid} />
                <Field label="Market CID" value={finalCid} />
              </div>
              <p className="cmw__success-note">
                Share the market CID with agents and front-ends. The oracle uses{' '}
                <code>keccak256(cidBytes)</code> as <code>questionId</code> for{' '}
                <code>reportPayouts</code>.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
