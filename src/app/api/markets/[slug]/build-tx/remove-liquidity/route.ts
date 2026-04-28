import { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { buildRemoveLiquidityTxs, parseUsdcToWei, getChainId } from '@/lib/tx-builder';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const { lpAmount } = await req.json();
  if (!lpAmount) return Response.json({ error: 'Required: lpAmount' }, { status: 400 });

  const { rows } = await sql`SELECT os_index FROM markets WHERE slug = ${slug} LIMIT 1`;
  if (!rows.length || !rows[0].os_index) return Response.json({ error: 'Market not found' }, { status: 404 });

  const lpWei = parseUsdcToWei(String(lpAmount));
  return Response.json({
    transactions: buildRemoveLiquidityTxs(rows[0].os_index as `0x${string}`, lpWei),
    chainId: getChainId(),
    note: 'Burns LP tokens to withdraw your share of the pool.',
  });
}
