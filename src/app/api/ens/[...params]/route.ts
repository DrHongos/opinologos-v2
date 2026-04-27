// EIP-3668 CCIP-Read gateway for *.declareindependence.eth
// URL format: GET /api/ens/{sender}/{calldata}.json
// calldata = ABI-encoded resolve(bytes name, bytes data), including 4-byte selector
//
// On-chain resolver must point to: https://{host}/api/ens/{sender}/{data}.json
// with wildcard support for *.declareindependence.eth (ENSIP-10).
import { NextRequest, NextResponse } from 'next/server';
import { decodeAbiParameters, encodeAbiParameters, encodePacked, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sql } from '@/lib/db';

// DNS wire format → dotted name (e.g. "\x04slug\x12declareindependence\x03eth\x00" → "slug.declareindependence.eth")
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
    // segments[0] = sender (resolver contract), segments[1] = calldata (may end in .json)
    if (!segments || segments.length < 2) {
      return NextResponse.json({ error: 'Bad request' }, { status: 400 });
    }

    const sender = segments[0] as `0x${string}`;
    const rawCalldata = segments[1].replace(/\.json$/, '');
    const calldataHex = (rawCalldata.startsWith('0x') ? rawCalldata : `0x${rawCalldata}`) as `0x${string}`;
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

    const expires = BigInt(Math.floor(Date.now() / 1000) + 300);

    // Inner result: ABI-encoded text record
    const result = encodeAbiParameters([{ type: 'string' }], [`ipfs://${cid}`]);

    // EIP-3668 signature: keccak256(0x1900 || sender || expires || keccak256(request) || keccak256(result))
    const sigHash = keccak256(encodePacked(
      ['bytes2', 'address', 'uint64', 'bytes32', 'bytes32'],
      ['0x1900', sender, expires, keccak256(calldataHex), keccak256(result)],
    ));

    const account = privateKeyToAccount(process.env.ORACLE_PK as `0x${string}`);
    const sig = await account.sign({ hash: sigHash });

    // EIP-3668 outer encoding: (bytes result, uint64 expires, bytes sig)
    const encoded = encodeAbiParameters(
      [{ type: 'bytes' }, { type: 'uint64' }, { type: 'bytes' }],
      [result, expires, sig],
    );

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
