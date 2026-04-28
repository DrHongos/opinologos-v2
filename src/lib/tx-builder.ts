import {
  encodeFunctionData,
  encodeAbiParameters,
  encodePacked,
  parseUnits,
} from 'viem';
import {
  FPMM_ABI,
  ERC20_ABI,
  PERMIT2_ABI,
  UNIVERSAL_ROUTER_ABI,
  PERMIT2_ADDRESS,
  LMSR_HOOK_ADDRESS,
  COLLATERAL_TOKEN,
  UNIVERSAL_ROUTER,
} from '@/lib/contracts';

export interface UnsignedTx {
  to: `0x${string}`;
  data: `0x${string}`;
  value: string;
  description: string;
  optional?: boolean;
}

export interface TxResponse {
  transactions: UnsignedTx[];
  chainId: number;
  note?: string;
}

// ── Shared constants ──────────────────────────────────────────────────────────

const V4_SWAP_COMMAND   = 0x10;
const SWAP_EXACT_IN     = 0x06;
const SWAP_EXACT_OUT    = 0x08;
const SETTLE_ALL        = 0x0c;
const TAKE_ALL          = 0x0f;
const MAX_UINT128       = (2n ** 128n) - 1n;
const MAX_ERC20         = (2n ** 256n) - 1n;
const PERMIT2_DEADLINE  = () => BigInt(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365);
const SWAP_DEADLINE     = () => BigInt(Math.floor(Date.now() / 1000) + 300);

const POOL_KEY_COMPONENTS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee',         type: 'uint24'  },
  { name: 'tickSpacing', type: 'int24'   },
  { name: 'hooks',       type: 'address' },
] as const;

function buildPoolKey(feeSlot: number) {
  const collIsC0 = BigInt(COLLATERAL_TOKEN) < BigInt(LMSR_HOOK_ADDRESS);
  return {
    poolKey: {
      currency0: (collIsC0 ? COLLATERAL_TOKEN : LMSR_HOOK_ADDRESS) as `0x${string}`,
      currency1: (collIsC0 ? LMSR_HOOK_ADDRESS : COLLATERAL_TOKEN) as `0x${string}`,
      fee: feeSlot,
      tickSpacing: 60,
      hooks: LMSR_HOOK_ADDRESS,
    },
    collIsC0,
  };
}

type PoolKey = ReturnType<typeof buildPoolKey>['poolKey'];

function encodeExactIn(poolKey: PoolKey, zeroForOne: boolean, amountIn: bigint, hookData: `0x${string}`): `0x${string}` {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return encodeAbiParameters([{ type: 'tuple', components: [
    { type: 'tuple', name: 'poolKey', components: POOL_KEY_COMPONENTS },
    { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' },
    { name: 'amountOutMinimum', type: 'uint128' }, { name: 'hookData', type: 'bytes' },
  ] }] as any, [{ poolKey, zeroForOne, amountIn, amountOutMinimum: 0n, hookData }]); // eslint-disable-line @typescript-eslint/no-explicit-any
}

function encodeExactOut(poolKey: PoolKey, zeroForOne: boolean, amountOut: bigint, hookData: `0x${string}`): `0x${string}` {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return encodeAbiParameters([{ type: 'tuple', components: [
    { type: 'tuple', name: 'poolKey', components: POOL_KEY_COMPONENTS },
    { name: 'zeroForOne', type: 'bool' }, { name: 'amountOut', type: 'uint128' },
    { name: 'amountInMaximum', type: 'uint128' }, { name: 'hookData', type: 'bytes' },
  ] }] as any, [{ poolKey, zeroForOne, amountOut, amountInMaximum: MAX_UINT128, hookData }]); // eslint-disable-line @typescript-eslint/no-explicit-any
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

function buildSwapCalldata(actionByte: number, swapInput: `0x${string}`, settleInput: `0x${string}`, takeInput: `0x${string}`) {
  const actions = encodePacked(['uint8', 'uint8', 'uint8'], [actionByte, SETTLE_ALL, TAKE_ALL]);
  const v4Input = encodeAbiParameters(
    [{ name: 'actions', type: 'bytes' }, { name: 'params', type: 'bytes[]' }] as const,
    [actions, [swapInput, settleInput, takeInput]],
  );
  return {
    commands: encodePacked(['uint8'], [V4_SWAP_COMMAND]),
    inputs: [v4Input],
  };
}

// ── ERC-20 + PERMIT2 approval txs ────────────────────────────────────────────

export function erc20ApproveTx(spender: `0x${string}`, amount: bigint = MAX_ERC20): UnsignedTx {
  return {
    to: COLLATERAL_TOKEN,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, amount] }),
    value: '0',
    description: `Approve ${spender === PERMIT2_ADDRESS ? 'PERMIT2' : spender} to spend collateral (skip if already approved for sufficient amount)`,
    optional: true,
  };
}

