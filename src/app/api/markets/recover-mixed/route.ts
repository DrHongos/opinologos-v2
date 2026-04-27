// Recovery endpoint for mixed markets whose on-chain TX succeeded but DB/IPFS registration failed.
// POST { osIndex } → reads on-chain state, rebuilds JSON, pins to IPFS, registers to DB.
import { NextRequest, NextResponse } from 'next/server';
import { createPublicClient, http } from 'viem';
import { sql, initSchema } from '@/lib/db';
import { getChain } from '@/lib/chain';
import {
  LMSR_HOOK_ADDRESS,
  COLLATERAL_TOKEN,
  ORACLE_ACCOUNT,
  FPMM_ABI,
} from '@/lib/contracts';

const chain = getChain();
const publicClient = createPublicClient({ chain, transport: http() });

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

async function pinToIPFS(data: unknown, name: string): Promise<string> {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) throw new Error('PINATA_JWT not configured');
  const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ pinataContent: data, pinataMetadata: { name } }),
  });
  if (!res.ok) throw new Error(`Pinata error: ${await res.text()}`);
  const { IpfsHash } = await res.json();
  return IpfsHash as string;
}

export async function POST(req: NextRequest) {
  const { osIndex } = await req.json();
  if (!osIndex) return NextResponse.json({ error: 'osIndex required' }, { status: 400 });

  try {
    // 1. Read on-chain OS info
    const [, conditions] = (await publicClient.readContract({
      address: LMSR_HOOK_ADDRESS,
      abi: FPMM_ABI,
      functionName: 'getOSInfo',
      args: [osIndex as `0x${string}`],
    })) as [string, string[], bigint[], bigint];

    if (conditions.length < 2) {
      return NextResponse.json({ error: `Expected 2 conditions, got ${conditions.length}` }, { status: 400 });
    }

    const [condIdA, condIdB] = conditions;

    // 2. Look up source markets in DB by conditionId
    await initSchema();

    async function fetchSource(condId: string) {
      const mRes = await sql.query(
        `SELECT m.id, m.slug, m.question, m.end_time
         FROM markets m WHERE m.condition_id = $1 LIMIT 1`,
        [condId],
      );
      if (!mRes.rows.length) return null;
      const m = mRes.rows[0];
      const tRes = await sql.query(
        `SELECT outcome_index, label FROM market_tokens WHERE market_id = $1 ORDER BY outcome_index`,
        [m.id],
      );
      return { ...m, outcomes: tRes.rows as { outcome_index: number; label: string | null }[] };
    }

    const [marketA, marketB] = await Promise.all([fetchSource(condIdA), fetchSource(condIdB)]);
    if (!marketA) return NextResponse.json({ error: `No market for conditionId: ${condIdA}` }, { status: 404 });
    if (!marketB) return NextResponse.json({ error: `No market for conditionId: ${condIdB}` }, { status: 404 });

    const nA = marketA.outcomes.length;
    const nB = marketB.outcomes.length;

    // 3. Read ERC-6909 token IDs
    const tokenIds = (await Promise.all(
      Array.from({ length: nA * nB }, (_, i) =>
        publicClient.readContract({
          address: LMSR_HOOK_ADDRESS,
          abi: FPMM_ABI,
          functionName: 'outcomeTokenId',
          args: [osIndex as `0x${string}`, i],
        }),
      ),
    )) as bigint[];

    // 4. Build Cartesian product outcomes
    const outcomeRecords: { outcomeIndex: number; label: string; erc6909Id: string | null }[] = [];
    let idx = 0;
    for (let aIdx = 0; aIdx < nA; aIdx++) {
      for (let bIdx = 0; bIdx < nB; bIdx++) {
        const aLabel = marketA.outcomes[aIdx]?.label ?? `#${aIdx}`;
        const bLabel = marketB.outcomes[bIdx]?.label ?? `#${bIdx}`;
        outcomeRecords.push({
          outcomeIndex: idx,
          label: `${aLabel} × ${bLabel}`,
          erc6909Id: tokenIds[idx] !== undefined
            ? '0x' + tokenIds[idx].toString(16).padStart(64, '0')
            : null,
        });
        idx++;
      }
    }

    // 5. Build & pin market JSON
    const mixId = crypto.randomUUID();
    const endTimeA = marketA.end_time ? new Date(marketA.end_time).getTime() / 1000 : null;
    const endTimeB = marketB.end_time ? new Date(marketB.end_time).getTime() / 1000 : null;
    const endTime = endTimeA && endTimeB
      ? Math.min(endTimeA, endTimeB)
      : endTimeA ?? endTimeB ?? Math.floor(Date.now() / 1000) + 86400 * 365;

    const marketJson = {
      schema: 'pm-mix-v1',
      id: mixId,
      question: `${marketA.question} × ${marketB.question}`,
      description: `Combined prediction market pairing "${marketA.question}" with "${marketB.question}".`,
      createdAt: Math.floor(Date.now() / 1000),
      endTime,
      sourceMarkets: [
        { conditionId: condIdA, question: marketA.question, slug: marketA.slug, outcomes: marketA.outcomes },
        { conditionId: condIdB, question: marketB.question, slug: marketB.slug, outcomes: marketB.outcomes },
      ],
      outcomes: outcomeRecords,
      oracle: ORACLE_ACCOUNT,
      probabilityModel: {
        type: 'fpmm',
        osIndex,
        conditions: [condIdA, condIdB],
        collateral: COLLATERAL_TOKEN,
        hook: LMSR_HOOK_ADDRESS,
      },
    };

    const cid = await pinToIPFS(marketJson, `mix-recovery-${mixId}.json`);

    // 6. Register to DB — deduplicate slug in case another market owns the base slug
    const baseSlug = slugify(marketJson.question);
    const slugConflict = await sql`SELECT id FROM markets WHERE slug = ${baseSlug} AND id != ${mixId} LIMIT 1`;
    const slug = slugConflict.rows.length > 0
      ? baseSlug.slice(0, 55) + '-' + mixId.replace(/-/g, '').slice(0, 7)
      : baseSlug;
    await sql`
      INSERT INTO markets (
        id, slug, question, question_cid, market_cid,
        os_index, condition_id,
        description, end_time, oracle, collateral, hook_address,
        search_vector
      ) VALUES (
        ${mixId}, ${slug}, ${marketJson.question}, ${cid}, ${cid},
        ${osIndex}, ${condIdA},
        ${marketJson.description}, ${new Date(endTime * 1000).toISOString()},
        ${ORACLE_ACCOUNT}, ${COLLATERAL_TOKEN}, ${LMSR_HOOK_ADDRESS},
        to_tsvector('english', ${marketJson.question} || ' ' || ${marketJson.description})
      )
      ON CONFLICT (id) DO UPDATE SET
        market_cid   = EXCLUDED.market_cid,
        slug         = EXCLUDED.slug,
        description  = EXCLUDED.description
    `;

    for (const o of outcomeRecords) {
      await sql`
        INSERT INTO market_tokens (market_id, outcome_index, label, position_id)
        VALUES (${mixId}, ${o.outcomeIndex}, ${o.label}, ${o.erc6909Id})
        ON CONFLICT (market_id, outcome_index) DO UPDATE SET
          label       = EXCLUDED.label,
          position_id = EXCLUDED.position_id
      `;
    }

    return NextResponse.json({ success: true, slug, marketCid: cid, osIndex });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Recovery failed' },
      { status: 500 },
    );
  }
}
