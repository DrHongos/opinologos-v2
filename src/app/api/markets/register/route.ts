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

export async function POST(req: NextRequest) {
  const { id, question, questionCid, marketCid, osIndex, sharesToken, conditionId, predTokens } =
    await req.json();

  if (!id || !question || !marketCid) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  try {
    await ensureSchema();

    const slug = slugify(question);
    const sharesLow = (sharesToken as string).toLowerCase();

    await sql`
      INSERT INTO markets (id, slug, question, question_cid, market_cid, os_index, shares_token, condition_id)
      VALUES (${id}, ${slug}, ${question}, ${questionCid}, ${marketCid}, ${osIndex}, ${sharesLow}, ${conditionId})
      ON CONFLICT (id) DO UPDATE SET
        market_cid   = EXCLUDED.market_cid,
        slug         = EXCLUDED.slug,
        shares_token = EXCLUDED.shares_token
    `;

    for (let i = 0; i < (predTokens as string[]).length; i++) {
      const addr = (predTokens as string[])[i].toLowerCase();
      await sql`
        INSERT INTO market_tokens (market_id, token_address, outcome_index)
        VALUES (${id}, ${addr}, ${i})
        ON CONFLICT (market_id, outcome_index) DO UPDATE SET token_address = EXCLUDED.token_address
      `;
    }

    return NextResponse.json({ slug });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'DB error' }, { status: 500 });
  }
}
