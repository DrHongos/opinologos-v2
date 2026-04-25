import { mainnet, base, baseSepolia, optimism, arbitrum, sepolia } from 'viem/chains';
import { defineChain, type Chain } from 'viem';

const unichainSepolia = defineChain({
  id: 1301,
  name: 'Unichain Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://sepolia.unichain.org'] },
  },
  blockExplorers: {
    default: { name: 'Uniscan', url: 'https://sepolia.uniscan.xyz' },
  },
  testnet: true,
});

const KNOWN: Record<number, Chain> = {
  1: mainnet,
  10: optimism,
  8453: base,
  42161: arbitrum,
  11155111: sepolia,
  84532: baseSepolia,
  1301: unichainSepolia,
};

export function getChain(): Chain {
  const id = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 8453);
  return KNOWN[id] ?? base;
}

export const TARGET_CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 8453);
