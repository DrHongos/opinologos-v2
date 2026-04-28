import { NextRequest } from 'next/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { sql } from '@/lib/db';
import { getPublicClient } from '@/lib/oracle-client';
import { FPMM_ABI, LMSR_HOOK_ADDRESS, computeImpliedPrice } from '@/lib/contracts';
import {
  buildTradeTxs, buildSplitCollateralTxs, buildMergeCollateralTxs,
  buildSplitPositionTxs, buildMergePositionTxs, buildRedeemTxs,
  buildAddLiquidityTxs, buildRemoveLiquidityTxs, buildWithdrawFeesTxs,
  parseUsdcToWei, getChainId,
} from '@/lib/tx-builder';

// ── Server factory (stateless per-request) ────────────────────────────────────

function createMcpServer() {
  const server = new McpServer({
    name: 'declareindependence-markets',
    version: '1.0.0',
  });

  // ── list_markets ──────────────────────────────────────────────────────────
  server.tool(
    'list_markets',
    'Search and list prediction markets. Returns slugs, questions, end times, and current resolution status.',
    {
      query:   z.string().optional().describe('Full-text search query'),
      topic:   z.string().optional().describe('Filter by topic (e.g. "politics", "crypto")'),
      entity:  z.string().optional().describe('Filter by entity (e.g. "Trump", "Bitcoin")'),
      limit:   z.number().int().min(1).max(50).optional().describe('Max results (default 10)'),
    },
    async ({ query, topic, entity, limit = 10 }) => {
      let rows;
      if (query) {
        const result = await sql`
          SELECT slug, question, end_time, os_index
          FROM markets
          WHERE search_vector @@ plainto_tsquery('english', ${query})
          ORDER BY end_time ASC NULLS LAST
          LIMIT ${limit}
        `;
        rows = result.rows;
      } else if (topic) {
        const result = await sql`
          SELECT slug, question, end_time, os_index
          FROM markets
          WHERE ${topic} = ANY(attention_topics)
          ORDER BY end_time ASC NULLS LAST
          LIMIT ${limit}
        `;
        rows = result.rows;
      } else if (entity) {
        const result = await sql`
          SELECT slug, question, end_time, os_index
          FROM markets
          WHERE ${entity} = ANY(attention_entities)
          ORDER BY end_time ASC NULLS LAST
          LIMIT ${limit}
        `;
        rows = result.rows;
      } else {
        const result = await sql`
          SELECT slug, question, end_time, os_index
          FROM markets
          ORDER BY end_time ASC NULLS LAST
          LIMIT ${limit}
        `;
        rows = result.rows;
      }
      return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
    },
  );

  // ── read_market ───────────────────────────────────────────────────────────
  server.tool(
    'read_market',
    'Read full market spec and live on-chain state (prices, balances, resolved status). Use this before building transactions.',
    { slug: z.string().describe('Market slug (e.g. "will-bitcoin-reach-100k-by-2025")') },
    async ({ slug }) => {
      const { rows } = await sql`
        SELECT m.*, COALESCE(json_agg(json_build_object(
          'outcomeIndex', mt.outcome_index, 'label', mt.label, 'positionId', mt.position_id
        ) ORDER BY mt.outcome_index), '[]') AS outcomes
        FROM markets m
        LEFT JOIN market_tokens mt ON mt.market_id = m.id
        WHERE m.slug = ${slug}
        GROUP BY m.id LIMIT 1
      `;
      if (!rows.length) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Not found' }) }] };

      const market = rows[0];
      let state = null;
      if (market.os_index) {
        const pc = getPublicClient();
        const [balances, resolved] = await Promise.all([
          pc.readContract({ address: LMSR_HOOK_ADDRESS, abi: FPMM_ABI, functionName: 'getPoolBalances', args: [market.os_index] }).catch(() => null),
          pc.readContract({ address: LMSR_HOOK_ADDRESS, abi: FPMM_ABI, functionName: 'isResolved', args: [market.os_index] }).catch(() => null),
        ]) as [bigint[] | null, boolean | null];
        if (balances) {
          state = {
            resolved: resolved ?? false,
            balances: balances.map(b => b.toString()),
            prices: balances.map((_, i) => computeImpliedPrice(balances, i)),
          };
        }
      }

      return { content: [{ type: 'text', text: JSON.stringify({ market, state }) }] };
    },
  );

  // ── get_price ─────────────────────────────────────────────────────────────
  server.tool(
    'get_price',
    'Get current FPMM implied probability for market outcomes. Returns probabilities 0-1 per outcome index.',
    {
      slug: z.string(),
      outcomeIndex: z.number().int().optional().describe('Specific outcome index, or omit for all'),
    },
    async ({ slug, outcomeIndex }) => {
      const { rows } = await sql`SELECT os_index FROM markets WHERE slug = ${slug} LIMIT 1`;
      if (!rows.length || !rows[0].os_index) return { content: [{ type: 'text', text: '{"error":"Market not found"}' }] };

      const pc = getPublicClient();
      const balances = await pc.readContract({
        address: LMSR_HOOK_ADDRESS, abi: FPMM_ABI,
        functionName: 'getPoolBalances', args: [rows[0].os_index],
      }).catch(() => null) as bigint[] | null;

      if (!balances) return { content: [{ type: 'text', text: '{"error":"Could not read pool balances"}' }] };

      const prices = balances.map((_, i) => ({ outcomeIndex: i, probability: computeImpliedPrice(balances, i) }));
      const result = outcomeIndex != null ? prices[outcomeIndex] : prices;
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ── build_trade_tx ────────────────────────────────────────────────────────
  server.tool(
    'build_trade_tx',
    'Build unsigned transactions to buy or sell outcome tokens via the FPMM. Returns a sequence of EVM transactions to sign and submit in order.',
    {
      slug: z.string(),
      outcomeIndex: z.number().int().describe('Outcome index to trade'),
      direction: z.enum(['buy', 'sell']),
      amountUsdc: z.string().describe('Amount in USDC (e.g. "5.0")'),
      from: z.string().describe('Sender address (0x...)'),
    },
    async ({ slug, outcomeIndex, direction, amountUsdc, from }) => {
      const { rows } = await sql`SELECT os_index FROM markets WHERE slug = ${slug} LIMIT 1`;
      if (!rows.length || !rows[0].os_index) return { content: [{ type: 'text', text: '{"error":"Market not found"}' }] };

      const pc = getPublicClient();
      const feeSlot = await pc.readContract({
        address: LMSR_HOOK_ADDRESS, abi: FPMM_ABI,
        functionName: 'outcomeFeeSlot', args: [rows[0].os_index, outcomeIndex],
      }) as unknown as bigint;

      const txs = buildTradeTxs(Number(feeSlot), from as `0x${string}`, direction, parseUsdcToWei(amountUsdc));
      return { content: [{ type: 'text', text: JSON.stringify({ transactions: txs, chainId: getChainId() }) }] };
    },
  );

  // ── build_split_collateral_tx ─────────────────────────────────────────────
  server.tool(
    'build_split_collateral_tx',
    'Build unsigned transactions to split collateral into equal amounts of all outcome tokens.',
    { slug: z.string(), amountUsdc: z.string(), from: z.string() },
    async ({ slug, amountUsdc }) => {
      const { rows } = await sql`SELECT os_index FROM markets WHERE slug = ${slug} LIMIT 1`;
      if (!rows.length || !rows[0].os_index) return { content: [{ type: 'text', text: '{"error":"Market not found"}' }] };
      const txs = buildSplitCollateralTxs(rows[0].os_index, parseUsdcToWei(amountUsdc));
      return { content: [{ type: 'text', text: JSON.stringify({ transactions: txs, chainId: getChainId() }) }] };
    },
  );

  // ── build_merge_collateral_tx ─────────────────────────────────────────────
  server.tool(
    'build_merge_collateral_tx',
    'Build unsigned transactions to merge equal amounts of all outcome tokens back into collateral.',
    { slug: z.string(), amountUsdc: z.string(), from: z.string() },
    async ({ slug, amountUsdc }) => {
      const { rows } = await sql`SELECT os_index FROM markets WHERE slug = ${slug} LIMIT 1`;
      if (!rows.length || !rows[0].os_index) return { content: [{ type: 'text', text: '{"error":"Market not found"}' }] };
      const txs = buildMergeCollateralTxs(rows[0].os_index, parseUsdcToWei(amountUsdc));
      return { content: [{ type: 'text', text: JSON.stringify({ transactions: txs, chainId: getChainId() }) }] };
    },
  );

  // ── build_split_position_tx ───────────────────────────────────────────────
  server.tool(
    'build_split_position_tx',
    'Build unsigned transactions to split a parent outcome position into leaf outcomes of a deeper condition. Used for conditional entry strategies in mixed markets.',
    {
      slug: z.string(),
      parentLinearIdx: z.number().int().describe('Parent outcome index to split (e.g. 0 = first outcome)'),
      condition: z.string().describe('Condition ID (bytes32 hex) of the deeper condition to split into'),
      amount: z.string().describe('Amount of parent outcome tokens to split (in units, e.g. "10.0")'),
      from: z.string(),
    },
    async ({ slug, parentLinearIdx, condition, amount }) => {
      const { rows } = await sql`SELECT os_index FROM markets WHERE slug = ${slug} LIMIT 1`;
      if (!rows.length || !rows[0].os_index) return { content: [{ type: 'text', text: '{"error":"Market not found"}' }] };
      const txs = buildSplitPositionTxs(rows[0].os_index, parentLinearIdx, condition as `0x${string}`, parseUsdcToWei(amount));
      return { content: [{ type: 'text', text: JSON.stringify({ transactions: txs, chainId: getChainId() }) }] };
    },
  );

  // ── build_merge_position_tx ───────────────────────────────────────────────
  server.tool(
    'build_merge_position_tx',
    'Build unsigned transactions to merge leaf outcome positions back into a parent outcome. Reverse of split_position.',
    {
      slug: z.string(),
      parentLinearIdx: z.number().int(),
      condition: z.string().describe('Condition ID (bytes32 hex)'),
      amount: z.string(),
      from: z.string(),
    },
    async ({ slug, parentLinearIdx, condition, amount }) => {
      const { rows } = await sql`SELECT os_index FROM markets WHERE slug = ${slug} LIMIT 1`;
      if (!rows.length || !rows[0].os_index) return { content: [{ type: 'text', text: '{"error":"Market not found"}' }] };
      const txs = buildMergePositionTxs(rows[0].os_index, parentLinearIdx, condition as `0x${string}`, parseUsdcToWei(amount));
      return { content: [{ type: 'text', text: JSON.stringify({ transactions: txs, chainId: getChainId() }) }] };
    },
  );

  // ── build_redeem_tx ───────────────────────────────────────────────────────
  server.tool(
    'build_redeem_tx',
    'Build unsigned transactions to redeem winning outcome tokens for collateral after the market is resolved.',
    { slug: z.string(), from: z.string() },
    async ({ slug }) => {
      const { rows } = await sql`SELECT os_index FROM markets WHERE slug = ${slug} LIMIT 1`;
      if (!rows.length || !rows[0].os_index) return { content: [{ type: 'text', text: '{"error":"Market not found"}' }] };
      return { content: [{ type: 'text', text: JSON.stringify({ transactions: buildRedeemTxs(rows[0].os_index), chainId: getChainId() }) }] };
    },
  );

  // ── build_add_liquidity_tx ────────────────────────────────────────────────
  server.tool(
    'build_add_liquidity_tx',
    'Build unsigned transactions to add collateral as liquidity to a market pool. You receive LP tokens.',
    { slug: z.string(), amountUsdc: z.string(), from: z.string() },
    async ({ slug, amountUsdc }) => {
      const { rows } = await sql`SELECT os_index FROM markets WHERE slug = ${slug} LIMIT 1`;
      if (!rows.length || !rows[0].os_index) return { content: [{ type: 'text', text: '{"error":"Market not found"}' }] };
      return { content: [{ type: 'text', text: JSON.stringify({ transactions: buildAddLiquidityTxs(rows[0].os_index, parseUsdcToWei(amountUsdc)), chainId: getChainId() }) }] };
    },
  );

  // ── build_remove_liquidity_tx ─────────────────────────────────────────────
  server.tool(
    'build_remove_liquidity_tx',
    'Build unsigned transactions to burn LP tokens and withdraw your share of the market pool.',
    { slug: z.string(), lpAmount: z.string(), from: z.string() },
    async ({ slug, lpAmount }) => {
      const { rows } = await sql`SELECT os_index FROM markets WHERE slug = ${slug} LIMIT 1`;
      if (!rows.length || !rows[0].os_index) return { content: [{ type: 'text', text: '{"error":"Market not found"}' }] };
      return { content: [{ type: 'text', text: JSON.stringify({ transactions: buildRemoveLiquidityTxs(rows[0].os_index, parseUsdcToWei(lpAmount)), chainId: getChainId() }) }] };
    },
  );

  // ── build_withdraw_fees_tx ────────────────────────────────────────────────
  server.tool(
    'build_withdraw_fees_tx',
    'Build unsigned transactions to withdraw trading fees earned as a liquidity provider.',
    { slug: z.string(), from: z.string() },
    async ({ slug }) => {
      const { rows } = await sql`SELECT os_index FROM markets WHERE slug = ${slug} LIMIT 1`;
      if (!rows.length || !rows[0].os_index) return { content: [{ type: 'text', text: '{"error":"Market not found"}' }] };
      return { content: [{ type: 'text', text: JSON.stringify({ transactions: buildWithdrawFeesTxs(rows[0].os_index), chainId: getChainId() }) }] };
    },
  );

  return server;
}

// ── Next.js route handlers ─────────────────────────────────────────────────

function makeTransport() {
  return new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });
}

export async function POST(req: NextRequest) {
  const transport = makeTransport();
  const server = createMcpServer();
  await server.connect(transport);
  return transport.handleRequest(req);
}

export async function GET(req: NextRequest) {
  const transport = makeTransport();
  const server = createMcpServer();
  await server.connect(transport);
  return transport.handleRequest(req);
}

export async function DELETE(req: NextRequest) {
  const transport = makeTransport();
  const server = createMcpServer();
  await server.connect(transport);
  return transport.handleRequest(req);
}
