import { NextRequest, NextResponse } from 'next/server';
import { sql, initSchema } from '@/lib/db';

let schemaReady = false;

async function ensureSchema() {
  if (schemaReady) return;
  await initSchema();
  schemaReady = true;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 8)
    .join('-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63);
}

interface Outcome {
  outcomeIndex: number;
  label: string;
  positionId: string | null;
  predictionToken: string | null;
}

export async function POST(req: NextRequest) {
  const {
    id,
    question,
    questionCid,
    marketCid,
    osIndex,
    sharesToken,
    conditionId,
    predTokens,
    // enriched fields
    description,
    endTime,
    oracle,
    collateral,
    hookAddress,
    lmsrB,
    resolution,
    attention,
    outcomes,
  } = await req.json();

  if (!id || !question || !marketCid) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  try {
    await ensureSchema();

    const slug = slugify(question);
    const sharesLow = (sharesToken as string).toLowerCase();
    const endTimestamp = endTime ? new Date(endTime * 1000).toISOString() : null;

    await sql`
      INSERT INTO markets (
        id, slug, question, question_cid, market_cid,
        os_index, shares_token, condition_id,
        description, end_time, oracle, collateral, hook_address, lmsr_b,
        resolution_source, resolution_method, resolution_notes,
        attention_entities, attention_topics, attention_signals, attention_keywords,
        search_vector
      )
      VALUES (
        ${id}, ${slug}, ${question}, ${questionCid}, ${marketCid},
        ${osIndex}, ${sharesLow}, ${conditionId},
        ${description ?? null}, ${endTimestamp}, ${oracle ?? null},
        ${collateral ?? null}, ${hookAddress ?? null}, ${lmsrB ?? null},
        ${resolution?.source ?? null}, ${resolution?.method ?? null}, ${resolution?.notes ?? null},
        ${attention?.entities ?? null}, ${attention?.topics ?? null},
        ${attention?.signals ?? null}, ${attention?.keywords ?? null},
        to_tsvector('english', ${question} || ' ' || COALESCE(${description ?? null}, ''))
      )
      ON CONFLICT (id) DO UPDATE SET
        market_cid          = EXCLUDED.market_cid,
        slug                = EXCLUDED.slug,
        shares_token        = EXCLUDED.shares_token,
        description         = EXCLUDED.description,
        end_time            = EXCLUDED.end_time,
        oracle              = EXCLUDED.oracle,
        collateral          = EXCLUDED.collateral,
        hook_address        = EXCLUDED.hook_address,
        lmsr_b              = EXCLUDED.lmsr_b,
        resolution_source   = EXCLUDED.resolution_source,
        resolution_method   = EXCLUDED.resolution_method,
        resolution_notes    = EXCLUDED.resolution_notes,
        attention_entities  = EXCLUDED.attention_entities,
        attention_topics    = EXCLUDED.attention_topics,
        attention_signals   = EXCLUDED.attention_signals,
        attention_keywords  = EXCLUDED.attention_keywords,
        search_vector       = EXCLUDED.search_vector
    `;

    // Prefer structured outcomes array (with labels/positionIds); fall back to predTokens
    const outcomeRows: Outcome[] = outcomes ?? (predTokens as string[]).map((t: string, i: number) => ({
      outcomeIndex: i,
      label: null,
      positionId: null,
      predictionToken: t,
    }));

    for (const o of outcomeRows) {
      const addr = (o.predictionToken ?? '').toLowerCase();
      await sql`
        INSERT INTO market_tokens (market_id, token_address, outcome_index, label, position_id)
        VALUES (${id}, ${addr}, ${o.outcomeIndex}, ${o.label ?? null}, ${o.positionId ?? null})
        ON CONFLICT (market_id, outcome_index) DO UPDATE SET
          token_address = EXCLUDED.token_address,
          label         = EXCLUDED.label,
          position_id   = EXCLUDED.position_id
      `;
    }

    return NextResponse.json({ slug });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'DB error' }, { status: 500 });
  }
}
