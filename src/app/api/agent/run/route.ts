import { NextRequest } from 'next/server';
import { keccak256 } from 'viem';
import { sql, insertAgentEvent, insertPriceSnapshots, initSchema } from '@/lib/db';
import { getOracleWalletClient, getPublicClient } from '@/lib/oracle-client';
import { executeNudgeTrade, computeTradeSize, MAX_TRADE_WEI, PROB_THRESHOLD } from '@/lib/agent-swap';
import { FPMM_ABI, LMSR_HOOK_ADDRESS, computeImpliedPrice } from '@/lib/contracts';
import { getChain } from '@/lib/chain';
import { formatUnits } from 'viem';

const RESOLUTION_CONFIDENCE = 80;
const NUDGE_CONFIDENCE = 60;
const MARKET_LIMIT = 20;

interface MarketRow {
  id: string;
  slug: string;
  question: string;
  question_cid: string;
  description: string | null;
  end_time: string | null;
  os_index: string;
  resolution_source: string | null;
  resolution_method: string | null;
  resolution_notes: string | null;
  outcomes: { outcomeIndex: number; label: string | null }[];
}

interface ResearchResult {
  resolvable: boolean;
  confidence: number;
  winningOutcomeIndex: number | null;
  payouts: number[];
  reasoning: string;
  sources: string[];
}

async function fetchSimpleMarkets(): Promise<MarketRow[]> {
  const { rows } = await sql`
    SELECT
      m.id, m.slug, m.question, m.question_cid, m.description,
      m.end_time, m.os_index,
      m.resolution_source, m.resolution_method, m.resolution_notes,
      COALESCE(
        json_agg(json_build_object('outcomeIndex', mt.outcome_index, 'label', mt.label)
          ORDER BY mt.outcome_index),
        '[]'
      ) AS outcomes
    FROM markets m
    LEFT JOIN market_tokens mt ON mt.market_id = m.id
    WHERE m.os_index IS NOT NULL
      AND (m.conditions IS NULL OR jsonb_array_length(m.conditions) = 0)
    GROUP BY m.id
    ORDER BY m.end_time ASC NULLS LAST
    LIMIT ${MARKET_LIMIT}
  `;
  return rows as MarketRow[];
}

async function researchMarket(market: MarketRow, baseUrl: string): Promise<ResearchResult | null> {
  try {
    const res = await fetch(`${baseUrl}/api/admin/research-resolution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: market.question,
        description: market.description,
        outcomes: market.outcomes.map(o => ({ id: o.outcomeIndex, label: o.label ?? String(o.outcomeIndex) })),
        resolution: {
          source: market.resolution_source,
          method: market.resolution_method,
          notes: market.resolution_notes,
        },
        endTime: market.end_time ? Math.floor(new Date(market.end_time).getTime() / 1000) : undefined,
      }),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

function getBaseUrl(req: NextRequest): string {
  const host = req.headers.get('host') ?? 'localhost:3000';
  const proto = host.startsWith('localhost') ? 'http' : 'https';
  return `${proto}://${host}`;
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  await initSchema();

  const baseUrl = getBaseUrl(req);
  const markets = await fetchSimpleMarkets();

  const walletClient = getOracleWalletClient();
  const publicClient = getPublicClient();
  const chain = getChain();

  const log: {
    resolved: string[];
    nudged: string[];
    skipped: string[];
    errors: string[];
  } = { resolved: [], nudged: [], skipped: [], errors: [] };

  for (const market of markets) {
    try {
      // Skip if already resolved on-chain
      const alreadyResolved = await publicClient.readContract({
        address: LMSR_HOOK_ADDRESS,
        abi: FPMM_ABI,
        functionName: 'isResolved',
        args: [market.os_index as `0x${string}`],
      }).catch(() => false) as boolean;
      if (alreadyResolved) continue;

      const research = await researchMarket(market, baseUrl);
      if (!research) {
        log.errors.push(market.slug);
        continue;
      }

      // ── Resolution path ──────────────────────────────────────────────────
      if (research.resolvable && research.confidence >= RESOLUTION_CONFIDENCE) {
        const questionId = keccak256(new TextEncoder().encode(market.question_cid));
        const payouts = research.payouts.map(BigInt);

        const hash = await walletClient.writeContract({
          address: LMSR_HOOK_ADDRESS,
          abi: FPMM_ABI,
          functionName: 'reportPayouts',
          args: [questionId, payouts],
          account: walletClient.account!,
          chain,
        });
        await publicClient.waitForTransactionReceipt({ hash });

        await insertAgentEvent(market.id, 'resolved', {
          confidence: research.confidence,
          reasoning: research.reasoning,
          sources: research.sources,
          payouts: research.payouts,
          txHash: hash,
        });
        log.resolved.push(market.slug);
        continue;
      }

      // ── Nudge path ────────────────────────────────────────────────────────
      if (
        research.confidence >= NUDGE_CONFIDENCE &&
        research.winningOutcomeIndex != null
      ) {
        const balances = await publicClient.readContract({
          address: LMSR_HOOK_ADDRESS,
          abi: FPMM_ABI,
          functionName: 'getPoolBalances',
          args: [market.os_index as `0x${string}`],
        }).catch(() => null) as bigint[] | null;

        if (balances && balances.length > 0) {
          const outcomeIdx = research.winningOutcomeIndex;
          const currentProb = computeImpliedPrice(balances, outcomeIdx);
          const targetProb = research.payouts[outcomeIdx] / research.payouts.reduce((a, b) => a + b, 0);
          const delta = Math.abs(currentProb - targetProb);

          if (delta > PROB_THRESHOLD && targetProb > currentProb) {
            const tradeWei = await computeTradeSize(
              publicClient,
              market.os_index as `0x${string}`,
              balances,
              outcomeIdx,
              targetProb,
              MAX_TRADE_WEI,
            );

            if (tradeWei > 0n) {
              const hash = await executeNudgeTrade(
                walletClient,
                publicClient,
                market.os_index as `0x${string}`,
                outcomeIdx,
                tradeWei,
              );

              const tradeUsdc = parseFloat(formatUnits(tradeWei, 18));
              await insertAgentEvent(market.id, 'nudged', {
                confidence: research.confidence,
                reasoning: research.reasoning,
                sources: research.sources,
                txHash: hash,
                tradeAmountUsdc: tradeUsdc,
                probabilityDelta: delta,
              });

              // Record post-trade price snapshot for history chart
              const postBals = await publicClient.readContract({
                address: LMSR_HOOK_ADDRESS,
                abi: FPMM_ABI,
                functionName: 'getPoolBalances',
                args: [market.os_index as `0x${string}`],
              }).catch(() => null) as bigint[] | null;
              if (postBals) {
                await insertPriceSnapshots(
                  market.id,
                  postBals.map((_, i) => ({ outcomeIndex: i, price: computeImpliedPrice(postBals, i) })),
                ).catch(() => {});
              }

              log.nudged.push(market.slug);
              continue;
            }
          }
        }
      }

      // ── Skip ──────────────────────────────────────────────────────────────
      await insertAgentEvent(market.id, 'skipped', {
        confidence: research.confidence,
        reasoning: research.reasoning,
        sources: research.sources,
      });
      log.skipped.push(market.slug);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await insertAgentEvent(market.id, 'error', { reasoning: msg }).catch(() => {});
      log.errors.push(`${market.slug}: ${msg}`);
    }
  }

  return Response.json({
    processed: markets.length,
    ...log,
  });
}
