export const LMSR_HOOK_ADDRESS = (process.env.NEXT_PUBLIC_LMSR_HOOK_ADDRESS ?? '0x') as `0x${string}`;
export const COLLATERAL_TOKEN = (process.env.NEXT_PUBLIC_COLLATERAL_TOKEN ?? '0x') as `0x${string}`;
export const ORACLE_ACCOUNT = (process.env.NEXT_PUBLIC_ORACLE_ACCOUNT ?? '0x') as `0x${string}`;

// 1000 WAD — sensible default for 18-decimal collateral
export const LMSR_B_DEFAULT = 1000n * 10n ** 18n;

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
      { name: 'outcomeSlotCount', type: 'uint256', indexed: false },
    ],
  },
] as const;

export const LMSR_ABI = [
  {
    name: 'createOS',
    type: 'function',
    inputs: [
      { name: 'collateral', type: 'address' },
      { name: 'conditions', type: 'bytes32[]' },
      { name: 'b', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'getPoolBalances',
    type: 'function',
    inputs: [{ name: 'osIndex', type: 'bytes32' }],
    outputs: [
      { name: 'positions', type: 'uint256[]' },
      { name: 'bals', type: 'uint256[]' },
    ],
    stateMutability: 'view',
  },
  {
    name: 'prediction_tokens',
    type: 'function',
    inputs: [{ name: '', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
  {
    name: 'OSCreated',
    type: 'event',
    inputs: [
      { name: 'osIndex', type: 'bytes32', indexed: true },
      { name: 'collateral', type: 'address', indexed: true },
      { name: 'shares', type: 'address', indexed: false },
      { name: 'conditions', type: 'bytes32[]', indexed: false },
      { name: 'b', type: 'uint256', indexed: false },
    ],
  },
] as const;
