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
  label: string | null;
  positionId?: string | null;
  erc6909Id?: string | null;       // FPMM: ERC-6909 token ID on hook
  predictionToken?: string | null; // legacy: separate ERC-20 address
}

export async function POST(req: NextRequest) {
  const {
    id,
    question,
    questionCid,
    marketCid,
    osIndex,
    sharesToken,   // optional — absent for FPMM markets
    conditionId,
    predTokens,    // optional — absent for FPMM markets
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

    const baseSlug = slugify(question);
    // If another market already owns this slug, append an ID fragment to disambiguate
    const slugConflict = await sql`SELECT id FROM markets WHERE slug = ${baseSlug} AND id != ${id} LIMIT 1`;
    const slug = slugConflict.rows.length > 0
      ? baseSlug.slice(0, 55) + '-' + (id as string).replace(/-/g, '').slice(0, 7)
      : baseSlug;
    const sharesLow = sharesToken ? (sharesToken as string).toLowerCase() : null;
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

    // Prefer structured outcomes array; fall back to legacy predTokens list
    const outcomeRows: Outcome[] = outcomes ?? (Array.isArray(predTokens) ? predTokens.map((t: string, i: number) => ({
      outcomeIndex: i,
      label: null,
      predictionToken: t,
    })) : []);

    for (const o of outcomeRows) {
      // FPMM markets: erc6909Id is the position identifier; no separate ERC-20 token address
      const posId = o.erc6909Id ?? o.positionId ?? null;
      const addr = o.predictionToken ? (o.predictionToken as string).toLowerCase() : null;
      await sql`
        INSERT INTO market_tokens (market_id, token_address, outcome_index, label, position_id)
        VALUES (${id}, ${addr}, ${o.outcomeIndex}, ${o.label ?? null}, ${posId})
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
