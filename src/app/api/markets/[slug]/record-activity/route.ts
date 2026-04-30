import { NextRequest } from 'next/server';
import { sql, insertUserTrade, insertPriceSnapshots } from '@/lib/db';

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const body = await req.json();
  const { txHash, userAddress, direction, outcomeIndex, amountUsdc, tokenAmount, prices } = body;

  if (!txHash || !userAddress || !direction || amountUsdc == null) {
    return Response.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const { rows } = await sql.query('SELECT id FROM markets WHERE slug = $1 LIMIT 1', [slug]);
  if (rows.length === 0) return Response.json({ error: 'Market not found' }, { status: 404 });
  const marketId = rows[0].id;

  await insertUserTrade(marketId, {
    userAddress,
    direction,
    outcomeIndex: outcomeIndex ?? null,
    amountUsdc: String(amountUsdc),
    tokenAmount: tokenAmount ?? null,
    txHash,
  });

  if (Array.isArray(prices) && prices.length > 0) {
    await insertPriceSnapshots(
      marketId,
      prices.map((p: number, i: number) => ({ outcomeIndex: i, price: p })),
    );
  }

  return Response.json({ ok: true });
}
