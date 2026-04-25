import { NextRequest } from 'next/server';

export async function POST(request: NextRequest) {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    return Response.json({ error: 'PINATA_JWT not configured' }, { status: 500 });
  }

  let name: string, data: unknown;
  try {
    ({ name, data } = await request.json());
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      pinataContent: data,
      pinataMetadata: { name: name ?? 'market.json' },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    return Response.json({ error: `Pinata error: ${text}` }, { status: 502 });
  }

  const { IpfsHash } = await res.json();
  return Response.json({ cid: IpfsHash as string });
}
