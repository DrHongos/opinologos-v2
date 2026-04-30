import { NextRequest } from 'next/server';
import { sql } from '@/lib/db';

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const address = req.nextUrl.searchParams.get('address');
  if (!address) return Response.json({ error: 'Missing address' }, { status: 400 });

  const { rows } = await sql.query(
    `SELECT ut.id, ut.direction, ut.outcome_index, ut.amount_usdc, ut.token_amount, ut.tx_hash, ut.created_at
     FROM user_trades ut
     JOIN markets m ON m.id = ut.market_id
     WHERE m.slug = $1 AND ut.user_address = $2
     ORDER BY ut.created_at DESC
     LIMIT 50`,
    [slug, address.toLowerCase()],
  );

  return Response.json({ trades: rows });
}
