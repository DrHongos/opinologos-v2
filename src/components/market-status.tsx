'use client';

import { useState, useEffect, useCallback } from 'react';
import { useWallets } from '@privy-io/react-auth';
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  formatUnits,
} from 'viem';
import { getChain } from '@/lib/chain';
import { FPMM_ABI, LMSR_HOOK_ADDRESS, outcomeTokenIdLocal } from '@/lib/contracts';

interface Outcome {
  outcomeIndex: number;
  label: string | null;
}

interface ConditionInfo {
  id: string;
  slots: number;
}

interface MarketStatusProps {
  osIndex: string;
  conditions: ConditionInfo[];
  outcomes: Outcome[];
}

interface PayoutInfo {
  numerator: bigint;
  denominator: bigint;
}

interface OutcomeState {
  outcomeIndex: number;
  label: string | null;
  userBalance: bigint;
  payout: PayoutInfo | null;
}

function formatTokens(v: bigint) {
  const n = parseFloat(formatUnits(v, 18));
  if (n === 0) return '0';
  if (n < 0.001) return '<0.001';
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function MarketStatus({ osIndex, conditions, outcomes }: MarketStatusProps) {
  const { wallets } = useWallets();
  const [resolved, setResolved] = useState<boolean | null>(null);
  const [outcomeStates, setOutcomeStates] = useState<OutcomeState[]>([]);
  const [txPending, setTxPending] = useState(false);
  const [txStatus, setTxStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  const publicClient = createPublicClient({ chain: getChain(), transport: http() });

  const load = useCallback(async () => {
    const wallet = wallets[0];
    let account: `0x${string}` | undefined;
    if (wallet) {
      const provider = await wallet.getEthereumProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [account] = await createWalletClient({ chain: getChain(), transport: custom(provider as any) }).getAddresses();
    }

    const isRes = await publicClient.readContract({
      address: LMSR_HOOK_ADDRESS,
      abi: FPMM_ABI,
      functionName: 'isResolved',
      args: [osIndex as `0x${string}`],
    }).catch(() => false) as boolean;

    setResolved(isRes);
    if (!isRes) return;

    // Build payout info per condition slot (for simple markets, 1 condition)
    // payoutNumerators[conditionId][slotIndex]  payoutDenominator[conditionId]
    const condPayouts = new Map<string, { numerators: bigint[]; denominator: bigint }>();
    for (const cond of conditions) {
      const den = await publicClient.readContract({
        address: LMSR_HOOK_ADDRESS,
        abi: FPMM_ABI,
        functionName: 'payoutDenominator',
        args: [cond.id as `0x${string}`],
      }).catch(() => 0n) as bigint;

      const nums: bigint[] = [];
      for (let i = 0; i < cond.slots; i++) {
        const n = await publicClient.readContract({
          address: LMSR_HOOK_ADDRESS,
          abi: FPMM_ABI,
          functionName: 'payoutNumerators',
          args: [cond.id as `0x${string}`, BigInt(i)],
        }).catch(() => 0n) as bigint;
        nums.push(n);
      }
      condPayouts.set(cond.id, { numerators: nums, denominator: den });
    }

    // For each outcome, get user balance and compute payout fraction
    const states: OutcomeState[] = await Promise.all(
      outcomes.map(async (o) => {
        const tokenId = outcomeTokenIdLocal(osIndex as `0x${string}`, o.outcomeIndex);
        const userBalance = account
          ? await publicClient.readContract({
              address: LMSR_HOOK_ADDRESS,
              abi: FPMM_ABI,
              functionName: 'balanceOf',
              args: [account, tokenId],
            }).catch(() => 0n) as bigint
          : 0n;

        // For simple 1-condition markets: outcomeIndex = slot index
        let payout: PayoutInfo | null = null;
        if (conditions.length === 1) {
          const cp = condPayouts.get(conditions[0].id);
          if (cp && cp.denominator > 0n && o.outcomeIndex < cp.numerators.length) {
            payout = { numerator: cp.numerators[o.outcomeIndex], denominator: cp.denominator };
          }
        }

        return { outcomeIndex: o.outcomeIndex, label: o.label, userBalance, payout };
      })
    );

    setOutcomeStates(states);
  }, [osIndex, conditions, outcomes, wallets]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  async function handleRedeem() {
    const wallet = wallets[0];
    if (!wallet) return;
    setTxPending(true);
    setTxStatus(null);
    try {
      const provider = await wallet.getEthereumProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wc = createWalletClient({ account: wallet.address as `0x${string}`, chain: getChain(), transport: custom(provider as any) });
      const hash = await wc.writeContract({
        address: LMSR_HOOK_ADDRESS,
        abi: FPMM_ABI,
        functionName: 'redeem',
        args: [osIndex as `0x${string}`],
        gas: 1_000_000n,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setTxStatus({ ok: true, msg: `Redeemed. tx: ${hash.slice(0, 10)}…` });
      await load();
    } catch (e) {
      setTxStatus({ ok: false, msg: e instanceof Error ? e.message : 'Transaction failed' });
    } finally {
      setTxPending(false);
    }
  }

  if (resolved === null) return null; // still loading

  if (!resolved) {
    return (
      <div className="mkt-status mkt-status--open">
        <span className="mkt-status__dot" />
        <span className="mkt-status__label">Live · Trading open</span>
      </div>
    );
  }

  const hasBalance = outcomeStates.some(s => s.userBalance > 0n);

  // Find winning outcomes (numerator > 0) for simple markets
  const winnerIdxs = outcomeStates
    .filter(s => s.payout && s.payout.numerator > 0n)
    .map(s => s.outcomeIndex);

  return (
    <div className="mkt-resolved">
      <div className="mkt-resolved__banner">
        <span className="mkt-resolved__icon">✓</span>
        <div>
          <span className="mkt-resolved__title">Market Resolved</span>
          {winnerIdxs.length > 0 && conditions.length === 1 && (
            <span className="mkt-resolved__winner">
              {winnerIdxs.map(i => {
                const o = outcomeStates.find(s => s.outcomeIndex === i);
                return o?.label ?? `Outcome ${i}`;
              }).join(' / ')}
            </span>
          )}
        </div>
      </div>

      {outcomeStates.length > 0 && (
        <div className="mkt-resolved__outcomes">
          {outcomeStates.map(s => {
            const isWinner = s.payout && s.payout.numerator > 0n;
            const payoutFrac = s.payout && s.payout.denominator > 0n
              ? Number(s.payout.numerator) / Number(s.payout.denominator)
              : null;
            return (
              <div
                key={s.outcomeIndex}
                className={`mkt-resolved__row${isWinner ? ' mkt-resolved__row--winner' : ''}`}
              >
                <div className="mkt-resolved__outcome-info">
                  <span className="mkt-resolved__outcome-label">
                    {isWinner && <span className="mkt-resolved__check">✓</span>}
                    {s.label ?? `Outcome ${s.outcomeIndex}`}
                  </span>
                  {payoutFrac !== null && (
                    <span className="mkt-resolved__pct">
                      {(payoutFrac * 100).toFixed(0)}%
                    </span>
                  )}
                </div>
                {s.userBalance > 0n && (
                  <span className="mkt-resolved__holding">
                    {formatTokens(s.userBalance)} tokens
                    {payoutFrac !== null && payoutFrac > 0 && (
                      <span className="mkt-resolved__est">
                        {' '}≈ {formatTokens(s.userBalance * s.payout!.numerator / s.payout!.denominator)} collateral
                      </span>
                    )}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {hasBalance && (
        <div className="mkt-resolved__redeem">
          <button
            className="mkt-resolved__redeem-btn"
            onClick={handleRedeem}
            disabled={txPending || !wallets[0]}
          >
            {txPending ? 'Redeeming…' : 'Redeem Winnings'}
          </button>
          {txStatus && (
            <span className={`mkt-resolved__tx ${txStatus.ok ? 'mkt-resolved__tx--ok' : 'mkt-resolved__tx--err'}`}>
              {txStatus.msg}
            </span>
          )}
        </div>
      )}

      {!hasBalance && !txStatus && (
        <p className="mkt-resolved__no-tokens">
          {wallets[0] ? 'No redeemable positions in this wallet.' : 'Connect wallet to check your positions.'}
        </p>
      )}

      {txStatus?.ok && (
        <div className="mkt-resolved__tx-ok">{txStatus.msg}</div>
      )}
    </div>
  );
}
