import { NextRequest } from 'next/server';
import { createXai, webSearch, xSearch } from '@ai-sdk/xai';
import { generateText, stepCountIs } from 'ai';
import { z } from 'zod';

const ResolutionSchema = z.object({
  resolvable: z.boolean(),
  confidence: z.number().min(0).max(100),
  winningOutcomeIndex: z.number().nullable(),
  payouts: z.array(z.number().int().min(0)),
  reasoning: z.string(),
  sources: z.array(z.string()),
});

export async function POST(req: NextRequest) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return Response.json({ error: 'XAI_API_KEY not configured' }, { status: 500 });

  const body = await req.json().catch(() => null);
  if (!body) return Response.json({ error: 'Invalid body' }, { status: 400 });

  const { question, description, outcomes, resolution, endTime } = body as {
    question: string;
    description?: string;
    outcomes: { id: number; label: string }[];
    resolution?: { source?: string; method?: string; notes?: string };
    endTime?: number;
  };

  if (!question || !outcomes?.length) {
    return Response.json({ error: 'question and outcomes are required' }, { status: 400 });
  }

  const now = new Date();
  const endDate = endTime ? new Date(endTime * 1000).toUTCString() : 'unknown';
  const outcomeList = outcomes.map((o, i) => `  ${i}: "${o.label}"`).join('\n');

  const system = `You are an oracle researcher for prediction markets. Your job is to determine whether a market can be definitively resolved based on publicly available information. Be factual, cite sources, and be conservative with confidence scores.

Current time: ${now.toUTCString()}`;

  const prompt = `Research the following prediction market and determine if it can be resolved:

QUESTION: ${question}
${description ? `DESCRIPTION: ${description}` : ''}
END TIME: ${endDate}
OUTCOMES (by index):
${outcomeList}
${resolution ? `RESOLUTION RULE: ${resolution.source} — ${resolution.method}` : ''}

Instructions:
1. Search the web and X to find the current status of this event.
2. Determine if the outcome can be definitively established based on available evidence.
3. If resolvable, set winningOutcomeIndex to the index of the winning outcome (or null if not determined).
4. Set payouts as an integer array, one per outcome. The winner gets 1, losers get 0. For partial/split resolutions use proportional integers summing to 100.
5. Set confidence 0-100 (80+ means you are highly confident, below 60 means uncertain).
6. Only set resolvable=true if confidence >= 70 and the event has clearly concluded.

Output raw JSON only — no markdown fences:

{
  "resolvable": <bool>,
  "confidence": <0-100>,
  "winningOutcomeIndex": <number or null>,
  "payouts": [<int per outcome>],
  "reasoning": "<concise explanation with key facts>",
  "sources": ["<url or source name>"]
}`;

  const xai = createXai({ apiKey });

  try {
    const { text } = await generateText({
      model: xai.responses('grok-4-1-fast-non-reasoning'),
      tools: { webSearch: webSearch(), xSearch: xSearch() },
      stopWhen: stepCountIs(6),
      system,
      prompt,
    });

    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? [null, text];
    const jsonText = (jsonMatch[1] ?? text).trim();

    let parsed: z.infer<typeof ResolutionSchema>;
    try {
      parsed = ResolutionSchema.parse(JSON.parse(jsonText));
    } catch {
      return Response.json({ error: 'Model returned invalid JSON', raw: text }, { status: 502 });
    }

    if (parsed.payouts.length !== outcomes.length) {
      parsed.payouts = outcomes.map((_, i) =>
        parsed.winningOutcomeIndex === i ? 1 : 0
      );
    }

    return Response.json(parsed);
  } catch (err) {
    const detail = err instanceof Error
      ? { message: err.message, cause: (err as unknown as Record<string, unknown>).cause }
      : String(err);
    return Response.json({ error: detail }, { status: 502 });
  }
}