export function permit2ApproveTx(amount: bigint): UnsignedTx {
  return {
    to: PERMIT2_ADDRESS,
    data: encodeFunctionData({
      abi: PERMIT2_ABI,
      functionName: 'approve',
      args: [COLLATERAL_TOKEN, UNIVERSAL_ROUTER, amount as unknown as bigint, Number(PERMIT2_DEADLINE()) as unknown as number],
    }),
    value: '0',
    description: 'Approve Universal Router via PERMIT2 (skip if already approved)',
    optional: true,
  };
}

// ── Trade (buy / sell via Universal Router) ───────────────────────────────────

export function buildTradeTxs(
  feeSlot: number,
  from: `0x${string}`,
  direction: 'buy' | 'sell',
  amountWei: bigint,
): UnsignedTx[] {
  const { poolKey, collIsC0 } = buildPoolKey(feeSlot);
  const hookData = encodeAbiParameters([{ type: 'address' }] as const, [from]);
  const deadline = SWAP_DEADLINE();

  if (direction === 'buy') {
    const swapInput   = encodeExactIn(poolKey, collIsC0, amountWei, hookData);
    const settleInput = encodeSettleAll(COLLATERAL_TOKEN, amountWei);
    const takeInput   = encodeTakeAll(LMSR_HOOK_ADDRESS, 0n);
    const { commands, inputs } = buildSwapCalldata(SWAP_EXACT_IN, swapInput, settleInput, takeInput);

    return [
      erc20ApproveTx(PERMIT2_ADDRESS),
      permit2ApproveTx(amountWei),
      {
        to: UNIVERSAL_ROUTER,
        data: encodeFunctionData({
          abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute',
          args: [commands, inputs, deadline],
        }),
        value: '0',
        description: `Buy outcome tokens (exactIn ${amountWei} wei collateral)`,
      },
    ];
  } else {
    // sell: exactOut collateral, give outcome tokens
    const swapInput   = encodeExactOut(poolKey, !collIsC0, amountWei, hookData);
    const settleInput = encodeSettleAll(LMSR_HOOK_ADDRESS, 0n);
    const takeInput   = encodeTakeAll(COLLATERAL_TOKEN, 0n);
    const { commands, inputs } = buildSwapCalldata(SWAP_EXACT_OUT, swapInput, settleInput, takeInput);

    return [
      {
        to: LMSR_HOOK_ADDRESS,
        data: encodeFunctionData({
          abi: FPMM_ABI, functionName: 'setOperator',
          args: [LMSR_HOOK_ADDRESS, true],
        }),
        value: '0',
        description: 'Approve hook as operator to burn outcome tokens (skip if already set)',
        optional: true,
      },
      {
        to: UNIVERSAL_ROUTER,
        data: encodeFunctionData({
          abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute',
          args: [commands, inputs, deadline],
        }),
        value: '0',
        description: `Sell outcome tokens (exactOut ${amountWei} wei collateral received)`,
      },
    ];
  }
}

// ── Split / Merge collateral ──────────────────────────────────────────────────

export function buildSplitCollateralTxs(osIndex: `0x${string}`, amountWei: bigint): UnsignedTx[] {
  return [
    {
      to: COLLATERAL_TOKEN,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [LMSR_HOOK_ADDRESS, amountWei] }),
      value: '0',
      description: 'Approve hook to pull collateral (skip if already approved)',
      optional: true,
    },
    {
      to: LMSR_HOOK_ADDRESS,
      data: encodeFunctionData({ abi: FPMM_ABI, functionName: 'splitCollateral', args: [osIndex, amountWei] }),
      value: '0',
      description: 'Split collateral into equal amounts of all outcome tokens',
    },
  ];
}

