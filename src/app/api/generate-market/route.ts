import { NextRequest } from 'next/server';
import { createXai, webSearch, xSearch } from '@ai-sdk/xai';
import { generateText, stepCountIs } from 'ai';
import { z } from 'zod';

function buildSystemPrompt() {
  const now = new Date();
  const unixNow = Math.floor(now.getTime() / 1000);
  const humanNow = now.toUTCString();
  return `You are a compiler that converts natural language prediction questions into a strict, machine-readable JSON schema.

Your goal is to produce an immutable specification of a random variable that can be resolved deterministically.

CURRENT TIME: ${humanNow} (Unix: ${unixNow})
All timestamps you produce MUST be Unix seconds relative to this current time. Never use past dates as endTime.

You MUST:
- Use web and X search to verify facts, dates, and participants before setting timestamps
- Avoid domain-specific assumptions (finance, crypto, etc.)
- Ensure the market can be resolved using observable data or a defined oracle
- Define clear, discrete outcomes
- Include structured attention metadata for event routing

This schema will be consumed by autonomous agents performing probabilistic reasoning.`;
}

function buildUserPrompt(question: string) {
  return `Create an immutable prediction market for:

${question}

Requirements:

1. Search the web and X to ground the market in current, verified facts.
2. Define minimum amount of variables.
3. Provide discrete, enumerable outcomes, max 6. Each outcome must have "id" (integer starting at 0), "label" (short string), and "description".
4. Define a deterministic resolution rule (who/what decides outcome).
5. Set endTime as a Unix timestamp in seconds. It MUST be in the future relative to the current time provided in the system prompt. For vague deadlines like "before September", use the last second of the relevant day in the current or next upcoming year.
6. Generate an attention profile to capture relevant real-world signals.
7. Reject "death markets" and other harmful predictions.
8. For time-sensitive events (e.g., sports like Formula 1), search for and include the specific event name, location, confirmed date, and participants.

Attention profile must include:
- entities: concrete actors (teams, people, organizations, shows, assets)
- topics: abstract domains (sports, elections, entertainment, etc.)
- signals: event types that influence the outcome
- keywords: routing hints

Output raw JSON only — no explanation, no markdown fences:

{
  "schema": "pm-parent-v2",
  "id": "...",
  "question": "...",
  "description": "...",
  "createdAt": <unix seconds>,
  "endTime": <unix seconds, must be future>,
  "outcomes": [{ "id": 0, "label": "...", "description": "..." }],
  "resolution": { "source": "...", "method": "...", "notes": "..." },
  "oracle": "to-be-assigned",
  "attention": { "entities": [], "topics": [], "signals": [], "keywords": [] }
}`;
}

const MarketSchema = z.object({
  schema: z.literal('pm-parent-v2'),
  id: z.string(),
  question: z.string(),
  description: z.string(),
  createdAt: z.number(),
  endTime: z.number(),
  outcomes: z.array(
    z.object({
      id: z.number(),
      label: z.string(),
      description: z.string(),
    })
  ).min(2).max(6),
  resolution: z.object({
    source: z.string(),
    method: z.string(),
    notes: z.string(),
  }),
  oracle: z.string(),
  attention: z.object({
    entities: z.array(z.string()),
    topics: z.array(z.string()),
    signals: z.array(z.string()),
    keywords: z.array(z.string()),
  }),
});

export async function POST(request: NextRequest) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'XAI_API_KEY not configured' }, { status: 500 });
  }

  let question: string;
  try {
    const body = await request.json();
    question = (body.question ?? '').trim();
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!question) {
    return Response.json({ error: 'Question is required' }, { status: 400 });
  }

  const xai = createXai({ apiKey });

  try {
    const { text } = await generateText({
      model: xai.responses('grok-4-1-fast-non-reasoning'),
      tools: { webSearch: webSearch(), xSearch: xSearch() },
      stopWhen: stepCountIs(5),
      system: buildSystemPrompt(),
      prompt: buildUserPrompt(question),
    });

    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? [null, text];
    const jsonText = jsonMatch[1].trim();

    let parsed: z.infer<typeof MarketSchema>;
    try {
      parsed = MarketSchema.parse(JSON.parse(jsonText));
    } catch {
      return Response.json({ error: 'Model returned invalid JSON', raw: text }, { status: 502 });
    }

    parsed.oracle = process.env.ORACLE_ACCOUNT ?? parsed.oracle;

    return Response.json({ market: parsed });
  } catch (err) {
    const detail = err instanceof Error
      ? { message: err.message, cause: (err as any).cause, responseBody: (err as any).responseBody }
      : String(err);
    console.error('xai error:', JSON.stringify(detail, null, 2));
    return Response.json({ error: detail }, { status: 502 });
  }
}
