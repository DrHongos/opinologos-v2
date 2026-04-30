import { NextRequest } from 'next/server';
import { sql } from '@/lib/db';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const { rows } = await sql.query(
    `SELECT mps.outcome_index, mps.price, mps.recorded_at
     FROM market_price_snapshots mps
     JOIN markets m ON m.id = mps.market_id
     WHERE m.slug = $1
     ORDER BY mps.recorded_at ASC`,
    [slug],
  );

  return Response.json({
    snapshots: rows.map(r => ({
      outcomeIndex: Number(r.outcome_index),
      price: parseFloat(r.price),
      recordedAt: r.recorded_at,
    })),
  });
}
