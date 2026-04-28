import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getChain } from '@/lib/chain';

function getRpcUrl(): string {
  return process.env.UNICHAIN_SEPOLIA_RPC ?? 'https://sepolia.unichain.org';
}

export function getOracleAccount() {
  const pk = process.env.ORACLE_PK;
  if (!pk) throw new Error('ORACLE_PK env var not set');
  return privateKeyToAccount(pk as `0x${string}`);
}

export function getOracleWalletClient() {
  const account = getOracleAccount();
  return createWalletClient({ account, chain: getChain(), transport: http(getRpcUrl()) });
}

export function getPublicClient() {
  return createPublicClient({ chain: getChain(), transport: http(getRpcUrl()) });
}
