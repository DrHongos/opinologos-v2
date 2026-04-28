import { NextRequest, NextResponse } from 'next/server';
import { sql, initSchema } from '@/lib/db';

let schemaReady = false;

async function ensureSchema() {
  if (schemaReady) return;
  await initSchema();
  schemaReady = true;
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;

  const q       = searchParams.get('q');
  const topic   = searchParams.get('topic');
  const entity  = searchParams.get('entity');
  const keyword = searchParams.get('keyword');
  const type    = searchParams.get('type');      // 'simple' | 'mixed'
  const status  = searchParams.get('status');    // 'live' | 'resolved'
  const before  = searchParams.get('before');   // ISO date or unix timestamp
  const after   = searchParams.get('after');
  const limit   = Math.min(parseInt(searchParams.get('limit') ?? '20', 10), 100);
  const offset  = parseInt(searchParams.get('offset') ?? '0', 10);

  try {
    await ensureSchema();

    // Build a parameterised query incrementally using raw SQL.
    // @vercel/postgres sql tag doesn't support truly dynamic WHERE clauses,
    // so we use sql.query() with positional params.
    const conditions: string[] = [];
    const params: unknown[] = [];

    let p = 1; // param counter

    if (q) {
      conditions.push(`search_vector @@ plainto_tsquery('english', $${p})`);
      params.push(q);
      p++;
    }
    if (topic) {
      conditions.push(`attention_topics && ARRAY[$${p}]`);
      params.push(topic);
      p++;
    }
    if (entity) {
      conditions.push(`attention_entities && ARRAY[$${p}]`);
      params.push(entity);
      p++;
    }
    if (keyword) {
      conditions.push(`attention_keywords && ARRAY[$${p}]`);
      params.push(keyword);
      p++;
    }
    if (type === 'mixed') {
      conditions.push(`question LIKE $${p}`);
      params.push('% × %');
      p++;
    } else if (type === 'simple') {
      conditions.push(`question NOT LIKE $${p}`);
      params.push('% × %');
      p++;
    }
    if (after) {
      conditions.push(`end_time >= $${p}`);
      params.push(new Date(isNaN(Number(after)) ? after : Number(after) * 1000).toISOString());
      p++;
    }
    if (before) {
      conditions.push(`end_time <= $${p}`);
      params.push(new Date(isNaN(Number(before)) ? before : Number(before) * 1000).toISOString());
      p++;
    }
    if (status === 'resolved') {
      conditions.push(`res.resolved IS NOT NULL`);
    } else if (status === 'live') {
      conditions.push(`res.resolved IS NULL`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // Lateral join: cheapest resolved event per market (NULL when none exists)
    const resJoin = `
      LEFT JOIN LATERAL (
        SELECT confidence, reasoning, sources, payouts, TRUE AS resolved
        FROM agent_events
        WHERE market_id = m.id AND event_type = 'resolved'
        ORDER BY created_at DESC
        LIMIT 1
      ) res ON true`;

    // Order by relevance when searching, otherwise newest first
    const order = q
      ? `ORDER BY ts_rank(search_vector, plainto_tsquery('english', $1)) DESC, created_at DESC`
      : `ORDER BY created_at DESC`;

    const marketsResult = await sql.query(
      `SELECT
         m.id, m.slug, m.question, m.description, m.end_time, m.oracle,
         m.collateral, m.hook_address, m.lmsr_b,
         m.resolution_source, m.resolution_method, m.resolution_notes,
         m.attention_entities, m.attention_topics, m.attention_signals, m.attention_keywords,
         m.question_cid, m.market_cid, m.os_index, m.shares_token, m.condition_id, m.conditions, m.created_at,
         res.confidence AS resolution_confidence,
         res.reasoning  AS resolution_reasoning,
         res.sources    AS resolution_sources,
         res.payouts    AS resolution_payouts
       FROM markets m
       ${resJoin}
       ${where}
       ${order}
       LIMIT $${p} OFFSET $${p + 1}`,
      [...params, limit, offset],
    );

    const countResult = await sql.query(
      `SELECT COUNT(*) AS total FROM markets m ${resJoin} ${where}`,
      params,
    );

    // Attach outcome tokens to each market
    const ids: string[] = marketsResult.rows.map((r: { id: string }) => r.id);
    let tokensByMarket: Record<string, unknown[]> = {};

    if (ids.length > 0) {
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
      const tokensResult = await sql.query(
        `SELECT market_id, outcome_index, label, token_address, position_id
         FROM market_tokens
         WHERE market_id IN (${placeholders})
         ORDER BY market_id, outcome_index`,
        ids,
      );
      for (const row of tokensResult.rows) {
        if (!tokensByMarket[row.market_id]) tokensByMarket[row.market_id] = [];
        tokensByMarket[row.market_id].push({
          outcomeIndex: row.outcome_index,
          label: row.label,
          tokenAddress: row.token_address,
          positionId: row.position_id,
        });
      }
    }

    const markets = marketsResult.rows.map((r: Record<string, unknown>) => ({
      ...r,
      outcomes: tokensByMarket[r.id as string] ?? [],
      resolution: r.resolution_confidence !== null || r.resolution_reasoning !== null || r.resolution_payouts !== null
        ? {
            confidence: r.resolution_confidence,
            reasoning:  r.resolution_reasoning,
            sources:    r.resolution_sources,
            payouts:    r.resolution_payouts,
          }
        : null,
    }));

    return NextResponse.json({
      markets,
      total: parseInt(countResult.rows[0].total, 10),
      limit,
      offset,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'DB error' }, { status: 500 });
  }
}
