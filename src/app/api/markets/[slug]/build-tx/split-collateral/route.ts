import { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { buildSplitCollateralTxs, parseUsdcToWei, getChainId } from '@/lib/tx-builder';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const { amountUsdc } = await req.json();
  if (!amountUsdc) return Response.json({ error: 'Required: amountUsdc' }, { status: 400 });

  const { rows } = await sql`SELECT os_index FROM markets WHERE slug = ${slug} LIMIT 1`;
  if (!rows.length || !rows[0].os_index) return Response.json({ error: 'Market not found' }, { status: 404 });

  const amountWei = parseUsdcToWei(String(amountUsdc));
  return Response.json({
    transactions: buildSplitCollateralTxs(rows[0].os_index as `0x${string}`, amountWei),
    chainId: getChainId(),
    note: 'You will receive equal amounts of each outcome token.',
  });
}
