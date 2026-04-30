'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useWallets } from '@privy-io/react-auth';
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  formatUnits,
  parseUnits,
  encodeAbiParameters,
  encodePacked,
} from 'viem';
import { getChain } from '@/lib/chain';
import {
  FPMM_ABI,
  ERC20_ABI,
  UNIVERSAL_ROUTER_ABI,
  PERMIT2_ABI,
  PERMIT2_ADDRESS,
  LMSR_HOOK_ADDRESS,
  COLLATERAL_TOKEN,
  UNIVERSAL_ROUTER,
  outcomeTokenIdLocal,
  computeImpliedPrice,
} from '@/lib/contracts';

interface Outcome {
  outcomeIndex: number;
  label: string | null;
  tokenAddress: string | null;
  positionId: string | null;
}

interface SwapPanelProps {
  outcome: Outcome | null;
  osIndex: string;
  slug: string;
  onClose: () => void;
  onTxSuccess?: () => void;
}

// Universal Router command / action byte constants (from @uniswap/universal-router-sdk and @uniswap/v4-sdk)
const V4_SWAP_COMMAND = 0x10;           // CommandType.V4_SWAP
const SWAP_EXACT_IN_SINGLE  = 0x06;    // Actions.SWAP_EXACT_IN_SINGLE
const SWAP_EXACT_OUT_SINGLE = 0x08;    // Actions.SWAP_EXACT_OUT_SINGLE
const SETTLE_ALL_ACTION = 0x0c;        // Actions.SETTLE_ALL
const TAKE_ALL_ACTION   = 0x0f;        // Actions.TAKE_ALL

const MAX_UINT128 = (2n ** 128n) - 1n;

function buildPoolKey(feeSlot: number) {
  const collIsC0 = BigInt(COLLATERAL_TOKEN) < BigInt(LMSR_HOOK_ADDRESS);
  return {
    poolKey: {
      currency0: (collIsC0 ? COLLATERAL_TOKEN : LMSR_HOOK_ADDRESS) as `0x${string}`,
      currency1: (collIsC0 ? LMSR_HOOK_ADDRESS : COLLATERAL_TOKEN) as `0x${string}`,
      fee:         feeSlot,
      tickSpacing: 60,
      hooks:       LMSR_HOOK_ADDRESS,
    },
    collIsC0,
  };
}

const POOL_KEY_COMPONENTS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee',         type: 'uint24'  },
  { name: 'tickSpacing', type: 'int24'   },
  { name: 'hooks',       type: 'address' },
] as const;

type PoolKey = ReturnType<typeof buildPoolKey>['poolKey'];

