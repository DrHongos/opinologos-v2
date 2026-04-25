// EIP-3668 CCIP-Read gateway for *.opinologos.eth
// URL format: GET /api/ens/{sender}/{calldata}.json
// calldata = ABI-encoded resolve(bytes name, bytes data), including 4-byte selector
//
// On-chain resolver must point to: https://{host}/api/ens/{sender}/{data}.json
// with wildcard support for *.opinologos.eth (ENSIP-10).
import { NextRequest, NextResponse } from 'next/server';
import { decodeAbiParameters, encodeAbiParameters } from 'viem';
import { sql } from '@/lib/db';

// DNS wire format → dotted name (e.g. "\x04slug\x0aopinologos\x03eth\x00" → "slug.opinologos.eth")
function dnsWireDecode(hex: string): string {
  const buf = Buffer.from(hex.replace(/^0x/, ''), 'hex');
  const labels: string[] = [];
  let i = 0;
  while (i < buf.length) {
    const len = buf[i];
    if (len === 0) break;
    labels.push(buf.slice(i + 1, i + 1 + len).toString('utf8'));
    i += 1 + len;
  }
  return labels.join('.');
}

async function findMarketCid(subdomain: string): Promise<string | null> {
  const addr = subdomain.toLowerCase();

  if (/^0x[0-9a-f]{40}$/i.test(subdomain)) {
    // Token address lookup — check sharesToken or any predictionToken
    const { rows } = await sql`
      SELECT m.market_cid
      FROM markets m
      LEFT JOIN market_tokens mt ON mt.market_id = m.id AND mt.token_address = ${addr}
      WHERE m.shares_token = ${addr} OR mt.token_address IS NOT NULL
      LIMIT 1
    `;
    return rows[0]?.market_cid ?? null;
  }

  // Slug lookup
  const { rows } = await sql`SELECT market_cid FROM markets WHERE slug = ${addr} LIMIT 1`;
  return rows[0]?.market_cid ?? null;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ params: string[] }> }) {
  try {
    const { params: segments } = await params;
    // segments[0] = sender, segments[1] = calldata (may end in .json)
    if (!segments || segments.length < 2) {
      return NextResponse.json({ error: 'Bad request' }, { status: 400 });
    }

    const rawCalldata = segments[1].replace(/\.json$/, '');
    const hex = rawCalldata.replace(/^0x/, '');

    // Skip 4-byte function selector (resolve(bytes,bytes) = 0x9061b923)
    const argsHex = `0x${hex.slice(8)}` as `0x${string}`;

    const [nameBytes] = decodeAbiParameters(
      [{ type: 'bytes' }, { type: 'bytes' }],
      argsHex,
    );

    const name = dnsWireDecode(nameBytes as string);
    const subdomain = name.split('.')[0];

    const cid = await findMarketCid(subdomain);
    if (!cid) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    // Return ABI-encoded string (text record with ipfs:// URL)
    const encoded = encodeAbiParameters([{ type: 'string' }], [`ipfs://${cid}`]);

    return NextResponse.json({ data: encoded });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Gateway error' },
      { status: 500 },
    );
  }
}

// Some CCIP-Read clients send POST
export async function POST(req: NextRequest, context: { params: Promise<{ params: string[] }> }) {
  return GET(req, context);
}
