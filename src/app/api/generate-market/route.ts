import { NextRequest } from 'next/server';

const SYSTEM_PROMPT = `You are a compiler that converts natural language prediction questions into a strict, machine-readable JSON schema.

Your goal is to produce an immutable specification of a random variable that can be resolved deterministically.

You MUST:
- Output valid JSON only
- Avoid domain-specific assumptions (finance, crypto, etc.)
- Ensure the market can be resolved using observable data or a defined oracle
- Define clear, discrete outcomes
- Include structured attention metadata for event routing

This schema will be consumed by autonomous agents performing probabilistic reasoning.`;

function buildUserPrompt(question: string) {
  return `Create an immutable prediction market file for:

${question}

Requirements:

1. Define a single variable (or explicitly multiple if unavoidable).
2. Provide discrete, enumerable outcomes, max 4. Each outcome must have "id" (integer starting at 0), "label" (short string), and "description".
3. Define a deterministic resolution rule (who/what decides outcome).
4. Include time constraints if applicable (Unix timestamps in seconds).
5. Generate an attention profile to capture relevant real-world signals.

Attention profile must include:
- entities: concrete actors (teams, people, organizations, shows, assets)
- topics: abstract domains (sports, elections, entertainment, etc.)
- signals: event types that influence the outcome
- keywords: routing hints

Output JSON only — no explanation, no markdown fences:

{
  "schema": "pm-parent-v2",
  "id": "...",
  "question": "...",
  "description": "...",
  "createdAt": ...,
  "endTime": ...,
  "outcomes": [
    { "id": 0, "label": "...", "description": "..." }
  ],
  "resolution": {
    "source": "...",
    "method": "...",
    "notes": "..."
  },
  "oracle": "to-be-assigned",
  "attention": {
    "entities": [],
    "topics": [],
    "signals": [],
    "keywords": []
  }
}`;
}

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

  const grokResponse = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'grok-3-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(question) },
      ],
      temperature: 0.2,
    }),
  });

  if (!grokResponse.ok) {
    const text = await grokResponse.text();
    return Response.json({ error: `Grok API error: ${text}` }, { status: 502 });
  }

  const data = await grokResponse.json();
  const raw = data.choices?.[0]?.message?.content ?? '';

  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? [null, raw];
  const jsonText = jsonMatch[1].trim();

  try {
    const parsed = JSON.parse(jsonText);
    // Inject oracle from env server-side
    parsed.oracle = process.env.ORACLE_ACCOUNT ?? parsed.oracle;
    return Response.json({ market: parsed });
  } catch {
    return Response.json({ error: 'Model returned invalid JSON', raw }, { status: 502 });
  }
}
