export const LMSR_HOOK_ADDRESS = (process.env.NEXT_PUBLIC_LMSR_HOOK_ADDRESS ?? '0x') as `0x${string}`;
export const COLLATERAL_TOKEN = (process.env.NEXT_PUBLIC_COLLATERAL_TOKEN ?? '0x') as `0x${string}`;
export const ORACLE_ACCOUNT = (process.env.NEXT_PUBLIC_ORACLE_ACCOUNT ?? '0x') as `0x${string}`;
export const UNIVERSAL_ROUTER = (process.env.NEXT_PUBLIC_UNIVERSAL_ROUTER ?? '0x') as `0x${string}`;

// ── Token ID helpers (mirrors FPMMHook.sol constants) ──────────────────────

const _OUTCOME_SHIFT = 224n;
const _MARKET_MASK = (1n << 224n) - 1n;
const _LP_FLAG = 1n << 255n;

export function outcomeTokenIdLocal(osIndex: `0x${string}`, linearIdx: number): bigint {
  return (BigInt(linearIdx) << _OUTCOME_SHIFT) | (BigInt(osIndex) & _MARKET_MASK);
}

export function lpTokenIdLocal(osIndex: `0x${string}`): bigint {
  return _LP_FLAG | (BigInt(osIndex) & _MARKET_MASK);
}

// FPMM implied probability for outcome `idx` from pool balances.
// price[i] = product(bals[j], j≠i) / sum_k(product(bals[j], j≠k))
// Uses log-sum-exp for numerical stability with large uint256 values.
export function computeImpliedPrice(bals: bigint[], idx: number): number {
  const n = bals.length;
  if (n === 0) return 0;
  if (bals.some(b => b === 0n)) return 1 / n;
  const logs = bals.map(b => Math.log(Number(b)));
  const logProds = Array.from({ length: n }, (_, i) =>
    logs.reduce((sum, l, j) => (j === i ? sum : sum + l), 0)
  );
  const maxLP = Math.max(...logProds);
  const prods = logProds.map(lp => Math.exp(lp - maxLP));
  const total = prods.reduce((a, b) => a + b, 0);
  return total === 0 ? 1 / n : prods[idx] / total;
}

export const CT_ABI = [
  {
    name: 'prepareCondition',
    type: 'function',
    inputs: [
      { name: 'oracle', type: 'address' },
      { name: 'questionId', type: 'bytes32' },
      { name: 'outcomeSlotCount', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'ConditionPreparation',
    type: 'event',
    inputs: [
      { name: 'conditionId', type: 'bytes32', indexed: true },
      { name: 'oracle', type: 'address', indexed: true },
      { name: 'questionId', type: 'bytes32', indexed: true },
      { name: 'slotCount', type: 'uint256', indexed: false },
    ],
  },
] as const;

export const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    name: 'allowance',
    type: 'function',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'balanceOf',
    type: 'function',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'decimals',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
  },
] as const;

