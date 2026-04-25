import { NextResponse } from 'next/server';
import { sql, initSchema } from '@/lib/db';

let schemaReady = false;

async function ensureSchema() {
  if (schemaReady) return;
  await initSchema();
  schemaReady = true;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  try {
    await ensureSchema();

    const result = await sql.query(
      `SELECT
         id, slug, question, description, end_time, oracle,
         collateral, hook_address, lmsr_b,
         resolution_source, resolution_method, resolution_notes,
         attention_entities, attention_topics, attention_signals, attention_keywords,
         question_cid, market_cid, os_index, shares_token, condition_id,
         conditions, created_at
       FROM markets
       WHERE slug = $1
       LIMIT 1`,
      [slug],
    );

    if (result.rows.length === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const market = result.rows[0];

    const tokensResult = await sql.query(
      `SELECT outcome_index, label, token_address, position_id
       FROM market_tokens
       WHERE market_id = $1
       ORDER BY outcome_index`,
      [market.id],
    );

    const outcomes = tokensResult.rows.map((r: Record<string, unknown>) => ({
      outcomeIndex: r.outcome_index,
      label: r.label,
      tokenAddress: r.token_address,
      positionId: r.position_id,
    }));

    // Derive conditions array if not stored yet
    const conditions = market.conditions ?? [
      { id: market.condition_id, slots: outcomes.length || 2 },
    ];

    return NextResponse.json({ market: { ...market, outcomes, conditions } });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'DB error' },
      { status: 500 },
    );
  }
}
