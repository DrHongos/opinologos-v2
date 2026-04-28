import { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { buildMergePositionTxs, parseUsdcToWei, getChainId } from '@/lib/tx-builder';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const { parentLinearIdx, condition, amount } = await req.json();
  if (parentLinearIdx == null || !condition || !amount) {
    return Response.json({ error: 'Required: parentLinearIdx, condition, amount' }, { status: 400 });
  }

  const { rows } = await sql`SELECT os_index FROM markets WHERE slug = ${slug} LIMIT 1`;
  if (!rows.length || !rows[0].os_index) return Response.json({ error: 'Market not found' }, { status: 404 });

  const amountWei = parseUsdcToWei(String(amount));
  return Response.json({
    transactions: buildMergePositionTxs(rows[0].os_index as `0x${string}`, parentLinearIdx, condition as `0x${string}`, amountWei),
    chainId: getChainId(),
    note: 'Merges leaf outcome tokens back into the parent outcome.',
  });
}