export function buildMergeCollateralTxs(osIndex: `0x${string}`, amountWei: bigint): UnsignedTx[] {
  return [
    {
      to: LMSR_HOOK_ADDRESS,
      data: encodeFunctionData({ abi: FPMM_ABI, functionName: 'mergeCollateral', args: [osIndex, amountWei] }),
      value: '0',
      description: 'Burn equal amounts of all outcome tokens to receive collateral',
    },
  ];
}

// ── Split / Merge position ────────────────────────────────────────────────────

export function buildSplitPositionTxs(
  osIndex: `0x${string}`,
  parentLinearIdx: number,
  condition: `0x${string}`,
  amountWei: bigint,
): UnsignedTx[] {
  return [
    {
      to: LMSR_HOOK_ADDRESS,
      data: encodeFunctionData({
        abi: FPMM_ABI, functionName: 'splitPosition',
        args: [osIndex, parentLinearIdx, condition, amountWei],
      }),
      value: '0',
      description: `Split parent outcome ${parentLinearIdx} tokens into leaf outcomes under condition ${condition}`,
    },
  ];
}

export function buildMergePositionTxs(
  osIndex: `0x${string}`,
  parentLinearIdx: number,
  condition: `0x${string}`,
  amountWei: bigint,
): UnsignedTx[] {
  return [
    {
      to: LMSR_HOOK_ADDRESS,
      data: encodeFunctionData({
        abi: FPMM_ABI, functionName: 'mergePosition',
        args: [osIndex, parentLinearIdx, condition, amountWei],
      }),
      value: '0',
      description: `Merge leaf outcomes under condition ${condition} back into parent outcome ${parentLinearIdx}`,
    },
  ];
}

// ── Redeem, Liquidity, Fees ───────────────────────────────────────────────────

export function buildRedeemTxs(osIndex: `0x${string}`): UnsignedTx[] {
  return [
    {
      to: LMSR_HOOK_ADDRESS,
      data: encodeFunctionData({ abi: FPMM_ABI, functionName: 'redeem', args: [osIndex] }),
      value: '0',
      description: 'Redeem winning outcome tokens for collateral after market resolution',
    },
  ];
}

export function buildAddLiquidityTxs(osIndex: `0x${string}`, amountWei: bigint): UnsignedTx[] {
  return [
    {
      to: COLLATERAL_TOKEN,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [LMSR_HOOK_ADDRESS, amountWei] }),
      value: '0',
      description: 'Approve hook to pull collateral for liquidity (skip if already approved)',
      optional: true,
    },
    {
      to: LMSR_HOOK_ADDRESS,
      data: encodeFunctionData({ abi: FPMM_ABI, functionName: 'addLiquidity', args: [osIndex, amountWei] }),
      value: '0',
      description: 'Add collateral as liquidity to market pool, receive LP tokens',
    },
  ];
}

export function buildRemoveLiquidityTxs(osIndex: `0x${string}`, lpAmountWei: bigint): UnsignedTx[] {
  return [
    {
      to: LMSR_HOOK_ADDRESS,
      data: encodeFunctionData({ abi: FPMM_ABI, functionName: 'removeLiquidity', args: [osIndex, lpAmountWei] }),
      value: '0',
      description: 'Burn LP tokens to withdraw collateral from pool',
    },
  ];
}

export function buildWithdrawFeesTxs(osIndex: `0x${string}`): UnsignedTx[] {
  return [
    {
      to: LMSR_HOOK_ADDRESS,
      data: encodeFunctionData({ abi: FPMM_ABI, functionName: 'withdrawFees', args: [osIndex] }),
      value: '0',
      description: 'Withdraw accrued trading fees to your address',
    },
  ];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function parseUsdcToWei(usdcString: string): bigint {
  return parseUnits(usdcString, 18);
}

export function getChainId(): number {
  return Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? '1301');
}
