import { notFound } from 'next/navigation';
import Link from 'next/link';
import { WalletButton } from '@/components/wallet-button';
import { MarketGraph } from '@/components/market-graph';
import { CidRow } from '@/components/cid-row';
import { MarketStatus } from '@/components/market-status';
import { AgentHistory } from '@/components/agent-history';
import { sql } from '@/lib/db';

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
  try {
    const result = await sql.query(
      `SELECT
         id, slug, question, description, end_time, oracle,
         collateral, hook_address, lmsr_b,
         resolution_source, resolution_method, resolution_notes,
         question_cid, market_cid, os_index, shares_token, condition_id,
         conditions, created_at
       FROM markets
       WHERE slug = $1
       LIMIT 1`,
      [slug],
    );

    if (result.rows.length === 0) return null;

    const market = result.rows[0];

    const tokensResult = await sql.query(
      `SELECT outcome_index, label, token_address, position_id
       FROM market_tokens
       WHERE market_id = $1
       ORDER BY outcome_index`,
      [market.id],
    );

    const outcomes = tokensResult.rows.map((r: Record<string, unknown>) => ({
      outcomeIndex: r.outcome_index,
      label: r.label,
      tokenAddress: r.token_address,
      positionId: r.position_id,
    }));

    let conditions: Array<{ id: string; slots: number; os_index?: string | null }> =
      market.conditions ?? [{ id: market.condition_id, slots: outcomes.length || 2 }];

    if (conditions.length > 1) {
      const condIds = conditions.map((c: { id: string }) => c.id);
      const srcRes = await sql.query(
        `SELECT condition_id, os_index FROM markets WHERE condition_id = ANY($1)`,
        [condIds],
      );
      const srcOsMap: Record<string, string> = {};
      for (const row of srcRes.rows) srcOsMap[row.condition_id] = row.os_index;
      conditions = conditions.map(c => ({ ...c, os_index: srcOsMap[c.id] ?? null }));
    }

    return { ...market, outcomes, conditions };
  } catch {
    return null;
  }
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

      <div className="md-status-wrap">
        <AgentHistory slug={slug} />
      </div>
    </div>
  );
}
