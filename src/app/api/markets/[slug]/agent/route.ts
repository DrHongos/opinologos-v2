import { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { getPublicClient } from '@/lib/oracle-client';
import {
  FPMM_ABI,
  LMSR_HOOK_ADDRESS,
  COLLATERAL_TOKEN,
  UNIVERSAL_ROUTER,
  PERMIT2_ADDRESS,
  computeImpliedPrice,
  outcomeTokenIdLocal,
} from '@/lib/contracts';
import { getChain } from '@/lib/chain';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  const { rows } = await sql`
    SELECT
      m.id, m.slug, m.question, m.description, m.end_time,
      m.os_index, m.condition_id, m.conditions,
      m.resolution_source, m.resolution_method, m.resolution_notes,
      m.oracle, m.collateral, m.hook_address,
      COALESCE(
        json_agg(json_build_object(
          'outcomeIndex', mt.outcome_index,
          'label', mt.label,
          'positionId', mt.position_id
        ) ORDER BY mt.outcome_index),
        '[]'
      ) AS outcomes
    FROM markets m
    LEFT JOIN market_tokens mt ON mt.market_id = m.id
    WHERE m.slug = ${slug}
    GROUP BY m.id
    LIMIT 1
  `;

  if (!rows.length) return Response.json({ error: 'Market not found' }, { status: 404 });
  const market = rows[0];

  const chain = getChain();
  const chainInfo = {
    id: chain.id,
    name: chain.name,
    rpcUrl: chain.rpcUrls.default.http[0],
    explorerUrl: chain.blockExplorers?.default.url ?? '',
  };

  const contracts = {
    hook: LMSR_HOOK_ADDRESS,
    collateral: COLLATERAL_TOKEN,
    universalRouter: UNIVERSAL_ROUTER,
    permit2: PERMIT2_ADDRESS,
  };

  // Live on-chain state
  let state: Record<string, unknown> = { resolved: null, balances: null, prices: null };
  if (market.os_index) {
    const osIndex = market.os_index as `0x${string}`;
    const publicClient = getPublicClient();
    const [balances, resolved] = await Promise.all([
      publicClient.readContract({
        address: LMSR_HOOK_ADDRESS, abi: FPMM_ABI,
        functionName: 'getPoolBalances', args: [osIndex],
      }).catch(() => null) as Promise<bigint[] | null>,
      publicClient.readContract({
        address: LMSR_HOOK_ADDRESS, abi: FPMM_ABI,
        functionName: 'isResolved', args: [osIndex],
      }).catch(() => null) as Promise<boolean | null>,
    ]);

    if (balances) {
      state = {
        resolved: resolved ?? false,
        balances: balances.map(b => b.toString()),
        prices: balances.map((_, i) => computeImpliedPrice(balances, i)),
      };
    }
  }

  // Compute positionIds if not already in DB
  const outcomes = (market.outcomes as { outcomeIndex: number; label: string | null; positionId: string | null }[]).map(o => ({
    ...o,
    positionId: o.positionId ?? (market.os_index
      ? outcomeTokenIdLocal(market.os_index as `0x${string}`, o.outcomeIndex).toString()
      : null),
  }));

  const baseUrl = `${process.env.NEXT_PUBLIC_BASE_URL ?? ''}/api/markets/${slug}/build-tx`;
  const actions = [
    { name: 'trade', method: 'POST', endpoint: `${baseUrl}/trade`, params: '{ from, outcomeIndex, direction: "buy"|"sell", amountUsdc }' },
    { name: 'split_collateral', method: 'POST', endpoint: `${baseUrl}/split-collateral`, params: '{ amountUsdc }' },
    { name: 'merge_collateral', method: 'POST', endpoint: `${baseUrl}/merge-collateral`, params: '{ amountUsdc }' },
    { name: 'split_position', method: 'POST', endpoint: `${baseUrl}/split-position`, params: '{ parentLinearIdx, condition, amount }' },
    { name: 'merge_position', method: 'POST', endpoint: `${baseUrl}/merge-position`, params: '{ parentLinearIdx, condition, amount }' },
    { name: 'redeem', method: 'POST', endpoint: `${baseUrl}/redeem`, params: '{}' },
    { name: 'add_liquidity', method: 'POST', endpoint: `${baseUrl}/add-liquidity`, params: '{ amountUsdc }' },
    { name: 'remove_liquidity', method: 'POST', endpoint: `${baseUrl}/remove-liquidity`, params: '{ lpAmount }' },
    { name: 'withdraw_fees', method: 'POST', endpoint: `${baseUrl}/withdraw-fees`, params: '{}' },
  ];

  return Response.json({
    market: {
      slug: market.slug,
      question: market.question,
      description: market.description,
      endTime: market.end_time ? Math.floor(new Date(market.end_time).getTime() / 1000) : null,
      osIndex: market.os_index,
      conditionId: market.condition_id,
      conditions: market.conditions ?? [],
      resolution: {
        source: market.resolution_source,
        method: market.resolution_method,
        notes: market.resolution_notes,
      },
      outcomes,
      chain: chainInfo,
      contracts,
    },
    state,
    actions,
  });
}
