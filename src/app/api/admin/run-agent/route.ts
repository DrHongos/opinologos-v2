import { NextRequest } from 'next/server';

export async function GET(req: NextRequest) {
  const host = req.headers.get('host') ?? 'localhost:3000';
  const proto = host.startsWith('localhost') ? 'http' : 'https';
  const baseUrl = `${proto}://${host}`;

  const headers: Record<string, string> = {};
  const secret = process.env.CRON_SECRET;
  if (secret) {
    headers['Authorization'] = `Bearer ${secret}`;
  }

  const res = await fetch(`${baseUrl}/api/agent/run`, { headers });
  const data = await res.json();
  return Response.json(data, { status: res.status });
}
