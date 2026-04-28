import { NextRequest } from 'next/server';
import { sql } from '@/lib/db';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  const { rows } = await sql`
    SELECT
      ae.id,
      ae.created_at,
      ae.event_type,
      ae.confidence,
      ae.reasoning,
      ae.sources,
      ae.payouts,
      ae.tx_hash,
      ae.trade_amount_usdc,
      ae.probability_delta
    FROM agent_events ae
    JOIN markets m ON m.id = ae.market_id
    WHERE m.slug = ${slug}
    ORDER BY ae.created_at DESC
    LIMIT 100
  `;

  return Response.json({ events: rows });
}
