'use client';

import { useState, useEffect, useCallback } from 'react';
import { useWallets } from '@privy-io/react-auth';
import { createPublicClient, http, formatUnits } from 'viem';
import { getChain } from '@/lib/chain';
import { LMSR_ABI, LMSR_HOOK_ADDRESS } from '@/lib/contracts';

interface Outcome {
  outcomeIndex: number;
  label: string | null;
  tokenAddress: string;
  positionId: string | null;
}

interface SwapPanelProps {
  outcome: Outcome | null;
  osIndex: string;
  lmsrB: string | null;
  onClose: () => void;
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function SwapPanel({ outcome, osIndex, lmsrB: _lmsrB, onClose }: SwapPanelProps) {
  const isOpen = outcome !== null;
  const [direction, setDirection] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('');
  const [poolBal, setPoolBal] = useState<bigint | null>(null);
  const [loadingBal, setLoadingBal] = useState(false);
  const { wallets } = useWallets();

  const fetchBalance = useCallback(async () => {
    if (!outcome || !osIndex) return;
    setLoadingBal(true);
    try {
      const client = createPublicClient({ chain: getChain(), transport: http() });
      const [, bals] = await client.readContract({
        address: LMSR_HOOK_ADDRESS,
        abi: LMSR_ABI,
        functionName: 'getPoolBalances',
        args: [osIndex as `0x${string}`],
      }) as [bigint[], bigint[]];
      setPoolBal(bals[outcome.outcomeIndex] ?? null);
    } catch {
      setPoolBal(null);
    } finally {
      setLoadingBal(false);
    }
  }, [outcome, osIndex]);

  useEffect(() => {
    if (isOpen) fetchBalance();
  }, [isOpen, fetchBalance]);

  async function handleExecute() {
    if (!wallets[0]) return;
    // Swap ABI not yet available — stub
    console.log('[SwapPanel] execute swap', {
      direction,
      amount,
      outcome: outcome?.outcomeIndex,
      osIndex,
    });
    alert('Swap contract not yet wired up. Coming soon.');
  }

  return (
    <>
      {isOpen && <div className="mg-backdrop" onClick={onClose} />}
      <div className={`mg-panel${isOpen ? ' mg-panel--open' : ''}`}>
        <button className="mg-panel__close" onClick={onClose} aria-label="Close">✕</button>

        <div className="mg-panel__header">
          <span className="mg-panel__tag">Outcome</span>
          <h2 className="mg-panel__title">
            {outcome?.label ?? `Outcome ${outcome?.outcomeIndex}`}
          </h2>
          {outcome && (
            <span className="mg-panel__mono">{shortAddr(outcome.tokenAddress)}</span>
          )}
        </div>

        <div className="mg-panel__body">
          <div className="mg-dir-toggle">
            <button
              className={`mg-dir-toggle__btn${direction === 'buy' ? ' mg-dir-toggle__btn--active' : ''}`}
              onClick={() => setDirection('buy')}
            >
              Buy
            </button>
            <button
              className={`mg-dir-toggle__btn${direction === 'sell' ? ' mg-dir-toggle__btn--active' : ''}`}
              onClick={() => setDirection('sell')}
            >
              Sell
            </button>
          </div>

          <div className="mg-field">
            <label className="mg-field__label">
              {direction === 'buy' ? 'Collateral in' : 'Shares in'}
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
            <span className="mg-stat__label">Pool balance</span>
            <span className="mg-stat__value">
              {loadingBal
                ? '…'
                : poolBal !== null
                  ? formatUnits(poolBal, 18)
                  : '—'}
            </span>
          </div>

          {outcome?.positionId && (
            <div className="mg-stat">
              <span className="mg-stat__label">Position ID</span>
              <span className="mg-stat__value mg-stat__value--mono">{shortAddr(outcome.positionId)}</span>
            </div>
          )}

          <button
            className="mg-panel__action"
            onClick={handleExecute}
            disabled={!amount || !wallets[0]}
          >
            {!wallets[0] ? 'Connect wallet' : `${direction === 'buy' ? 'Buy' : 'Sell'} shares`}
          </button>
        </div>
      </div>
    </>
  );
}
