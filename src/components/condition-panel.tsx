'use client';

import { useState, useEffect, useCallback } from 'react';
import { useWallets } from '@privy-io/react-auth';
import { createPublicClient, http, formatUnits } from 'viem';
import { getChain } from '@/lib/chain';
import { LMSR_ABI, LMSR_HOOK_ADDRESS } from '@/lib/contracts';

interface ConditionInfo {
  id: string;
  slots: number;
}

interface ConditionPanelProps {
  condition: ConditionInfo | null;
  osIndex: string;
  onClose: () => void;
}

type LiquidityTab = 'add' | 'remove';

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).catch(() => {});
}

export function ConditionPanel({ condition, osIndex, onClose }: ConditionPanelProps) {
  const isOpen = condition !== null;
  const [tab, setTab] = useState<LiquidityTab>('add');
  const [amount, setAmount] = useState('');
  const [totalLiquidity, setTotalLiquidity] = useState<bigint | null>(null);
  const [loadingBal, setLoadingBal] = useState(false);
  const { wallets } = useWallets();

  const fetchLiquidity = useCallback(async () => {
    if (!osIndex) return;
    setLoadingBal(true);
    try {
      const client = createPublicClient({ chain: getChain(), transport: http() });
      const [, bals] = await client.readContract({
        address: LMSR_HOOK_ADDRESS,
        abi: LMSR_ABI,
        functionName: 'getPoolBalances',
        args: [osIndex as `0x${string}`],
      }) as [bigint[], bigint[]];
      const total = (bals as bigint[]).reduce((a, b) => a + b, 0n);
      setTotalLiquidity(total);
    } catch {
      setTotalLiquidity(null);
    } finally {
      setLoadingBal(false);
    }
  }, [osIndex]);

  useEffect(() => {
    if (isOpen) fetchLiquidity();
  }, [isOpen, fetchLiquidity]);

  async function handleLiquidity() {
    if (!wallets[0]) return;
    // Liquidity ABI not yet available — stub
    console.log('[ConditionPanel] liquidity action', { tab, amount, condition: condition?.id, osIndex });
    alert('Liquidity management not yet wired up. Coming soon.');
  }

  return (
    <>
      {isOpen && <div className="mg-backdrop" onClick={onClose} />}
      <div className={`mg-panel${isOpen ? ' mg-panel--open' : ''}`}>
        <button className="mg-panel__close" onClick={onClose} aria-label="Close">✕</button>

        <div className="mg-panel__header">
          <span className="mg-panel__tag">Condition</span>
          <h2 className="mg-panel__title">Liquidity &amp; Fees</h2>
          {condition && (
            <button
              className="mg-panel__mono mg-panel__mono--copy"
              onClick={() => copyToClipboard(condition.id)}
              title="Copy condition ID"
            >
              {shortAddr(condition.id)} ⎘
            </button>
          )}
        </div>

        <div className="mg-panel__body">
          <div className="mg-stat">
            <span className="mg-stat__label">Total pool liquidity</span>
            <span className="mg-stat__value">
              {loadingBal
                ? '…'
                : totalLiquidity !== null
                  ? formatUnits(totalLiquidity, 18)
                  : '—'}
            </span>
          </div>

          {condition && (
            <div className="mg-stat">
              <span className="mg-stat__label">Outcome slots</span>
              <span className="mg-stat__value">{condition.slots}</span>
            </div>
          )}

          <div className="mg-dir-toggle" style={{ marginTop: '1.5rem' }}>
            <button
              className={`mg-dir-toggle__btn${tab === 'add' ? ' mg-dir-toggle__btn--active' : ''}`}
              onClick={() => setTab('add')}
            >
              Add liquidity
            </button>
            <button
              className={`mg-dir-toggle__btn${tab === 'remove' ? ' mg-dir-toggle__btn--active' : ''}`}
              onClick={() => setTab('remove')}
            >
              Remove
            </button>
          </div>

          <div className="mg-field">
            <label className="mg-field__label">
              {tab === 'add' ? 'Collateral amount' : 'Shares to redeem'}
            </label>
            <input
              className="mg-field__input"
              type="number"
              min="0"
              step="any"
              placeholder="0.00"
              value={amount}
              onChange={e => setAmount(e.target.value)}
            />
          </div>

          <div className="mg-stat">
            <span className="mg-stat__label">Accrued fees</span>
            <span className="mg-stat__value">— (coming soon)</span>
          </div>

          <button
            className="mg-panel__action"
            onClick={handleLiquidity}
            disabled={!amount || !wallets[0]}
          >
            {!wallets[0] ? 'Connect wallet' : tab === 'add' ? 'Add liquidity' : 'Remove liquidity'}
          </button>
        </div>
      </div>
    </>
  );
}
