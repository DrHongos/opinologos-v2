'use client';

import { useEffect, useState } from 'react';
import { useWallets } from '@privy-io/react-auth';
import { getChain, TARGET_CHAIN_ID } from '@/lib/chain';

export function ChainGuard() {
  const { wallets } = useWallets();
  const wallet = wallets[0];
  const [chainId, setChainId] = useState<number | null>(null);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!wallet) { setChainId(null); return; }

    async function readChain() {
      try {
        const provider = await wallet.getEthereumProvider();
        const raw = await (provider as { request: (args: { method: string }) => Promise<string> })
          .request({ method: 'eth_chainId' });
        setChainId(parseInt(raw, 16));
      } catch {
        setChainId(null);
      }
    }

    readChain();
  }, [wallet]);

  if (!wallet || chainId === null || chainId === TARGET_CHAIN_ID) return null;

  const target = getChain();

  async function handleSwitch() {
    if (!wallet) return;
    setSwitching(true);
    setError('');
    try {
      const provider = await wallet.getEthereumProvider();
      const p = provider as {
        request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      };
      const chainHex = `0x${TARGET_CHAIN_ID.toString(16)}`;
      try {
        await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainHex }] });
      } catch (switchErr: unknown) {
        // 4902 = chain not added yet
        if ((switchErr as { code?: number }).code === 4902) {
          await p.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: chainHex,
              chainName: target.name,
              nativeCurrency: target.nativeCurrency,
              rpcUrls: [target.rpcUrls.default.http[0]],
              blockExplorerUrls: target.blockExplorers
                ? [target.blockExplorers.default.url]
                : [],
            }],
          });
        } else {
          throw switchErr;
        }
      }
      setChainId(TARGET_CHAIN_ID);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Switch failed');
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div className="chain-guard">
      <div className="chain-guard__inner">
        <div className="chain-guard__left">
          <span className="chain-guard__icon">⚠</span>
          <div>
            <span className="chain-guard__title">Wrong network</span>
            <span className="chain-guard__sub">
              Switch to <strong>{target.name}</strong> (chain {TARGET_CHAIN_ID}) to interact with markets.
            </span>
          </div>
        </div>
        <div className="chain-guard__right">
          {error && <span className="chain-guard__err">{error}</span>}
          <button
            className="chain-guard__btn"
            onClick={handleSwitch}
            disabled={switching}
          >
            {switching ? 'Switching…' : `Switch to ${target.name}`}
          </button>
        </div>
      </div>
    </div>
  );
}
