import { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { getPublicClient } from '@/lib/oracle-client';
import { FPMM_ABI, LMSR_HOOK_ADDRESS } from '@/lib/contracts';
import { buildTradeTxs, parseUsdcToWei, getChainId } from '@/lib/tx-builder';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const { from, outcomeIndex, direction, amountUsdc } = await req.json();

  if (!from || outcomeIndex == null || !direction || !amountUsdc) {
    return Response.json({ error: 'Required: from, outcomeIndex, direction, amountUsdc' }, { status: 400 });
  }

  const { rows } = await sql`SELECT os_index FROM markets WHERE slug = ${slug} LIMIT 1`;
  if (!rows.length || !rows[0].os_index) {
    return Response.json({ error: 'Market not found or not deployed' }, { status: 404 });
  }
  const osIndex = rows[0].os_index as `0x${string}`;

  const publicClient = getPublicClient();
  const feeSlot = await publicClient.readContract({
    address: LMSR_HOOK_ADDRESS,
    abi: FPMM_ABI,
    functionName: 'outcomeFeeSlot',
    args: [osIndex, outcomeIndex],
  }) as unknown as bigint;

  const amountWei = parseUsdcToWei(String(amountUsdc));
  const transactions = buildTradeTxs(Number(feeSlot), from as `0x${string}`, direction, amountWei);

  return Response.json({
    transactions,
    chainId: getChainId(),
    note: 'Submit transactions in order. Optional transactions can be skipped if allowance is already sufficient.',
  });
}
