import Link from 'next/link';
import { notFound } from 'next/navigation';
import { WalletButton } from '@/components/wallet-button';
import { MarketGraph } from '@/components/market-graph';
import { CidRow } from '@/components/cid-row';
import { MarketStatus } from '@/components/market-status';

interface Outcome {
  outcomeIndex: number;
  label: string | null;
  tokenAddress: string;
  positionId: string | null;
}

interface ConditionInfo {
  id: string;
  slots: number;
}

interface MarketData {
  id: string;
  slug: string;
  question: string;
  description: string | null;
  end_time: string | null;
  oracle: string | null;
  collateral: string | null;
  os_index: string;
  shares_token: string;
  condition_id: string;
  conditions: ConditionInfo[];
  lmsr_b: string | null;
  outcomes: Outcome[];
  resolution_source: string | null;
  market_cid: string | null;
}

async function fetchMarket(slug: string): Promise<MarketData | null> {
  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

  const res = await fetch(`${baseUrl}/api/markets/${slug}`, { cache: 'no-store' });
  if (!res.ok) return null;
  const data = await res.json();
  return data.market ?? null;
}

function timeUntil(iso: string | null): string {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'Closed';
  const days = Math.floor(diff / 86_400_000);
  if (days > 365) return `${Math.floor(days / 365)}y`;
  if (days > 30) return `${Math.floor(days / 30)}mo`;
  if (days > 1) return `${days}d`;
  const hours = Math.floor(diff / 3_600_000);
  return hours > 0 ? `${hours}h` : '<1h';
}

export default async function MarketDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const market = await fetchMarket(slug);

  if (!market) notFound();

  const isSimple = market.conditions.length === 1;
  const timeLeft = timeUntil(market.end_time);

  return (
    <div className="md-page">
      <header className="md-header">
        <div className="md-header__left">
          <Link href="/markets" className="md-header__back">← Markets</Link>
          <span className="md-header__sep">/</span>
          <span className="md-header__crumb">{market.slug}</span>
        </div>
        <WalletButton />
      </header>

      <section className="md-hero">
        <div className="md-hero__meta">
          <span className="md-badge">{isSimple ? 'Simple' : `Mixed · ${market.conditions.length} conditions`}</span>
          <span className={`md-badge md-badge--time${timeLeft === 'Closed' ? ' md-badge--closed' : ''}`}>
            {timeLeft}
          </span>
          {market.resolution_source && (
            <span className="md-badge md-badge--muted">{market.resolution_source}</span>
          )}
        </div>

        <h1 className="md-hero__question">{market.question}</h1>

        {market.description && (
          <p className="md-hero__desc">{market.description}</p>
        )}

        {market.market_cid && (
          <CidRow cid={market.market_cid} />
        )}
      </section>

      <div className="md-status-wrap">
        <MarketStatus
          osIndex={market.os_index}
          conditions={market.conditions}
          outcomes={market.outcomes}
        />
      </div>

      <div className="md-graph-wrap">
        <MarketGraph market={market} />
      </div>
    </div>
  );
}