function encodeExactInSingle(poolKey: PoolKey, collIsC0: boolean, amountIn: bigint, hookData: `0x${string}`): `0x${string}` {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return encodeAbiParameters([{ type: 'tuple', components: [
    { type: 'tuple', name: 'poolKey', components: POOL_KEY_COMPONENTS },
    { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' },
    { name: 'amountOutMinimum', type: 'uint128' }, { name: 'hookData', type: 'bytes' },
  ] }] as any, [{ poolKey, zeroForOne: collIsC0, amountIn, amountOutMinimum: 0n, hookData }]);
}

function encodeExactOutSingle(poolKey: PoolKey, collIsC0: boolean, amountOut: bigint, hookData: `0x${string}`): `0x${string}` {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return encodeAbiParameters([{ type: 'tuple', components: [
    { type: 'tuple', name: 'poolKey', components: POOL_KEY_COMPONENTS },
    { name: 'zeroForOne', type: 'bool' }, { name: 'amountOut', type: 'uint128' },
    { name: 'amountInMaximum', type: 'uint128' }, { name: 'hookData', type: 'bytes' },
  ] }] as any, [{ poolKey, zeroForOne: !collIsC0, amountOut, amountInMaximum: MAX_UINT128, hookData }]);
}

function encodeSettleAll(currency: `0x${string}`, maxAmount: bigint): `0x${string}` {
  return encodeAbiParameters(
    [{ name: 'currency', type: 'address' }, { name: 'maxAmount', type: 'uint256' }] as const,
    [currency, maxAmount],
  );
}

function encodeTakeAll(currency: `0x${string}`, minAmount: bigint): `0x${string}` {
  return encodeAbiParameters(
    [{ name: 'currency', type: 'address' }, { name: 'minAmount', type: 'uint256' }] as const,
    [currency, minAmount],
  );
}

function buildV4SwapCalldata(
  actionByte: number,
  swapInput: `0x${string}`,
  settleInput: `0x${string}`,
  takeInput: `0x${string}`,
): { commands: `0x${string}`; inputs: `0x${string}`[] } {
  const actions = encodePacked(
    ['uint8', 'uint8', 'uint8'],
    [actionByte, SETTLE_ALL_ACTION, TAKE_ALL_ACTION],
  );
  const v4Input = encodeAbiParameters(
    [{ name: 'actions', type: 'bytes' }, { name: 'params', type: 'bytes[]' }] as const,
    [actions, [swapInput, settleInput, takeInput]],
  );
  return {
    commands: encodePacked(['uint8'], [V4_SWAP_COMMAND]),
    inputs: [v4Input],
  };
}

function shortId(id: string) {
  return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

function fmtPrice(p: number) {
  return p.toFixed(4);
}

function fmtTokens(v: bigint) {
  const n = parseFloat(formatUnits(v, 18));
  if (n === 0) return '0';
  if (n < 0.0001) return '<0.0001';
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function SwapPanel({ outcome, osIndex, slug, onClose, onTxSuccess }: SwapPanelProps) {
  const isOpen = outcome !== null;
  const [direction, setDirection] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('');

  const [poolBals, setPoolBals] = useState<bigint[] | null>(null);
  const [userOutcomeBal, setUserOutcomeBal] = useState<bigint | null>(null);
  const [collateralBal, setCollateralBal] = useState<bigint | null>(null);
  const [feeSlot, setFeeSlot] = useState<number | null>(null);
  const [quote, setQuote] = useState<bigint | null>(null);

  const [loadingData, setLoadingData] = useState(false);
  const [loadingQuote, setLoadingQuote] = useState(false);
  const [txPending, setTxPending] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);

  const { wallets } = useWallets();
  const quoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const publicClient = createPublicClient({ chain: getChain(), transport: http() });

  const fetchData = useCallback(async (): Promise<bigint[] | null> => {
    if (!outcome || !osIndex) return null;
    setLoadingData(true);
    try {
      const wallet = wallets[0];
      let account: `0x${string}` | undefined;
      if (wallet) {
        const provider = await wallet.getEthereumProvider();
        [account] = await createWalletClient({ chain: getChain(), transport: custom(provider) }).getAddresses();
      }
      const tokenId = outcomeTokenIdLocal(osIndex as `0x${string}`, outcome.outcomeIndex);
      const posIdx = outcome.outcomeIndex as unknown as number;

      const [bals, slot, userOutcome, collateral] = await Promise.all([
        publicClient.readContract({ address: LMSR_HOOK_ADDRESS, abi: FPMM_ABI, functionName: 'getPoolBalances', args: [osIndex as `0x${string}`] }).catch(() => null),
        publicClient.readContract({ address: LMSR_HOOK_ADDRESS, abi: FPMM_ABI, functionName: 'outcomeFeeSlot', args: [osIndex as `0x${string}`, posIdx] }).catch(() => null),
        account ? publicClient.readContract({ address: LMSR_HOOK_ADDRESS, abi: FPMM_ABI, functionName: 'balanceOf', args: [account, tokenId] }).catch(() => null) : Promise.resolve(null),
        account ? publicClient.readContract({ address: COLLATERAL_TOKEN, abi: ERC20_ABI, functionName: 'balanceOf', args: [account] }).catch(() => null) : Promise.resolve(null),
      ]);

      if (bals) setPoolBals(bals as bigint[]);
      if (slot !== null) setFeeSlot(Number(slot));
      if (userOutcome !== null) setUserOutcomeBal(userOutcome as bigint);
      if (collateral !== null) setCollateralBal(collateral as bigint);
      return bals as bigint[] | null;
    } finally {
      setLoadingData(false);
    }
  }, [outcome, osIndex, wallets]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchQuote = useCallback(async () => {
    if (!outcome || !osIndex || !amount || parseFloat(amount) <= 0) { setQuote(null); return; }
    setLoadingQuote(true);
    try {
      const wad = parseUnits(amount, 18);
      const posIdx = outcome.outcomeIndex as unknown as number;
      const fn = direction === 'buy' ? 'calcBuyAmount' : 'calcSellAmount';
      const r = await publicClient.readContract({ address: LMSR_HOOK_ADDRESS, abi: FPMM_ABI, functionName: fn, args: [osIndex as `0x${string}`, posIdx, wad] });
      setQuote(r as bigint);
    } catch { setQuote(null); } finally { setLoadingQuote(false); }
  }, [outcome, osIndex, amount, direction]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isOpen) { setAmount(''); setQuote(null); setTxError(null); fetchData(); }
  }, [isOpen, fetchData]);

  useEffect(() => {
    if (quoteTimerRef.current) clearTimeout(quoteTimerRef.current);
    setQuote(null);
    if (!amount || parseFloat(amount) <= 0) return;
    quoteTimerRef.current = setTimeout(fetchQuote, 400);
    return () => { if (quoteTimerRef.current) clearTimeout(quoteTimerRef.current); };
  }, [amount, direction, fetchQuote]);

  const outcomePrice = poolBals && outcome ? computeImpliedPrice(poolBals, outcome.outcomeIndex) : null;

  async function handleExecute() {
    if (!wallets[0] || !amount || !outcome || feeSlot === null) return;
    setTxPending(true);
    setTxError(null);
    try {
      const wallet = wallets[0];
      const provider = await wallet.getEthereumProvider();
      const client = createWalletClient({ chain: getChain(), transport: custom(provider) });
      const [account] = await client.getAddresses();

      const amountWad = parseUnits(amount, 18);
      const { poolKey, collIsC0 } = buildPoolKey(feeSlot);
      const hookData = encodeAbiParameters([{ type: 'address' }] as const, [account]);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

      let txHash: `0x${string}` | null = null;

      if (direction === 'buy') {
        // Ensure ERC-20 → Permit2 approval (one-time max approval)
        const erc20Allowance = await publicClient.readContract({
          address: COLLATERAL_TOKEN, abi: ERC20_ABI, functionName: 'allowance',
          args: [account, PERMIT2_ADDRESS],
        }) as bigint;
        //console.log(erc20Allowance)
        if (erc20Allowance < amountWad) {
          const approveTx = await client.writeContract({
            address: COLLATERAL_TOKEN, abi: ERC20_ABI, functionName: 'approve',
            args: [PERMIT2_ADDRESS, (2n ** 256n) - 1n],
            account, chain: getChain(),
          });
          await publicClient.waitForTransactionReceipt({ hash: approveTx });
        }

        // Ensure Permit2 → UniversalRouter allowance (check both amount and expiry)
        const [p2Amount, p2Expiration] = await publicClient.readContract({
          address: PERMIT2_ADDRESS, abi: PERMIT2_ABI, functionName: 'allowance',
          args: [account, COLLATERAL_TOKEN, UNIVERSAL_ROUTER],
        }) as [bigint, number, number];
        if (p2Amount < amountWad || p2Expiration <= Math.floor(Date.now() / 1000)) {
          const expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
          const p2Tx = await client.writeContract({
            address: PERMIT2_ADDRESS, abi: PERMIT2_ABI, functionName: 'approve',
            args: [COLLATERAL_TOKEN, UNIVERSAL_ROUTER, amountWad, expiration],
            account, chain: getChain(),
          });
          await publicClient.waitForTransactionReceipt({ hash: p2Tx });
        }

        const swapInput   = encodeExactInSingle(poolKey, collIsC0, amountWad, hookData);
        const settleInput = encodeSettleAll(COLLATERAL_TOKEN, amountWad);
        const takeInput   = encodeTakeAll(LMSR_HOOK_ADDRESS, 0n);
        const { commands, inputs } = buildV4SwapCalldata(SWAP_EXACT_IN_SINGLE, swapInput, settleInput, takeInput);

        const tx = await client.writeContract({
          address: UNIVERSAL_ROUTER, abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute',
          args: [commands, inputs, deadline],
          account, chain: getChain(), gas: 2_000_000n,
        });
        await publicClient.waitForTransactionReceipt({ hash: tx });
        txHash = tx;

      } else {
        // Sell: ensure hook is approved as operator to burn outcome tokens
        const isOp = await publicClient.readContract({
          address: LMSR_HOOK_ADDRESS, abi: FPMM_ABI, functionName: 'isOperator',
          args: [account, LMSR_HOOK_ADDRESS],
        }) as boolean;
        if (!isOp) {
          const opTx = await client.writeContract({
            address: LMSR_HOOK_ADDRESS, abi: FPMM_ABI, functionName: 'setOperator',
            args: [LMSR_HOOK_ADDRESS, true], account, chain: getChain(),
          });
          await publicClient.waitForTransactionReceipt({ hash: opTx });
        }

        // amountWad = collateral to receive (exactOutput)
        const swapInput   = encodeExactOutSingle(poolKey, collIsC0, amountWad, hookData);
        const settleInput = encodeSettleAll(LMSR_HOOK_ADDRESS, 0n);  // hook absorbs hookAddr side
        const takeInput   = encodeTakeAll(COLLATERAL_TOKEN, 0n);
        const { commands, inputs } = buildV4SwapCalldata(SWAP_EXACT_OUT_SINGLE, swapInput, settleInput, takeInput);

        const tx = await client.writeContract({
          address: UNIVERSAL_ROUTER, abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute',
          args: [commands, inputs, deadline],
          account, chain: getChain(), gas: 2_000_000n,
        });
        await publicClient.waitForTransactionReceipt({ hash: tx });
        txHash = tx;
      }

      setAmount('');
      const newBals = await fetchData();
      if (txHash && slug && outcome) {
        const prices = newBals ? newBals.map((_, i) => computeImpliedPrice(newBals, i)) : undefined;
        fetch(`/api/markets/${slug}/record-activity`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            txHash,
            userAddress: account,
            direction,
            outcomeIndex: outcome.outcomeIndex,
            amountUsdc: amount,
            tokenAmount: quote?.toString() ?? null,
            prices,
          }),
        }).catch(() => {});
      }
      onTxSuccess?.();
    } catch (e: unknown) {
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
          <span className="mg-panel__tag">Outcome</span>
          <h2 className="mg-panel__title">{outcome?.label ?? `Outcome ${outcome?.outcomeIndex}`}</h2>
          {outcome?.positionId && <span className="mg-panel__mono">{shortId(outcome.positionId)}</span>}
        </div>

        <div className="mg-panel__body">
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
            <div className="mg-stat" style={{ flex: 1 }}>
              <span className="mg-stat__label">Price (col/share)</span>
              <span className="mg-stat__value" style={{ fontSize: '1.1rem', fontWeight: 600 }}>
                {loadingData ? '…' : outcomePrice !== null ? fmtPrice(outcomePrice) : '—'}
              </span>
            </div>
            <div className="mg-stat" style={{ flex: 1 }}>
              <span className="mg-stat__label">Pool balance</span>
              <span className="mg-stat__value">
                {loadingData ? '…' : poolBals && outcome ? fmtTokens(poolBals[outcome.outcomeIndex] ?? 0n) : '—'}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem' }}>
            <div className="mg-stat" style={{ flex: 1 }}>
              <span className="mg-stat__label">Your outcome tokens</span>
              <span className="mg-stat__value">{loadingData ? '…' : userOutcomeBal !== null ? fmtTokens(userOutcomeBal) : '—'}</span>
            </div>
            <div className="mg-stat" style={{ flex: 1 }}>
              <span className="mg-stat__label">Your collateral</span>
              <span className="mg-stat__value">{loadingData ? '…' : collateralBal !== null ? fmtTokens(collateralBal) : '—'}</span>
            </div>
          </div>

          <div className="mg-dir-toggle">
            <button className={`mg-dir-toggle__btn${direction === 'buy' ? ' mg-dir-toggle__btn--active' : ''}`} onClick={() => setDirection('buy')}>Buy</button>
            <button className={`mg-dir-toggle__btn${direction === 'sell' ? ' mg-dir-toggle__btn--active' : ''}`} onClick={() => setDirection('sell')}>Sell</button>
          </div>

          <div className="mg-field">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.25rem' }}>
              <label className="mg-field__label" style={{ margin: 0 }}>{direction === 'buy' ? 'Collateral in' : 'Collateral to receive'}</label>
              {direction === 'buy' && collateralBal !== null && collateralBal > 0n && (
                <button
                  style={{ fontSize: '0.7rem', color: '#14b8a6', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                  onClick={() => setAmount(parseFloat(formatUnits(collateralBal, 18)).toFixed(6).replace(/\.?0+$/, ''))}
                  disabled={txPending}
                >
                  Max {fmtTokens(collateralBal)}
                </button>
              )}
              {direction === 'sell' && userOutcomeBal !== null && userOutcomeBal > 0n && (
                <span style={{ fontSize: '0.7rem', color: 'rgba(245,245,240,0.4)' }}>
                  You have {fmtTokens(userOutcomeBal)} tokens
                </span>
              )}
            </div>
            <input className="mg-field__input" type="number" min="0" step="any" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value)} disabled={txPending} />
          </div>

          <div className="mg-stat" style={{ marginBottom: '1rem' }}>
            <span className="mg-stat__label">{direction === 'buy' ? "Tokens you'll receive" : "Tokens you'll spend"}</span>
            <span className="mg-stat__value">{loadingQuote ? '…' : quote !== null ? fmtTokens(quote) : '—'}</span>
          </div>

          {quote !== null && quote > 0n && amount && parseFloat(amount) > 0 && (
            <div className="mg-stat" style={{ marginBottom: '1rem' }}>
              <span className="mg-stat__label">Avg. price (col/share)</span>
              <span className="mg-stat__value">{fmtPrice(parseFloat(amount) / Number(formatUnits(quote, 18)))}</span>
            </div>
          )}

          <button className="mg-panel__action" onClick={handleExecute} disabled={!amount || !wallets[0] || txPending || feeSlot === null}>
            {txPending ? 'Pending…' : !wallets[0] ? 'Connect wallet' : direction === 'buy' ? 'Buy shares' : 'Sell shares'}
          </button>

          {txError && <p className="mg-panel__error">{txError}</p>}
        </div>
      </div>
    </>
  );
}
