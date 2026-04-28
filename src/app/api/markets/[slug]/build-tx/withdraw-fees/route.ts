import { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { buildWithdrawFeesTxs, getChainId } from '@/lib/tx-builder';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const { rows } = await sql`SELECT os_index FROM markets WHERE slug = ${slug} LIMIT 1`;
  if (!rows.length || !rows[0].os_index) return Response.json({ error: 'Market not found' }, { status: 404 });

  return Response.json({
    transactions: buildWithdrawFeesTxs(rows[0].os_index as `0x${string}`),
    chainId: getChainId(),
    note: 'Withdraws trading fees earned as a liquidity provider.',
  });
}
