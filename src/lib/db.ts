import { sql } from '@vercel/postgres';

export { sql };

export async function initSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS markets (
      id                  TEXT PRIMARY KEY,
      slug                TEXT UNIQUE NOT NULL,
      question            TEXT NOT NULL,
      question_cid        TEXT NOT NULL,
      market_cid          TEXT NOT NULL,
      os_index            TEXT NOT NULL,
      shares_token        TEXT,
      condition_id        TEXT NOT NULL,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      description         TEXT,
      end_time            TIMESTAMPTZ,
      oracle              TEXT,
      collateral          TEXT,
      hook_address        TEXT,
      lmsr_b              TEXT,
      resolution_source   TEXT,
      resolution_method   TEXT,
      resolution_notes    TEXT,
      attention_entities  TEXT[],
      attention_topics    TEXT[],
      attention_signals   TEXT[],
      attention_keywords  TEXT[],
      search_vector       TSVECTOR
    )
  `;

  // Migrate existing installs — no-ops on fresh schema
  const newCols = [
    // Drop NOT NULL constraints that break FPMM markets (no shares token / no ERC-20 per outcome)
    `ALTER TABLE markets ALTER COLUMN shares_token DROP NOT NULL`,
    `ALTER TABLE market_tokens ALTER COLUMN token_address DROP NOT NULL`,
    `ALTER TABLE markets ADD COLUMN IF NOT EXISTS conditions JSONB`,
    `ALTER TABLE markets ADD COLUMN IF NOT EXISTS description TEXT`,
    `ALTER TABLE markets ADD COLUMN IF NOT EXISTS end_time TIMESTAMPTZ`,
    `ALTER TABLE markets ADD COLUMN IF NOT EXISTS oracle TEXT`,
    `ALTER TABLE markets ADD COLUMN IF NOT EXISTS collateral TEXT`,
    `ALTER TABLE markets ADD COLUMN IF NOT EXISTS hook_address TEXT`,
    `ALTER TABLE markets ADD COLUMN IF NOT EXISTS lmsr_b TEXT`,
    `ALTER TABLE markets ADD COLUMN IF NOT EXISTS resolution_source TEXT`,
    `ALTER TABLE markets ADD COLUMN IF NOT EXISTS resolution_method TEXT`,
    `ALTER TABLE markets ADD COLUMN IF NOT EXISTS resolution_notes TEXT`,
    `ALTER TABLE markets ADD COLUMN IF NOT EXISTS attention_entities TEXT[]`,
    `ALTER TABLE markets ADD COLUMN IF NOT EXISTS attention_topics TEXT[]`,
    `ALTER TABLE markets ADD COLUMN IF NOT EXISTS attention_signals TEXT[]`,
    `ALTER TABLE markets ADD COLUMN IF NOT EXISTS attention_keywords TEXT[]`,
    `ALTER TABLE markets ADD COLUMN IF NOT EXISTS search_vector TSVECTOR`,
  ];
  for (const stmt of newCols) {
    await sql.query(stmt);
  }

  await sql`CREATE INDEX IF NOT EXISTS markets_slug_idx ON markets (slug)`;
  await sql`CREATE INDEX IF NOT EXISTS markets_shares_token_idx ON markets (shares_token)`;
  await sql`CREATE INDEX IF NOT EXISTS markets_end_time_idx ON markets (end_time)`;
  await sql`CREATE INDEX IF NOT EXISTS markets_search_idx ON markets USING GIN (search_vector)`;
  await sql`CREATE INDEX IF NOT EXISTS markets_entities_idx ON markets USING GIN (attention_entities)`;
  await sql`CREATE INDEX IF NOT EXISTS markets_topics_idx ON markets USING GIN (attention_topics)`;
  await sql`CREATE INDEX IF NOT EXISTS markets_keywords_idx ON markets USING GIN (attention_keywords)`;

  await sql`
    CREATE TABLE IF NOT EXISTS market_tokens (
      market_id     TEXT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
      token_address TEXT,
      outcome_index INTEGER NOT NULL,
      label         TEXT,
      position_id   TEXT,
      PRIMARY KEY (market_id, outcome_index)
    )
  `;
  const tokenCols = [
    `ALTER TABLE market_tokens ADD COLUMN IF NOT EXISTS label TEXT`,
    `ALTER TABLE market_tokens ADD COLUMN IF NOT EXISTS position_id TEXT`,
  ];
  for (const stmt of tokenCols) {
    await sql.query(stmt);
  }

  await sql`CREATE INDEX IF NOT EXISTS market_tokens_addr_idx ON market_tokens (token_address)`;
}