// ABI for FPMMHook (FPMM-based prediction market hook)
export const FPMM_ABI = [
  {
    name: 'createOutcomeSpace',
    type: 'function',
    inputs: [
      { name: 'collateral', type: 'address' },
      { name: 'conditions', type: 'bytes32[]' },
      { name: 'initialWeights', type: 'uint256[]' },
    ],
    outputs: [{ name: 'osIndex', type: 'bytes32' }],
    stateMutability: 'nonpayable',
  },
  {
    name: 'addLiquidity',
    type: 'function',
    inputs: [
      { name: 'osIndex', type: 'bytes32' },
      { name: 'collateralAmount', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'removeLiquidity',
    type: 'function',
    inputs: [
      { name: 'osIndex', type: 'bytes32' },
      { name: 'lpAmount', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'feesWithdrawableBy',
    type: 'function',
    inputs: [
      { name: 'osIndex', type: 'bytes32' },
      { name: 'account', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'withdrawFees',
    type: 'function',
    inputs: [{ name: 'osIndex', type: 'bytes32' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'poolManager',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
  {
    name: 'getPoolBalances',
    type: 'function',
    inputs: [{ name: 'osIndex', type: 'bytes32' }],
    outputs: [{ name: 'bals', type: 'uint256[]' }],
    stateMutability: 'view',
  },
  {
    name: 'outcomeTokenId',
    type: 'function',
    inputs: [
      { name: 'osIndex', type: 'bytes32' },
      { name: 'linearIdx', type: 'uint32' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'pure',
  },
  {
    name: 'calcBuyAmount',
    type: 'function',
    inputs: [
      { name: 'osIndex', type: 'bytes32' },
      { name: 'posIdx', type: 'uint32' },
      { name: 'investmentAmount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'calcSellAmount',
    type: 'function',
    inputs: [
      { name: 'osIndex', type: 'bytes32' },
      { name: 'posIdx', type: 'uint32' },
      { name: 'returnAmount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'OSCreated',
    type: 'event',
    inputs: [
      { name: 'osIndex', type: 'bytes32', indexed: true },
      { name: 'collateral', type: 'address', indexed: true },
      { name: 'conditions', type: 'bytes32[]', indexed: false },
    ],
  },
  {
    name: 'balanceOf',
    type: 'function',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'id', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'lpTokenId',
    type: 'function',
    inputs: [{ name: 'osIndex', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'pure',
  },
  {
    name: 'getOSInfo',
    type: 'function',
    inputs: [{ name: 'osIndex', type: 'bytes32' }],
    outputs: [
      { name: 'collateral', type: 'address' },
      { name: 'conditions', type: 'bytes32[]' },
      { name: 'positions', type: 'uint256[]' },
      { name: 'lpTotalSupply', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    name: 'setOperator',
    type: 'function',
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'approved', type: 'bool' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    name: 'isOperator',
    type: 'function',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'operator', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    name: 'outcomeFeeSlot',
    type: 'function',
    inputs: [
      { name: 'osIndex', type: 'bytes32' },
      { name: 'linearIdx', type: 'uint32' },
    ],
    outputs: [{ name: '', type: 'uint24' }],
    stateMutability: 'view',
  },
  {
    name: 'splitCollateral',
    type: 'function',
    inputs: [
      { name: 'osIndex', type: 'bytes32' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'mergeCollateral',
    type: 'function',
    inputs: [
      { name: 'osIndex', type: 'bytes32' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'splitPosition',
    type: 'function',
    inputs: [
      { name: 'osIndex', type: 'bytes32' },
      { name: 'parentLinearIdx', type: 'uint32' },
      { name: 'condition', type: 'bytes32' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'mergePosition',
    type: 'function',
    inputs: [
      { name: 'osIndex', type: 'bytes32' },
      { name: 'parentLinearIdx', type: 'uint32' },
      { name: 'condition', type: 'bytes32' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'setFeeParams',
    type: 'function',
    inputs: [
      { name: '_baseFee', type: 'uint256' },
      { name: '_minFee', type: 'uint256' },
      { name: '_maxFee', type: 'uint256' },
      { name: '_alpha', type: 'uint256' },
      { name: '_beta', type: 'uint256' },
      { name: '_volNeutral', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'reportPayouts',
    type: 'function',
    inputs: [
      { name: 'questionId', type: 'bytes32' },
      { name: 'payouts', type: 'uint256[]' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  { name: 'baseFee',    type: 'function', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { name: 'minFee',     type: 'function', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { name: 'maxFee',     type: 'function', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { name: 'alpha',      type: 'function', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { name: 'beta',       type: 'function', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { name: 'volNeutral', type: 'function', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  {
    name: 'isResolved',
    type: 'function',
    inputs: [{ name: '_osIndex', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    name: 'redeem',
    type: 'function',
    inputs: [{ name: 'osIndex', type: 'bytes32' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'payoutNumerators',
    type: 'function',
    inputs: [
      { name: 'conditionId', type: 'bytes32' },
      { name: 'index', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'payoutDenominator',
    type: 'function',
    inputs: [{ name: 'conditionId', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'getOutcomeSlotCount',
    type: 'function',
    inputs: [{ name: 'conditionId', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'getOSIndex',
    type: 'function',
    inputs: [
      { name: 'collateral', type: 'address' },
      { name: 'conditions', type: 'bytes32[]' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'pure',
  },
] as const;

// Backward-compat alias
export const LMSR_ABI = FPMM_ABI;

// Canonical Permit2 address (same on all EVM chains)
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as `0x${string}`;

export const PERMIT2_ABI = [
  {
    name: 'approve',
    type: 'function',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'allowance',
    type: 'function',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ],
    stateMutability: 'view',
  },
] as const;

export const UNIVERSAL_ROUTER_ABI = [
  {
    name: 'execute',
    type: 'function',
    inputs: [
      { name: 'commands', type: 'bytes' },
      { name: 'inputs', type: 'bytes[]' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
] as const;
