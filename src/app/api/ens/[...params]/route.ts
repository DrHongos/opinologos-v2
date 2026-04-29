// EIP-3668 CCIP-Read gateway for *.declareindependence.eth
// URL format: GET /api/ens/{sender}/{calldata}.json
// calldata = ABI-encoded resolve(bytes name, bytes data), including 4-byte selector
//
// On-chain resolver must point to: https://{host}/api/ens/{sender}/{data}.json
// with wildcard support for *.declareindependence.eth (ENSIP-10).
import { NextRequest, NextResponse } from 'next/server';
import { decodeFunctionData, decodeAbiParameters, encodeAbiParameters, encodePacked, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sql } from '@/lib/db';
import { LMSR_HOOK_ADDRESS } from '@/lib/contracts';

// Selectors for ENS resolver functions
const SEL_CONTENTHASH = '0xbc1c58d1'; // contenthash(bytes32)
const SEL_ADDR        = '0x3b3b57de'; // addr(bytes32)
const SEL_ADDR_COIN   = '0xf1cb7e06'; // addr(bytes32,uint256)

// Base58 alphabet used by Bitcoin/IPFS
const BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const digit = BASE58_CHARS.indexOf(c);
    if (digit < 0) throw new Error(`Invalid base58 char: ${c}`);
    n = n * 58n + BigInt(digit);
  }
  // Count leading '1's (= leading zero bytes)
  let leadingZeros = 0;
  for (const c of s) {
    if (c !== '1') break;
    leadingZeros++;
  }
  // Convert bigint to bytes
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return new Uint8Array([...new Array(leadingZeros).fill(0), ...bytes]);
}

// CIDv0 (Qm...) → ENS contenthash bytes: 0xe301 prefix + raw 34-byte multihash
function ipfsCidV0ToContenthash(cid: string): `0x${string}` {
  const multihash = base58Decode(cid); // always 34 bytes: 0x12 0x20 + 32-byte SHA256
  const buf = new Uint8Array(2 + multihash.length);
  buf[0] = 0xe3; // ipfs protocol codec (varint low byte)
  buf[1] = 0x01; // ipfs protocol codec (varint high byte)
  buf.set(multihash, 2);
  return `0x${Buffer.from(buf).toString('hex')}`;
}

// DNS wire format → dotted name
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
    const { rows } = await sql`
      SELECT m.market_cid
      FROM markets m
      LEFT JOIN market_tokens mt ON mt.market_id = m.id AND mt.token_address = ${addr}
      WHERE m.shares_token = ${addr} OR mt.token_address IS NOT NULL
      LIMIT 1
    `;
    return rows[0]?.market_cid ?? null;
  }

  const { rows } = await sql`SELECT market_cid FROM markets WHERE slug = ${addr} LIMIT 1`;
  return rows[0]?.market_cid ?? null;
}

// Build the inner result bytes based on what record type the client requested
function buildResult(selector: string, cid: string | null): `0x${string}` {
  if (selector === SEL_ADDR || selector === SEL_ADDR_COIN) {
    // Return the FPMM hook as the address for this name
    if (selector === SEL_ADDR) {
      return encodeAbiParameters([{ type: 'address' }], [LMSR_HOOK_ADDRESS]);
    }
    // addr(bytes32, uint256) returns bytes — for coinType 60 (ETH), address as 20-byte array
    return encodeAbiParameters([{ type: 'bytes' }], [LMSR_HOOK_ADDRESS]);
  }

  if (selector === SEL_CONTENTHASH) {
    if (!cid) return encodeAbiParameters([{ type: 'bytes' }], ['0x']);
    const contenthash = ipfsCidV0ToContenthash(cid);
    return encodeAbiParameters([{ type: 'bytes' }], [contenthash]);
  }

  // Default / text records: return ipfs:// URI
  if (!cid) return encodeAbiParameters([{ type: 'string' }], ['']);
  return encodeAbiParameters([{ type: 'string' }], [`ipfs://${cid}`]);
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ params: string[] }> }) {
  try {
    const { params: segments } = await params;
    if (!segments || segments.length < 2) {
      return NextResponse.json({ error: 'Bad request' }, { status: 400 });
    }

    const sender = segments[0] as `0x${string}`;
    const rawCalldata = segments[1].replace(/\.json$/, '');
    const calldataHex = (rawCalldata.startsWith('0x') ? rawCalldata : `0x${rawCalldata}`) as `0x${string}`;
    console.log("segments:", segments);
    console.log("rawCalldata:", rawCalldata);
    console.log("calldataHex:", calldataHex);

    const decoded = decodeFunctionData({
      abi: [{
        name: 'resolve',
        type: 'function',
        stateMutability: 'view',
        inputs: [
          { name: 'name', type: 'bytes' },
          { name: 'data', type: 'bytes' },
        ],
      }],
      data: calldataHex,
    });

    if (!decoded.args) {
      throw new Error(`Failed to decode function data: ${calldataHex}`);
    }
    const [nameBytes, innerData] = decoded.args as [`0x${string}`, `0x${string}`];
    if (!innerData) {
      throw new Error('Invalid CCIP-read: innerData missing');
    }
    const name = dnsWireDecode(nameBytes as string);
    console.log(`Resolving: ${name}`);

    const innerSelector = (innerData as string).slice(0, 10).toLowerCase();
    console.log(`Record type selector: ${innerSelector}`);

    const nameParts = name.split('.');
    let cid: string | null = null;

    if (nameParts.length === 2) {
      // apex: declareindependence.eth → landing CID
      cid = 'QmZ5VrTMazqytDGhq445R54X7AHnHcGEQzdaKWUToxnyRD';
    } else {
      cid = await findMarketCid(nameParts[0]);
    }

    // For addr queries we don't need a CID; for contenthash/text we do
    if (!cid && innerSelector !== SEL_ADDR && innerSelector !== SEL_ADDR_COIN) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const oraclePk = process.env.ORACLE_PK;
    if (!oraclePk) {
      console.error('ORACLE_PK env var not set');
      return NextResponse.json({ error: 'Oracle not configured' }, { status: 503 });
    }

    const expires = BigInt(Math.floor(Date.now() / 1000) + 300);
    const result = buildResult(innerSelector, cid);

    const sigHash = keccak256(encodePacked(
      ['bytes2', 'address', 'uint64', 'bytes32', 'bytes32'],
      ['0x1900', sender, expires, keccak256(calldataHex), keccak256(result)],
    ));

    const account = privateKeyToAccount(oraclePk as `0x${string}`);
    const sig = await account.sign({ hash: sigHash });

    const encoded = encodeAbiParameters(
      [{ type: 'bytes' }, { type: 'uint64' }, { type: 'bytes' }],
      [result, expires, sig],
    );

    return NextResponse.json({ data: encoded });
  } catch (e) {
    console.error('ENS gateway error:', e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Gateway error' },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest, context: { params: Promise<{ params: string[] }> }) {
  return GET(req, context);
}
