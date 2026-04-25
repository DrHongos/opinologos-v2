import { sql } from '@vercel/postgres';

export { sql };

export async function initSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS markets (
      id           TEXT PRIMARY KEY,
      slug         TEXT UNIQUE NOT NULL,
      question     TEXT NOT NULL,
      question_cid TEXT NOT NULL,
      market_cid   TEXT NOT NULL,
      os_index     TEXT NOT NULL,
      shares_token TEXT NOT NULL,
      condition_id TEXT NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS markets_slug_idx ON markets (slug)`;
  await sql`CREATE INDEX IF NOT EXISTS markets_shares_token_idx ON markets (shares_token)`;

  await sql`
    CREATE TABLE IF NOT EXISTS market_tokens (
      market_id     TEXT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
      token_address TEXT NOT NULL,
      outcome_index INTEGER NOT NULL,
      PRIMARY KEY (market_id, outcome_index)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS market_tokens_addr_idx ON market_tokens (token_address)`;
}
