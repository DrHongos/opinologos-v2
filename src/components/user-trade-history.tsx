'use client';

import { useEffect, useState } from 'react';
import { useWallets } from '@privy-io/react-auth';

interface Trade {
  id: string;
  direction: string;
  outcome_index: number | null;
  amount_usdc: string;
  token_amount: string | null;
  tx_hash: string;
  created_at: string;
}

const EXPLORER = 'https://sepolia.uniscan.xyz/tx/';

const DIRECTION_LABELS: Record<string, string> = {
  buy: 'Buy',
  sell: 'Sell',
  add_liquidity: 'Add LP',
  remove_liquidity: 'Remove LP',
  split_collateral: 'Split',
  merge_collateral: 'Merge',
  split_position: 'Split Pos.',
  merge_position: 'Merge Pos.',
  redeem: 'Redeem',
  withdraw_fees: 'Fees',
};

const DIRECTION_COLORS: Record<string, string> = {
  buy: 'text-teal-400',
  sell: 'text-amber-400',
  add_liquidity: 'text-blue-400',
  remove_liquidity: 'text-blue-300',
  split_collateral: 'text-violet-400',
  merge_collateral: 'text-violet-300',
  split_position: 'text-pink-400',
  merge_position: 'text-pink-300',
  redeem: 'text-green-400',
  withdraw_fees: 'text-emerald-400',
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function shortHash(h: string) {
  return `${h.slice(0, 8)}…${h.slice(-6)}`;
}

function fmtAmount(amt: string) {
  const n = parseFloat(amt);
  if (isNaN(n)) return amt;
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function UserTradeHistory({ slug }: { slug: string }) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(false);
  const { wallets } = useWallets();

  const address = wallets[0]?.address;

  useEffect(() => {
    if (!address) return;
    setLoading(true);
    fetch(`/api/markets/${slug}/trades?address=${address}`)
      .then(r => r.json())
      .then(d => setTrades(d.trades ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [slug, address]);

  if (!address) return null;
  if (loading) return null;
  if (trades.length === 0) return null;

  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4">
        Your Activity
      </h2>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(245,245,240,0.08)' }}>
              <th style={{ textAlign: 'left', padding: '0.35rem 0.5rem', color: 'rgba(245,245,240,0.4)', fontWeight: 500 }}>Type</th>
              <th style={{ textAlign: 'left', padding: '0.35rem 0.5rem', color: 'rgba(245,245,240,0.4)', fontWeight: 500 }}>Outcome</th>
              <th style={{ textAlign: 'right', padding: '0.35rem 0.5rem', color: 'rgba(245,245,240,0.4)', fontWeight: 500 }}>Amount</th>
              <th style={{ textAlign: 'left', padding: '0.35rem 0.5rem', color: 'rgba(245,245,240,0.4)', fontWeight: 500 }}>When</th>
              <th style={{ textAlign: 'left', padding: '0.35rem 0.5rem', color: 'rgba(245,245,240,0.4)', fontWeight: 500 }}>Tx</th>
            </tr>
          </thead>
          <tbody>
            {trades.map(t => (
              <tr key={t.id} style={{ borderBottom: '1px solid rgba(245,245,240,0.04)' }}>
                <td style={{ padding: '0.4rem 0.5rem' }}>
                  <span className={DIRECTION_COLORS[t.direction] ?? 'text-zinc-300'}>
                    {DIRECTION_LABELS[t.direction] ?? t.direction}
                  </span>
                </td>
                <td style={{ padding: '0.4rem 0.5rem', color: 'rgba(245,245,240,0.55)' }}>
                  {t.outcome_index != null ? `#${t.outcome_index}` : '—'}
                </td>
                <td style={{ padding: '0.4rem 0.5rem', textAlign: 'right', color: 'rgba(245,245,240,0.75)', fontVariantNumeric: 'tabular-nums' }}>
                  {fmtAmount(t.amount_usdc)}
                </td>
                <td style={{ padding: '0.4rem 0.5rem', color: 'rgba(245,245,240,0.4)', whiteSpace: 'nowrap' }}>
                  {formatDate(t.created_at)}
                </td>
                <td style={{ padding: '0.4rem 0.5rem' }}>
                  <a
                    href={`${EXPLORER}${t.tx_hash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: '#60a5fa', fontFamily: 'monospace', fontSize: '0.72rem' }}
                  >
                    {shortHash(t.tx_hash)}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
