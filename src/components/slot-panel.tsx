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
  combinedOutcomes: Array<{
    outcome: Outcome;
    combinedLabel: string;
    price: number | null;
  }>;
}

interface SlotPanelProps {
  slot: SlotInfo | null;
  osIndex: string;
  onClose: () => void;
  onTradeOutcome: (o: Outcome) => void;
  onTxSuccess?: () => void;
}

type Tab = 'split' | 'merge';

export function SlotPanel({ slot, osIndex, onClose, onTradeOutcome, onTxSuccess }: SlotPanelProps) {
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
        functionName: 'splitPosition',
        args: [osIndex as `0x${string}`, amountWad],
        account,
        chain: getChain(),
        gas: 2_000_000n,
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
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
        functionName: 'mergePositions',
        args: [osIndex as `0x${string}`, amountWad],
        account,
        chain: getChain(),
        gas: 2_000_000n,
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      setAmount('');
      onTxSuccess?.();
    } catch (e) {
      setTxError(e instanceof Error ? e.message : String(e));
    } finally {
      setTxPending(false);
    }
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
              {slot.price.toFixed(4)} marginal
            </span>
          )}
        </div>

        <div className="mg-panel__body">
          {/* Combined outcomes for this slot */}
          <p className="mg-slot__section-label">Combined outcomes</p>
          <div className="mg-slot__outcomes">
            {slot?.combinedOutcomes.map(({ outcome, combinedLabel, price }) => (
              <div key={outcome.outcomeIndex} className="mg-slot__row">
                <div className="mg-slot__row-info">
                  <span className="mg-slot__row-label">{combinedLabel}</span>
                  {price !== null && (
                    <span className="mg-slot__row-price">{price.toFixed(4)}</span>
                  )}
                </div>
                <button
                  className="mg-slot__trade-btn"
                  onClick={() => { onTradeOutcome(outcome); }}
                >
                  Trade
                </button>
              </div>
            ))}
          </div>

          {/* Split / Merge */}
          <div className="mg-dir-toggle" style={{ marginTop: '1.5rem' }}>
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
              ? `Splits collateral into all ${slot?.combinedOutcomes.length ?? '?'} combined outcome tokens for this market.`
              : `Merges all combined outcome tokens (one of each) back into collateral.`}
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
