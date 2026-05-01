'use client';

import { useState, useEffect, useCallback } from 'react';
import { useWallets } from '@privy-io/react-auth';
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  formatUnits,
  parseUnits,
} from 'viem';
import { getChain } from '@/lib/chain';
import { FPMM_ABI, ERC20_ABI, LMSR_HOOK_ADDRESS, COLLATERAL_TOKEN, lpTokenIdLocal } from '@/lib/contracts';

interface ConditionInfo {
  id: string;
  slots: number;
}

interface ConditionPanelProps {
  condition: ConditionInfo | null;
  osIndex: string;
  slug: string;
  ptokenAddress: string;
  onClose: () => void;
  onTxSuccess?: () => void;
}

type PanelTab = 'add' | 'remove' | 'split' | 'merge';

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).catch(() => {});
}

export function ConditionPanel({ condition, osIndex, slug, ptokenAddress, onClose, onTxSuccess }: ConditionPanelProps) {
  const isOpen = condition !== null;
  // POOL_SENTINEL: id === '' means pool-management mode (opened from root node)
  const isPoolMode = isOpen && condition!.id === '';
  const [tab, setTab] = useState<PanelTab>('add');
  const [amount, setAmount] = useState('');
  const [feesWithdrawable, setFeesWithdrawable] = useState<bigint | null>(null);
  // userLpBalance must be divided by total outcomes
  const [userLpBalance, setUserLpBalance] = useState<bigint | null>(null);
  const [lpTotalSupply, setLpTotalSupply] = useState<bigint | null>(null);
  const [collateralBal, setCollateralBal] = useState<bigint | null>(null);
  const [loadingBal, setLoadingBal] = useState(false);
  const [txPending, setTxPending] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);
  const { wallets } = useWallets();

  const publicClient = createPublicClient({ chain: getChain(), transport: http() });

  const fetchStats = useCallback(async () => {
    if (!osIndex) return;
    setLoadingBal(true);
    try {
      const wallet = wallets[0];
      let account: `0x${string}` | undefined;
      if (wallet) {
        const provider = await wallet.getEthereumProvider();
        [account] = await createWalletClient({ chain: getChain(), transport: custom(provider) }).getAddresses();
      }

      const lpId = lpTokenIdLocal(osIndex as `0x${string}`);

      const [osInfo, fees, lpBal, collBal] = await Promise.all([
        publicClient.readContract({
          address: LMSR_HOOK_ADDRESS,
          abi: FPMM_ABI,
          functionName: 'getOSInfo',
          args: [osIndex as `0x${string}`],
        }).catch(() => null),
        account
          ? publicClient.readContract({
              address: LMSR_HOOK_ADDRESS,
              abi: FPMM_ABI,
              functionName: 'feesWithdrawableBy',
              args: [osIndex as `0x${string}`, account],
            }).catch(() => null)
          : Promise.resolve(null),
        account
          ? publicClient.readContract({
              address: LMSR_HOOK_ADDRESS,
              abi: FPMM_ABI,
              functionName: 'balanceOf',
              args: [account, lpId],
            }).catch(() => null)
          : Promise.resolve(null),
        account
          ? publicClient.readContract({
              address: COLLATERAL_TOKEN,
              abi: ERC20_ABI,
              functionName: 'balanceOf',
              args: [account],
            }).catch(() => null)
          : Promise.resolve(null),
      ]);

      if (osInfo) {
        const info = osInfo as [string, string[], bigint[], bigint];
        setLpTotalSupply(info[3]);
      }
      if (fees !== null) setFeesWithdrawable(fees as bigint);
      if (lpBal !== null) setUserLpBalance(lpBal as bigint);
      if (collBal !== null) setCollateralBal(collBal as bigint);
    } catch {
      setLpTotalSupply(null);
    } finally {
      setLoadingBal(false);
    }
  }, [osIndex, wallets]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isOpen) {
      setTxError(null);
      fetchStats();
    }
  }, [isOpen, fetchStats]);

  async function getWalletClient() {
    const wallet = wallets[0];
    if (!wallet) throw new Error('No wallet connected');
    const provider = await wallet.getEthereumProvider();
    const client = createWalletClient({ chain: getChain(), transport: custom(provider) });
    const [account] = await client.getAddresses();
    return { client, account };
  }

  async function handleAddLiquidity() {
    if (!amount) return;
    setTxPending(true);
    setTxError(null);
    try {
      const { client, account } = await getWalletClient();
      const amountWad = parseUnits(amount, 18);

      // addLiquidity calls transferFrom(user, pm, amount) with msg.sender=hook,
      // so the user must approve the hook (not the pool manager).
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

      // Explicit gas skips eth_estimateGas, which fails on Unichain Sepolia for v4 hook callbacks.
      const liqTx = await client.writeContract({
        address: LMSR_HOOK_ADDRESS,
        abi: FPMM_ABI,
        functionName: 'addLiquidity',
        args: [osIndex as `0x${string}`, amountWad],
        account,
        chain: getChain(),
        gas: 2_000_000n,
      });
      await publicClient.waitForTransactionReceipt({ hash: liqTx });

      if (slug) {
        fetch(`/api/markets/${slug}/record-activity`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ txHash: liqTx, userAddress: account, direction: 'add_liquidity', amountUsdc: amount }),
        }).catch(() => {});
      }
      setAmount('');
      await fetchStats();
      onTxSuccess?.();
    } catch (e: unknown) {
      setTxError(e instanceof Error ? e.message : String(e));
    } finally {
      setTxPending(false);
    }
  }

  async function handleRemoveLiquidity() {
    if (!amount) return;
    setTxPending(true);
    setTxError(null);
    try {
      const { client, account } = await getWalletClient();
      const lpAmt = parseUnits(amount, 18);

      const tx = await client.writeContract({
        address: LMSR_HOOK_ADDRESS,
        abi: FPMM_ABI,
        functionName: 'removeLiquidity',
        args: [osIndex as `0x${string}`, lpAmt],
        account,
        chain: getChain(),
        gas: 2_000_000n,
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });

      if (slug) {
        fetch(`/api/markets/${slug}/record-activity`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ txHash: tx, userAddress: account, direction: 'remove_liquidity', amountUsdc: amount }),
        }).catch(() => {});
      }
      setAmount('');
      await fetchStats();
      onTxSuccess?.();
    } catch (e: unknown) {
      setTxError(e instanceof Error ? e.message : String(e));
    } finally {
      setTxPending(false);
    }
  }

  async function handleWithdrawFees() {
    setTxPending(true);
    setTxError(null);
    try {
      const { client, account } = await getWalletClient();
      const tx = await client.writeContract({
        address: LMSR_HOOK_ADDRESS,
        abi: FPMM_ABI,
        functionName: 'withdrawFees',
        args: [osIndex as `0x${string}`],
        account,
        chain: getChain(),
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });

      if (slug) {
        const feesAmt = feesWithdrawable != null ? formatUnits(feesWithdrawable, 18) : '0';
        fetch(`/api/markets/${slug}/record-activity`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ txHash: tx, userAddress: account, direction: 'withdraw_fees', amountUsdc: feesAmt }),
        }).catch(() => {});
      }
      await fetchStats();
      onTxSuccess?.();
    } catch (e: unknown) {
      setTxError(e instanceof Error ? e.message : String(e));
    } finally {
      setTxPending(false);
    }
  }

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
        args: [osIndex as `0x${string}`, amountWad],
        account,
        chain: getChain(),
        gas: 2_000_000n,
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });

      if (slug) {
        fetch(`/api/markets/${slug}/record-activity`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ txHash: tx, userAddress: account, direction: 'split_collateral', amountUsdc: amount }),
        }).catch(() => {});
      }
      setAmount('');
      await fetchStats();
      onTxSuccess?.();
    } catch (e: unknown) {
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
        args: [osIndex as `0x${string}`, amountWad],
        account,
        chain: getChain(),
        gas: 2_000_000n,
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });

      if (slug) {
        fetch(`/api/markets/${slug}/record-activity`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ txHash: tx, userAddress: account, direction: 'merge_collateral', amountUsdc: amount }),
        }).catch(() => {});
      }
      setAmount('');
      await fetchStats();
      onTxSuccess?.();
    } catch (e: unknown) {
      setTxError(e instanceof Error ? e.message : String(e));
    } finally {
      setTxPending(false);
    }
  }

  const handleLiquidity =
    tab === 'add' ? handleAddLiquidity :
    tab === 'remove' ? handleRemoveLiquidity :
    tab === 'split' ? handleSplit :
    handleMerge;

  return (
    <>
      {isOpen && <div className="mg-backdrop" onClick={onClose} />}
      <div className={`mg-panel${isOpen ? ' mg-panel--open' : ''}`}>
        <button className="mg-panel__close" onClick={onClose} aria-label="Close">✕</button>

        <div className="mg-panel__header">
          <span className="mg-panel__tag">{isPoolMode ? 'Pool' : 'Condition'}</span>
          <h2 className="mg-panel__title">{isPoolMode ? 'Pool Management' : 'Liquidity & Fees'}</h2>
          {condition && !isPoolMode && (
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
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.25rem' }}>
            <div className="mg-stat" style={{ flex: 1 }}>
              <span className="mg-stat__label">Total pool liquidity</span>
              <span className="mg-stat__value">
                {loadingBal ? '…' : lpTotalSupply !== null ? parseFloat(formatUnits(lpTotalSupply, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 }) : '—'}
              </span>
            </div>
            {condition && !isPoolMode && (
              <div className="mg-stat" style={{ flex: 1 }}>
                <span className="mg-stat__label">Outcome slots</span>
                <span className="mg-stat__value">{condition.slots}</span>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.25rem' }}>
            <div className="mg-stat" style={{ flex: 1 }}>
              <span className="mg-stat__label">Your LP balance</span>
              <span className="mg-stat__value">
                {loadingBal
                  ? '…'
                  : userLpBalance !== null
                    ? parseFloat(formatUnits(userLpBalance, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 })
                    : '—'}
              </span>
            </div>
            <div className="mg-stat" style={{ flex: 1 }}>
              <span className="mg-stat__label">Total LP supply</span>
              <span className="mg-stat__value">
                {loadingBal
                  ? '…'
                  : lpTotalSupply !== null
                    ? parseFloat(formatUnits(lpTotalSupply, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 })
                    : '—'}
              </span>
            </div>
          </div>

          <div className="mg-dir-toggle" style={{ marginTop: '1.5rem' }}>
            <button
              className={`mg-dir-toggle__btn${tab === 'add' ? ' mg-dir-toggle__btn--active' : ''}`}
              onClick={() => setTab('add')}
            >
              Add liq.
            </button>
            <button
              className={`mg-dir-toggle__btn${tab === 'remove' ? ' mg-dir-toggle__btn--active' : ''}`}
              onClick={() => setTab('remove')}
            >
              Remove liq.
            </button>
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

          {(tab === 'split' || tab === 'merge') && !isPoolMode && (
            <p style={{ fontSize: '0.75rem', color: 'rgba(245,245,240,0.5)', margin: '0.25rem 0 0.5rem' }}>
              {tab === 'split'
                ? `Split collateral → 1 of each outcome token (${condition?.slots ?? '?'} tokens per unit)`
                : `Merge ${condition?.slots ?? '?'} outcome tokens (one of each) → 1 collateral`}
            </p>
          )}

          <div className="mg-field">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.25rem' }}>
              <label className="mg-field__label" style={{ margin: 0 }}>
                {tab === 'add' ? 'Collateral amount' :
                 tab === 'remove' ? 'LP tokens to redeem' :
                 tab === 'split' ? 'Collateral to split' :
                 'Outcome amount (each)'}
              </label>
              {tab === 'remove' && userLpBalance !== null && userLpBalance > 0n && (
                <button
                  style={{ fontSize: '0.7rem', color: '#14b8a6', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                  onClick={() => setAmount(parseFloat(formatUnits(userLpBalance, 18)).toFixed(6).replace(/\.?0+$/, ''))}
                  disabled={txPending}
                >
                  Max {parseFloat(formatUnits(userLpBalance, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 })}
                </button>
              )}
              {tab === 'split' && collateralBal !== null && collateralBal > 0n && (
                <button
                  style={{ fontSize: '0.7rem', color: '#14b8a6', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                  onClick={() => setAmount(parseFloat(formatUnits(collateralBal, 18)).toFixed(6).replace(/\.?0+$/, ''))}
                  disabled={txPending}
                >
                  Max {parseFloat(formatUnits(collateralBal, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 })}
                </button>
              )}
            </div>
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
            onClick={handleLiquidity}
            disabled={!amount || !wallets[0] || txPending}
          >
            {txPending
              ? 'Pending…'
              : !wallets[0]
                ? 'Connect wallet'
                : tab === 'add' ? 'Add liquidity'
                : tab === 'remove' ? 'Remove liquidity'
                : tab === 'split' ? 'Split to outcomes'
                : 'Merge to collateral'}
          </button>

          <div className="chain-guard">
            if the market is closed you need to redeem your fees <b>before</b> your funds. Otherwise <b>will be lost</b>
          </div>
          <div className="mg-stat" style={{ marginTop: '1.5rem' }}>
            <span className="mg-stat__label">Accrued fees</span>
            <span className="mg-stat__value">
              {loadingBal
                ? '…'
                : feesWithdrawable !== null
                  ? formatUnits(feesWithdrawable, 18)
                  : '—'}
            </span>
          </div>

          {feesWithdrawable !== null && feesWithdrawable > 0n && (
            <button
              className="mg-panel__action"
              onClick={handleWithdrawFees}
              disabled={!wallets[0] || txPending}
              style={{ marginTop: '0.5rem' }}
            >
              {txPending ? 'Pending…' : 'Withdraw fees'}
            </button>
          )}

          {txError && (
            <p className="mg-panel__error">{txError}</p>
          )}
        </div>
      </div>
    </>
  );
}
