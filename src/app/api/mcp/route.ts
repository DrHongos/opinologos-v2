import { NextRequest } from 'next/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { sql } from '@/lib/db';
import { getPublicClient } from '@/lib/oracle-client';
import { FPMM_ABI, LMSR_HOOK_ADDRESS, computeImpliedPrice, outcomeTokenIdLocal, lpTokenIdLocal } from '@/lib/contracts';
import {
  buildTradeTxs, buildSplitCollateralTxs, buildMergeCollateralTxs,
  buildSplitPositionTxs, buildMergePositionTxs, buildRedeemTxs,
  buildAddLiquidityTxs, buildRemoveLiquidityTxs, buildWithdrawFeesTxs,
  parseUsdcToWei, getChainId,
} from '@/lib/tx-builder';

const ERC6909_ALLOWANCE_ABI = [{
  name: 'allowance',
  type: 'function',
  inputs: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'id', type: 'uint256' },
  ],
  outputs: [{ name: '', type: 'uint256' }],
  stateMutability: 'view',
}] as const;

// ── Server factory (stateless per-request) ────────────────────────────────────

function createMcpServer() {
  const server = new McpServer({
    name: 'declareindependence-markets',
    version: '1.0.0',
  });

  // ── list_markets ──────────────────────────────────────────────────────────
  server.registerTool(
    'list_markets',
    {
      description: 'Search and list prediction markets. Returns slugs, questions, end times, and current resolution status.',
      inputSchema: {
        query:   z.string().optional().describe('Full-text search query'),
        topic:   z.string().optional().describe('Filter by topic (e.g. "politics", "crypto")'),
        entity:  z.string().optional().describe('Filter by entity (e.g. "Trump", "Bitcoin")'),
        limit:   z.number().int().min(1).max(50).optional().describe('Max results (default 10)'),
      },
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
  server.registerTool(
    'read_market',
    {
      description: 'Read full market spec and live on-chain state (prices, balances, resolved status). Use this before building transactions.',
      inputSchema: { slug: z.string().describe('Market slug (e.g. "will-bitcoin-reach-100k-by-2025")') },
    },
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
  server.registerTool(
    'get_price',
    {
      description: 'Get current FPMM implied probability for market outcomes. Returns probabilities 0-1 per outcome index.',
      inputSchema: {
        slug: z.string(),
        outcomeIndex: z.number().int().optional().describe('Specific outcome index, or omit for all'),
      },
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

  // ── calc_buy_amount ───────────────────────────────────────────────────────
  server.registerTool(
    'calc_buy_amount',
    {
      description: 'Simulate how many outcome tokens a user receives for a given USDC investment (after fees). Use this before building a buy transaction to show the user the expected return.',
      inputSchema: {
        slug: z.string(),
        outcomeIndex: z.number().int().describe('Outcome index (linearIdx) to buy'),
        amountUsdc: z.string().describe('Collateral to invest in USDC (e.g. "5.0")'),
      },
    },
    async ({ slug, outcomeIndex, amountUsdc }) => {
      const { rows } = await sql`SELECT os_index FROM markets WHERE slug = ${slug} LIMIT 1`;
      if (!rows.length || !rows[0].os_index) return { content: [{ type: 'text', text: '{"error":"Market not found"}' }] };
      const pc = getPublicClient();
      const result = await pc.readContract({
        address: LMSR_HOOK_ADDRESS, abi: FPMM_ABI,
        functionName: 'calcBuyAmount',
        args: [rows[0].os_index, outcomeIndex, parseUsdcToWei(amountUsdc)],
      }).catch((e: Error) => ({ error: e.message }));
      return { content: [{ type: 'text', text: JSON.stringify(typeof result === 'bigint' ? { outcomeTokens: result.toString() } : result) }] };
    },
  );

  // ── calc_sell_amount ──────────────────────────────────────────────────────
  server.registerTool(
    'calc_sell_amount',
    {
      description: 'Simulate how many outcome tokens a user must sell to receive a given USDC amount back (after fees). Use this before building a sell transaction.',
      inputSchema: {
        slug: z.string(),
        outcomeIndex: z.number().int().describe('Outcome index (linearIdx) to sell'),
        returnAmountUsdc: z.string().describe('Collateral to receive in USDC (e.g. "5.0")'),
      },
    },
    async ({ slug, outcomeIndex, returnAmountUsdc }) => {
      const { rows } = await sql`SELECT os_index FROM markets WHERE slug = ${slug} LIMIT 1`;
      if (!rows.length || !rows[0].os_index) return { content: [{ type: 'text', text: '{"error":"Market not found"}' }] };
      const pc = getPublicClient();
      const result = await pc.readContract({
        address: LMSR_HOOK_ADDRESS, abi: FPMM_ABI,
        functionName: 'calcSellAmount',
        args: [rows[0].os_index, outcomeIndex, parseUsdcToWei(returnAmountUsdc)],
      }).catch((e: Error) => ({ error: e.message }));
      return { content: [{ type: 'text', text: JSON.stringify(typeof result === 'bigint' ? { outcomeTokensRequired: result.toString() } : result) }] };
    },
  );

  // ── get_token_ids ─────────────────────────────────────────────────────────
  server.registerTool(
    'get_token_ids',
    {
      description: 'Return the ERC-6909 token IDs for outcome tokens and the LP token of a market. Use these IDs to query balanceOf on the hook contract.',
      inputSchema: {
        slug: z.string(),
        outcomeIndexes: z.array(z.number().int()).optional().describe('Outcome indexes to compute IDs for; omit for all'),
      },
    },
    async ({ slug, outcomeIndexes }) => {
      const { rows } = await sql`
        SELECT m.os_index, COALESCE(json_agg(mt.outcome_index ORDER BY mt.outcome_index), '[]') AS outcome_indexes
        FROM markets m
        LEFT JOIN market_tokens mt ON mt.market_id = m.id
        WHERE m.slug = ${slug}
        GROUP BY m.id LIMIT 1
      `;
      if (!rows.length || !rows[0].os_index) return { content: [{ type: 'text', text: '{"error":"Market not found"}' }] };

      const osIndex = rows[0].os_index as `0x${string}`;
      const indexes: number[] = outcomeIndexes ?? rows[0].outcome_indexes ?? [];
      const pc = getPublicClient();

      const [lpId, ...outcomeIds] = await Promise.all([
        pc.readContract({ address: LMSR_HOOK_ADDRESS, abi: FPMM_ABI, functionName: 'lpTokenId', args: [osIndex] }) as Promise<bigint>,
        ...indexes.map(i =>
          pc.readContract({ address: LMSR_HOOK_ADDRESS, abi: FPMM_ABI, functionName: 'outcomeTokenId', args: [osIndex, i] }) as Promise<bigint>
        ),
      ]);

      return {
        content: [{
          type: 'text', text: JSON.stringify({
            lpTokenId: lpId.toString(),
            outcomeTokenIds: indexes.map((i, idx) => ({ outcomeIndex: i, tokenId: outcomeIds[idx].toString() })),
          }),
        }],
      };
    },
  );

  // ── get_fees_withdrawable ─────────────────────────────────────────────────
  server.registerTool(
    'get_fees_withdrawable',
    {
      description: 'Return the amount of fees (in collateral wei) claimable by a liquidity provider for a given market.',
      inputSchema: {
        slug: z.string(),
        account: z.string().describe('LP wallet address (0x...)'),
      },
    },
    async ({ slug, account }) => {
      const { rows } = await sql`SELECT os_index FROM markets WHERE slug = ${slug} LIMIT 1`;
      if (!rows.length || !rows[0].os_index) return { content: [{ type: 'text', text: '{"error":"Market not found"}' }] };
      const pc = getPublicClient();
      const amount = await pc.readContract({
        address: LMSR_HOOK_ADDRESS, abi: FPMM_ABI,
        functionName: 'feesWithdrawableBy',
        args: [rows[0].os_index, account as `0x${string}`],
      }).catch(() => null) as bigint | null;
      return { content: [{ type: 'text', text: JSON.stringify(amount !== null ? { feesWei: amount.toString() } : { error: 'Read failed' }) }] };
    },
  );

  // ── check_operator ────────────────────────────────────────────────────────
  server.registerTool(
    'check_operator',
    {
      description: 'Check whether a given operator address is approved to burn outcome tokens on behalf of an owner. Sells require the hook contract to be set as operator. Also checks ERC-6909 token allowance for a specific token ID.',
      inputSchema: {
        owner: z.string().describe('Token owner address (0x...)'),
        operator: z.string().describe('Operator address to check — for sells this should be the hook contract address'),
        tokenId: z.string().optional().describe('(Optional) ERC-6909 token ID to check allowance for'),
      },
    },
    async ({ owner, operator, tokenId }) => {
      const pc = getPublicClient();
      const calls: Promise<unknown>[] = [
        pc.readContract({ address: LMSR_HOOK_ADDRESS, abi: FPMM_ABI, functionName: 'isOperator', args: [owner as `0x${string}`, operator as `0x${string}`] }),
      ];
      if (tokenId) {
        calls.push(
          pc.readContract({ address: LMSR_HOOK_ADDRESS, abi: ERC6909_ALLOWANCE_ABI, functionName: 'allowance', args: [owner as `0x${string}`, operator as `0x${string}`, BigInt(tokenId)] }),
        );
      }
      const [isOp, allowanceAmt] = await Promise.all(calls).catch(() => [null, null]);
      return {
        content: [{
          type: 'text', text: JSON.stringify({
            isOperator: isOp,
            hookAddress: LMSR_HOOK_ADDRESS,
            ...(tokenId ? { allowance: (allowanceAmt as bigint | null)?.toString() ?? null } : {}),
          }),
        }],
      };
    },
  );

  // ── get_user_positions ────────────────────────────────────────────────────
  server.registerTool(
    'get_user_positions',
    {
      description: 'Return all ERC-6909 token balances for a user in a given market: each outcome token balance and the LP token balance. Use this before planning any sell, merge, or split strategy to know what the user currently holds.',
      inputSchema: {
        slug: z.string(),
        account: z.string().describe('User wallet address (0x...)'),
      },
    },
    async ({ slug, account }) => {
      const { rows } = await sql`
        SELECT m.os_index, m.collateral,
          COALESCE(json_agg(json_build_object('outcomeIndex', mt.outcome_index, 'label', mt.label) ORDER BY mt.outcome_index), '[]') AS outcomes
        FROM markets m
        LEFT JOIN market_tokens mt ON mt.market_id = m.id
        WHERE m.slug = ${slug}
        GROUP BY m.id LIMIT 1
      `;
      if (!rows.length || !rows[0].os_index) return { content: [{ type: 'text', text: '{"error":"Market not found"}' }] };

      const { os_index: osIndex, outcomes } = rows[0];
      const pc = getPublicClient();

      const lpId = lpTokenIdLocal(osIndex as `0x${string}`);
      const outcomeTokenIds = (outcomes as { outcomeIndex: number; label: string }[]).map(o => ({
        ...o,
        tokenId: outcomeTokenIdLocal(osIndex as `0x${string}`, o.outcomeIndex),
      }));

      const [lpBalance, ...outcomeBals] = await Promise.all([
        pc.readContract({ address: LMSR_HOOK_ADDRESS, abi: FPMM_ABI, functionName: 'balanceOf', args: [account as `0x${string}`, lpId] }) as Promise<bigint>,
        ...outcomeTokenIds.map(o =>
          pc.readContract({ address: LMSR_HOOK_ADDRESS, abi: FPMM_ABI, functionName: 'balanceOf', args: [account as `0x${string}`, o.tokenId] }) as Promise<bigint>
        ),
      ]);

      return {
        content: [{
          type: 'text', text: JSON.stringify({
            lpTokenId: lpId.toString(),
            lpBalance: (lpBalance as bigint).toString(),
            outcomes: outcomeTokenIds.map((o, i) => ({
              outcomeIndex: o.outcomeIndex,
              label: o.label,
              tokenId: o.tokenId.toString(),
              balance: (outcomeBals[i] as bigint).toString(),
            })),
          }),
        }],
      };
    },
  );

  // ── get_condition_tree ────────────────────────────────────────────────────
  server.registerTool(
    'get_condition_tree',
    {
      description: 'Return the full condition structure of a mixed market: each condition\'s slot count, resolution status, and the sub-outcome-space index (subOsIndex) to use in build_split_position_tx / build_merge_position_tx. For a market with N conditions, stripping condition[i] gives subOsIndex[i] — the OS containing the remaining N-1 conditions. Use this tool first when planning any conditional entry strategy.',
      inputSchema: { slug: z.string() },
    },
    async ({ slug }) => {
      const { rows } = await sql`SELECT os_index, collateral, conditions FROM markets WHERE slug = ${slug} LIMIT 1`;
      if (!rows.length || !rows[0].os_index) return { content: [{ type: 'text', text: '{"error":"Market not found"}' }] };

      const { os_index: osIndex, collateral, conditions: conditionsJson } = rows[0];
      const pc = getPublicClient();

      let conditionIds: string[];
      if (conditionsJson && Array.isArray(conditionsJson) && conditionsJson.length > 0) {
        conditionIds = conditionsJson.map((c: { id: string } | string) => (typeof c === 'string' ? c : c.id));
      } else {
        const info = await pc.readContract({
          address: LMSR_HOOK_ADDRESS, abi: FPMM_ABI, functionName: 'getOSInfo', args: [osIndex],
        }) as [string, string[], bigint[], bigint];
        conditionIds = info[1] as string[];
      }

      if (!conditionIds.length) {
        return { content: [{ type: 'text', text: JSON.stringify({ osIndex, collateral, conditions: [] }) }] };
      }

      const results = await Promise.all(conditionIds.map(async (cId, i) => {
        const rest = conditionIds.filter((_, j) => j !== i) as `0x${string}`[];
        const [slotCount, payoutDen, subOsIndex] = await Promise.all([
          pc.readContract({ address: LMSR_HOOK_ADDRESS, abi: FPMM_ABI, functionName: 'getOutcomeSlotCount', args: [cId as `0x${string}`] }) as Promise<bigint>,
          pc.readContract({ address: LMSR_HOOK_ADDRESS, abi: FPMM_ABI, functionName: 'payoutDenominator', args: [cId as `0x${string}`] }) as Promise<bigint>,
          rest.length > 0
            ? pc.readContract({ address: LMSR_HOOK_ADDRESS, abi: FPMM_ABI, functionName: 'getOSIndex', args: [collateral as `0x${string}`, rest] }) as Promise<`0x${string}`>
            : Promise.resolve(null as unknown as `0x${string}`),
        ]);
        return { id: cId, slotCount: Number(slotCount), resolved: payoutDen > 0n, subOsIndex: subOsIndex ?? null };
      }));

      return { content: [{ type: 'text', text: JSON.stringify({ osIndex, collateral, conditions: results }) }] };
    },
  );

  // ── get_outcome_matrix ────────────────────────────────────────────────────
  server.registerTool(
    'get_outcome_matrix',
    {
      description: 'Decode each linear outcome index of a market into its per-condition slot assignments. For a market with conditions [C0(2 slots), C1(3 slots)], linearIdx 4 = C0:slot0, C1:slot2. Use this to identify which outcome indexes correspond to a desired conditional scenario (e.g. "C0 resolves to slot 1 regardless of C1").',
      inputSchema: { slug: z.string() },
    },
    async ({ slug }) => {
      const { rows } = await sql`
        SELECT m.os_index, m.collateral, m.conditions,
          COALESCE(json_agg(json_build_object('outcomeIndex', mt.outcome_index, 'label', mt.label) ORDER BY mt.outcome_index), '[]') AS outcomes
        FROM markets m
        LEFT JOIN market_tokens mt ON mt.market_id = m.id
        WHERE m.slug = ${slug}
        GROUP BY m.id LIMIT 1
      `;
      if (!rows.length || !rows[0].os_index) return { content: [{ type: 'text', text: '{"error":"Market not found"}' }] };

      const { os_index: osIndex, conditions: conditionsJson, outcomes } = rows[0];
      const pc = getPublicClient();

      let conditionIds: string[];
      if (conditionsJson && Array.isArray(conditionsJson) && conditionsJson.length > 0) {
        conditionIds = conditionsJson.map((c: { id: string } | string) => (typeof c === 'string' ? c : c.id));
      } else {
        const info = await pc.readContract({
          address: LMSR_HOOK_ADDRESS, abi: FPMM_ABI, functionName: 'getOSInfo', args: [osIndex],
        }) as [string, string[], bigint[], bigint];
        conditionIds = info[1] as string[];
      }

      const slotCounts = await Promise.all(
        conditionIds.map(cId =>
          pc.readContract({ address: LMSR_HOOK_ADDRESS, abi: FPMM_ABI, functionName: 'getOutcomeSlotCount', args: [cId as `0x${string}`] }) as Promise<bigint>
        )
      );
      const counts = slotCounts.map(s => Number(s));

      const labelMap: Record<number, string> = {};
      for (const o of outcomes as { outcomeIndex: number; label: string }[]) {
        labelMap[o.outcomeIndex] = o.label;
      }

      const totalOutcomes = counts.reduce((a, b) => a * b, 1);
      const matrix = [];
      for (let idx = 0; idx < totalOutcomes; idx++) {
        let rem = idx;
        const conditionSlots = conditionIds.map((cId, i) => {
          const slotIdx = rem % counts[i];
          rem = Math.floor(rem / counts[i]);
          return { conditionId: cId, slotIdx };
        });
        matrix.push({ linearIdx: idx, label: labelMap[idx] ?? null, conditionSlots });
      }

      return { content: [{ type: 'text', text: JSON.stringify({ osIndex, conditions: conditionIds, outcomes: matrix }) }] };
    },
  );

  // ── build_trade_tx ────────────────────────────────────────────────────────
  server.registerTool(
    'build_trade_tx',
    {
      description: 'Build unsigned transactions to buy or sell outcome tokens via the FPMM. Returns a sequence of EVM transactions to sign and submit in order. For mixed markets, prefer build_split_collateral_tx + sell unwanted outcomes over direct trades on leaf positions for better price efficiency.',
      inputSchema: {
        slug: z.string(),
        outcomeIndex: z.number().int().describe('Outcome index to trade'),
        direction: z.enum(['buy', 'sell']),
        amountUsdc: z.string().describe('Amount in USDC (e.g. "5.0")'),
        from: z.string().describe('Sender address (0x...)'),
      },
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
  server.registerTool(
    'build_split_collateral_tx',
    {
      description: 'Build unsigned transactions to split collateral into equal amounts of all outcome tokens.',
      inputSchema: { slug: z.string(), amountUsdc: z.string(), from: z.string() },
    },
    async ({ slug, amountUsdc }) => {
      const { rows } = await sql`SELECT os_index FROM markets WHERE slug = ${slug} LIMIT 1`;
      if (!rows.length || !rows[0].os_index) return { content: [{ type: 'text', text: '{"error":"Market not found"}' }] };
      const txs = buildSplitCollateralTxs(rows[0].os_index, parseUsdcToWei(amountUsdc));
      return { content: [{ type: 'text', text: JSON.stringify({ transactions: txs, chainId: getChainId() }) }] };
    },
  );

  // ── build_merge_collateral_tx ─────────────────────────────────────────────
  server.registerTool(
    'build_merge_collateral_tx',
    {
      description: 'Build unsigned transactions to merge equal amounts of all outcome tokens back into collateral.',
      inputSchema: { slug: z.string(), amountUsdc: z.string(), from: z.string() },
    },
    async ({ slug, amountUsdc }) => {
      const { rows } = await sql`SELECT os_index FROM markets WHERE slug = ${slug} LIMIT 1`;
      if (!rows.length || !rows[0].os_index) return { content: [{ type: 'text', text: '{"error":"Market not found"}' }] };
      const txs = buildMergeCollateralTxs(rows[0].os_index, parseUsdcToWei(amountUsdc));
      return { content: [{ type: 'text', text: JSON.stringify({ transactions: txs, chainId: getChainId() }) }] };
    },
  );

  // ── build_split_position_tx ───────────────────────────────────────────────
  server.registerTool(
    'build_split_position_tx',
    {
      description: 'Build unsigned transactions to split a parent outcome position into leaf outcomes of a deeper condition. Conditional entry strategy: call get_condition_tree to get the subOsIndex and condition ID for the condition you want to strip, call get_outcome_matrix to find which parentLinearIdx values match your target scenario, then split those positions and sell the leaves you do not want.',
      inputSchema: {
        slug: z.string(),
        parentLinearIdx: z.number().int().describe('Linear outcome index in the parent OS to split'),
        condition: z.string().describe('Condition ID (bytes32 hex) to split on — from get_condition_tree'),
        amount: z.string().describe('Amount of parent outcome tokens to split (in units, e.g. "10.0")'),
        from: z.string(),
      },
    },
    async ({ slug, parentLinearIdx, condition, amount }) => {
      const { rows } = await sql`SELECT os_index FROM markets WHERE slug = ${slug} LIMIT 1`;
      if (!rows.length || !rows[0].os_index) return { content: [{ type: 'text', text: '{"error":"Market not found"}' }] };
      const txs = buildSplitPositionTxs(rows[0].os_index, parentLinearIdx, condition as `0x${string}`, parseUsdcToWei(amount));
      return { content: [{ type: 'text', text: JSON.stringify({ transactions: txs, chainId: getChainId() }) }] };
    },
  );

  // ── build_merge_position_tx ───────────────────────────────────────────────
  server.registerTool(
    'build_merge_position_tx',
    {
      description: 'Build unsigned transactions to merge leaf outcome positions back into a parent outcome. Reverse of build_split_position_tx. Use get_condition_tree for the condition ID and get_user_positions to confirm the user holds the required leaf token balances before merging.',
      inputSchema: {
        slug: z.string(),
        parentLinearIdx: z.number().int(),
        condition: z.string().describe('Condition ID (bytes32 hex)'),
        amount: z.string(),
        from: z.string(),
      },
    },
    async ({ slug, parentLinearIdx, condition, amount }) => {
      const { rows } = await sql`SELECT os_index FROM markets WHERE slug = ${slug} LIMIT 1`;
      if (!rows.length || !rows[0].os_index) return { content: [{ type: 'text', text: '{"error":"Market not found"}' }] };
      const txs = buildMergePositionTxs(rows[0].os_index, parentLinearIdx, condition as `0x${string}`, parseUsdcToWei(amount));
      return { content: [{ type: 'text', text: JSON.stringify({ transactions: txs, chainId: getChainId() }) }] };
    },
  );

  // ── build_redeem_tx ───────────────────────────────────────────────────────
  server.registerTool(
    'build_redeem_tx',
    {
      description: 'Build unsigned transactions to redeem winning outcome tokens for collateral after the market is resolved.',
      inputSchema: { slug: z.string(), from: z.string() },
    },
    async ({ slug }) => {
      const { rows } = await sql`SELECT os_index FROM markets WHERE slug = ${slug} LIMIT 1`;
      if (!rows.length || !rows[0].os_index) return { content: [{ type: 'text', text: '{"error":"Market not found"}' }] };
      return { content: [{ type: 'text', text: JSON.stringify({ transactions: buildRedeemTxs(rows[0].os_index), chainId: getChainId() }) }] };
    },
  );

  // ── build_add_liquidity_tx ────────────────────────────────────────────────
  server.registerTool(
    'build_add_liquidity_tx',
    {
      description: 'Build unsigned transactions to add collateral as liquidity to a market pool. You receive LP tokens.',
      inputSchema: { slug: z.string(), amountUsdc: z.string(), from: z.string() },
    },
    async ({ slug, amountUsdc }) => {
      const { rows } = await sql`SELECT os_index FROM markets WHERE slug = ${slug} LIMIT 1`;
      if (!rows.length || !rows[0].os_index) return { content: [{ type: 'text', text: '{"error":"Market not found"}' }] };
      return { content: [{ type: 'text', text: JSON.stringify({ transactions: buildAddLiquidityTxs(rows[0].os_index, parseUsdcToWei(amountUsdc)), chainId: getChainId() }) }] };
    },
  );

  // ── build_remove_liquidity_tx ─────────────────────────────────────────────
  server.registerTool(
    'build_remove_liquidity_tx',
    {
      description: 'Build unsigned transactions to burn LP tokens and withdraw your share of the market pool.',
      inputSchema: { slug: z.string(), lpAmount: z.string(), from: z.string() },
    },
    async ({ slug, lpAmount }) => {
      const { rows } = await sql`SELECT os_index FROM markets WHERE slug = ${slug} LIMIT 1`;
      if (!rows.length || !rows[0].os_index) return { content: [{ type: 'text', text: '{"error":"Market not found"}' }] };
      return { content: [{ type: 'text', text: JSON.stringify({ transactions: buildRemoveLiquidityTxs(rows[0].os_index, parseUsdcToWei(lpAmount)), chainId: getChainId() }) }] };
    },
  );

  // ── build_withdraw_fees_tx ────────────────────────────────────────────────
  server.registerTool(
    'build_withdraw_fees_tx',
    {
      description: 'Build unsigned transactions to withdraw trading fees earned as a liquidity provider.',
      inputSchema: { slug: z.string(), from: z.string() },
    },
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
