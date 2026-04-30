'use client';

import { useState, useCallback } from 'react';
import { useWallets } from '@privy-io/react-auth';
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseUnits,
} from 'viem';
import { getChain } from '@/lib/chain';
import { FPMM_ABI, ERC20_ABI, LMSR_HOOK_ADDRESS, COLLATERAL_TOKEN } from '@/lib/contracts';

interface Outcome {
  outcomeIndex: number;
  label: string | null;
  tokenAddress: string;
  positionId: string | null;
}

export interface SlotInfo {
  label: string;
  conditionIndex: number;
  slotIndex: number;
  price: number | null;
  sourceOsIndex: string;
}

interface SlotPanelProps {
  slot: SlotInfo | null;
  slug: string;
  onClose: () => void;
  onTradeOutcome: (o: Outcome, osIndex: string) => void;
  onTxSuccess?: () => void;
}

type Tab = 'split' | 'merge';

export function SlotPanel({ slot, slug, onClose, onTradeOutcome, onTxSuccess }: SlotPanelProps) {
  const isOpen = slot !== null;
  const [tab, setTab] = useState<Tab>('split');
  const [amount, setAmount] = useState('');
  const [txPending, setTxPending] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);
  const { wallets } = useWallets();

  const publicClient = createPublicClient({ chain: getChain(), transport: http() });

  const getWalletClient = useCallback(async () => {
    const wallet = wallets[0];
    if (!wallet) throw new Error('No wallet connected');
    const provider = await wallet.getEthereumProvider();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = createWalletClient({ chain: getChain(), transport: custom(provider as any) });
    const [account] = await client.getAddresses();
    return { client, account };
  }, [wallets]);

  const sourceOsIndex = slot?.sourceOsIndex ?? '0x';

  async function handleSplit() {
    if (!amount) return;
    setTxPending(true);
    setTxError(null);
    try {
      const { client, account } = await getWalletClient();
      const amountWad = parseUnits(amount, 18);

      const allowance = await publicClient.readContract({
        address: COLLATERAL_TOKEN,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [account, LMSR_HOOK_ADDRESS],
      }) as bigint;

      if (allowance < amountWad) {
        const approveTx = await client.writeContract({
          address: COLLATERAL_TOKEN,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [LMSR_HOOK_ADDRESS, amountWad],
          account,
          chain: getChain(),
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTx });
      }

      const tx = await client.writeContract({
        address: LMSR_HOOK_ADDRESS,
        abi: FPMM_ABI,
        functionName: 'splitCollateral',
        args: [sourceOsIndex as `0x${string}`, amountWad],
        account,
        chain: getChain(),
        gas: 2_000_000n,
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });

      if (slug) {
        fetch(`/api/markets/${slug}/record-activity`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ txHash: tx, userAddress: account, direction: 'split_position', amountUsdc: amount }),
        }).catch(() => {});
      }
      setAmount('');
      onTxSuccess?.();
    } catch (e) {
      setTxError(e instanceof Error ? e.message : String(e));
    } finally {
      setTxPending(false);
    }
  }

  async function handleMerge() {
    if (!amount) return;
    setTxPending(true);
    setTxError(null);
    try {
      const { client, account } = await getWalletClient();
      const amountWad = parseUnits(amount, 18);

      const isOp = await publicClient.readContract({
        address: LMSR_HOOK_ADDRESS,
        abi: FPMM_ABI,
        functionName: 'isOperator',
        args: [account, LMSR_HOOK_ADDRESS],
      }) as boolean;

      if (!isOp) {
        const opTx = await client.writeContract({
          address: LMSR_HOOK_ADDRESS,
          abi: FPMM_ABI,
          functionName: 'setOperator',
          args: [LMSR_HOOK_ADDRESS, true],
          account,
          chain: getChain(),
        });
        await publicClient.waitForTransactionReceipt({ hash: opTx });
      }

      const tx = await client.writeContract({
        address: LMSR_HOOK_ADDRESS,
        abi: FPMM_ABI,
        functionName: 'mergeCollateral',
        args: [sourceOsIndex as `0x${string}`, amountWad],
        account,
        chain: getChain(),
        gas: 2_000_000n,
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });

      if (slug) {
        fetch(`/api/markets/${slug}/record-activity`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ txHash: tx, userAddress: account, direction: 'merge_position', amountUsdc: amount }),
        }).catch(() => {});
      }
      setAmount('');
      onTxSuccess?.();
    } catch (e) {
      setTxError(e instanceof Error ? e.message : String(e));
    } finally {
      setTxPending(false);
    }
  }

  function handleTrade() {
    if (!slot) return;
    const outcome: Outcome = {
      outcomeIndex: slot.slotIndex,
      label: slot.label,
      tokenAddress: '0x',
      positionId: null,
    };
    onTradeOutcome(outcome, slot.sourceOsIndex);
  }

  return (
    <>
      {isOpen && <div className="mg-backdrop" onClick={onClose} />}
      <div className={`mg-panel${isOpen ? ' mg-panel--open' : ''}`}>
        <button className="mg-panel__close" onClick={onClose} aria-label="Close">✕</button>

        <div className="mg-panel__header">
          <span className="mg-panel__tag">
            Source {slot ? slot.conditionIndex + 1 : ''} · Slot {slot?.slotIndex ?? ''}
          </span>
          <h2 className="mg-panel__title">{slot?.label ?? '—'}</h2>
          {slot?.price !== null && slot?.price !== undefined && (
            <span className="mg-panel__mono" style={{ color: '#14b8a6' }}>
              {slot.price.toFixed(4)}
            </span>
          )}
        </div>

        <div className="mg-panel__body">
          <button
            className="mg-panel__action"
            style={{ marginBottom: '1.5rem' }}
            onClick={handleTrade}
            disabled={!wallets[0]}
          >
            {!wallets[0] ? 'Connect wallet' : `Trade ${slot?.label ?? 'outcome'}`}
          </button>

          {/* Split / Merge for source market */}
          <div className="mg-dir-toggle">
            <button
              className={`mg-dir-toggle__btn${tab === 'split' ? ' mg-dir-toggle__btn--active' : ''}`}
              onClick={() => setTab('split')}
            >
              Split
            </button>
            <button
              className={`mg-dir-toggle__btn${tab === 'merge' ? ' mg-dir-toggle__btn--active' : ''}`}
              onClick={() => setTab('merge')}
            >
              Merge
            </button>
          </div>

          <p style={{ fontSize: '0.72rem', color: 'rgba(245,245,240,0.45)', margin: '0.35rem 0 0.5rem', lineHeight: 1.45 }}>
            {tab === 'split'
              ? 'Splits collateral into all outcome tokens for this source market.'
              : 'Merges all outcome tokens (one of each) back into collateral.'}
          </p>

          <div className="mg-field">
            <label className="mg-field__label">
              {tab === 'split' ? 'Collateral to split' : 'Outcome amount (each)'}
            </label>
            <input
              className="mg-field__input"
              type="number"
              min="0"
              step="any"
              placeholder="0.00"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              disabled={txPending}
            />
          </div>

          <button
            className="mg-panel__action"
            onClick={tab === 'split' ? handleSplit : handleMerge}
            disabled={!amount || !wallets[0] || txPending}
          >
            {txPending ? 'Pending…' : !wallets[0] ? 'Connect wallet' : tab === 'split' ? 'Split to outcomes' : 'Merge to collateral'}
          </button>

          {txError && <p className="mg-panel__error">{txError}</p>}
        </div>
      </div>
    </>
  );
}
