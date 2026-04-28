import {
  encodeAbiParameters,
  encodePacked,
  parseUnits,
} from 'viem';
import type { WalletClient, PublicClient } from 'viem';
import {
  FPMM_ABI,
  ERC20_ABI,
  UNIVERSAL_ROUTER_ABI,
  PERMIT2_ABI,
  PERMIT2_ADDRESS,
  LMSR_HOOK_ADDRESS,
  COLLATERAL_TOKEN,
  UNIVERSAL_ROUTER,
  computeImpliedPrice,
} from '@/lib/contracts';
import { getChain } from '@/lib/chain';

// ── Universal Router / V4 constants ──────────────────────────────────────────

const V4_SWAP_COMMAND  = 0x10;
const SWAP_EXACT_IN_SINGLE = 0x06;
const SETTLE_ALL_ACTION    = 0x0c;
const TAKE_ALL_ACTION      = 0x0f;
const MAX_UINT128 = (2n ** 128n) - 1n;

// ── Pool key ──────────────────────────────────────────────────────────────────

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
      fee:         feeSlot,
      tickSpacing: 60,
      hooks:       LMSR_HOOK_ADDRESS,
    },
    collIsC0,
  };
}

// ── Encoding helpers (verbatim from swap-panel.tsx) ───────────────────────────

type PoolKey = ReturnType<typeof buildPoolKey>['poolKey'];

function encodeExactInSingle(
  poolKey: PoolKey,
  collIsC0: boolean,
  amountIn: bigint,
  hookData: `0x${string}`,
): `0x${string}` {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return encodeAbiParameters([{ type: 'tuple', components: [
    { type: 'tuple', name: 'poolKey', components: POOL_KEY_COMPONENTS },
    { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' },
    { name: 'amountOutMinimum', type: 'uint128' }, { name: 'hookData', type: 'bytes' },
  ] }] as any, [{ poolKey, zeroForOne: collIsC0, amountIn, amountOutMinimum: 0n, hookData }]); // eslint-disable-line @typescript-eslint/no-explicit-any
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

// ── Trade size via binary search ──────────────────────────────────────────────

// Returns collateral amount (in wei, 18 decimals) to move outcome `idx` to `targetProb`.
// Uses calcBuyAmount to simulate the price impact iteratively.
export async function computeTradeSize(
  publicClient: PublicClient,
  osIndex: `0x${string}`,
  balances: bigint[],
  outcomeIdx: number,
  targetProb: number,
  maxCollateralWei: bigint,
): Promise<bigint> {
  const currentProb = computeImpliedPrice(balances, outcomeIdx);
  if (targetProb <= currentProb) return 0n; // only buy to push price up

  let lo = 0n;
  let hi = maxCollateralWei;

  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2n;
    if (mid === 0n) break;

    // Simulate: how many outcome tokens do we get for `mid` collateral?
    const outcomeTokens = await publicClient.readContract({
      address: LMSR_HOOK_ADDRESS,
      abi: FPMM_ABI,
      functionName: 'calcBuyAmount',
      args: [osIndex, outcomeIdx as unknown as number, mid],
    }).catch(() => null) as bigint | null;

    if (!outcomeTokens) break;

    // After trade: new pool balance for idx = old - outcomeTokens
    const newBals = balances.map((b, i) => i === outcomeIdx ? b - outcomeTokens : b);
    if (newBals[outcomeIdx] <= 0n) { hi = mid; continue; }

    const newProb = computeImpliedPrice(newBals, outcomeIdx);

    if (Math.abs(newProb - targetProb) < 0.005) return mid;
    if (newProb < targetProb) lo = mid;
    else hi = mid;
  }

  return lo;
}

// ── Execute nudge trade ───────────────────────────────────────────────────────

export async function executeNudgeTrade(
  walletClient: WalletClient,
  publicClient: PublicClient,
  osIndex: `0x${string}`,
  outcomeIdx: number,
  collateralAmount: bigint,
): Promise<`0x${string}`> {
  const account = walletClient.account!;
  const chain = getChain();

  const feeSlot = await publicClient.readContract({
    address: LMSR_HOOK_ADDRESS,
    abi: FPMM_ABI,
    functionName: 'outcomeFeeSlot',
    args: [osIndex, outcomeIdx as unknown as number],
  }) as unknown as bigint;

  const { poolKey, collIsC0 } = buildPoolKey(Number(feeSlot));
  const hookData = encodeAbiParameters([{ type: 'address' }] as const, [account.address]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

  // ERC-20 → Permit2 approval
  const erc20Allowance = await publicClient.readContract({
    address: COLLATERAL_TOKEN, abi: ERC20_ABI, functionName: 'allowance',
    args: [account.address, PERMIT2_ADDRESS],
  }) as bigint;
  if (erc20Allowance < collateralAmount) {
    const approveTx = await walletClient.writeContract({
      address: COLLATERAL_TOKEN, abi: ERC20_ABI, functionName: 'approve',
      args: [PERMIT2_ADDRESS, (2n ** 256n) - 1n],
      account, chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
  }

  // Permit2 → UniversalRouter allowance
  const [p2Amount, p2Expiration] = await publicClient.readContract({
    address: PERMIT2_ADDRESS, abi: PERMIT2_ABI, functionName: 'allowance',
    args: [account.address, COLLATERAL_TOKEN, UNIVERSAL_ROUTER],
  }) as [bigint, number, number];
  if (p2Amount < collateralAmount || p2Expiration <= Math.floor(Date.now() / 1000)) {
    const expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
    const p2Tx = await walletClient.writeContract({
      address: PERMIT2_ADDRESS, abi: PERMIT2_ABI, functionName: 'approve',
      args: [COLLATERAL_TOKEN, UNIVERSAL_ROUTER, collateralAmount, expiration],
      account, chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: p2Tx });
  }

  const swapInput   = encodeExactInSingle(poolKey, collIsC0, collateralAmount, hookData);
  const settleInput = encodeSettleAll(COLLATERAL_TOKEN, collateralAmount);
  const takeInput   = encodeTakeAll(LMSR_HOOK_ADDRESS, 0n);
  const { commands, inputs } = buildV4SwapCalldata(SWAP_EXACT_IN_SINGLE, swapInput, settleInput, takeInput);

  const tx = await walletClient.writeContract({
    address: UNIVERSAL_ROUTER, abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute',
    args: [commands, inputs, deadline],
    account, chain, gas: 2_000_000n,
  });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  return tx;
}

export const MAX_USDC = Number(process.env.AGENT_MAX_TRADE_USDC ?? '5');
export const MAX_TRADE_WEI = parseUnits(String(MAX_USDC), 18);
export const PROB_THRESHOLD = Number(process.env.AGENT_PROBABILITY_THRESHOLD ?? '0.20');
