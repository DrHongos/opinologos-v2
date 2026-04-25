'use client';

import { usePrivy, useWallets } from '@privy-io/react-auth';

function truncateAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function WalletButton() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();

  const primaryWallet = wallets[0];
  const address = primaryWallet?.address;

  if (!ready) {
    return (
      <button
        disabled
        className="wallet-btn wallet-btn--loading"
        aria-label="Loading"
      >
        <span className="wallet-btn__dot" />
        <span className="wallet-btn__dot" />
        <span className="wallet-btn__dot" />
      </button>
    );
  }

  if (!authenticated) {
    return (
      <button onClick={login} className="wallet-btn wallet-btn--connect">
        <span className="wallet-btn__icon">◈</span>
        Connect Wallet
      </button>
    );
  }

  return (
    <div className="wallet-connected">
      <div className="wallet-connected__info">
        <span className="wallet-connected__indicator" />
        <span className="wallet-connected__address">
          {address ? truncateAddress(address) : 'Connected'}
        </span>
      </div>
      <button onClick={logout} className="wallet-btn wallet-btn--disconnect">
        Disconnect
      </button>
    </div>
  );
}
