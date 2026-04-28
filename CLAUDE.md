@AGENTS.md

# Opinologos Frontend

FPMM prediction market dApp on Unichain Sepolia. Markets are outcome spaces (OS) on `FPMMHook.sol` — a Uniswap v4 hook where each outcome is a pool, trades are swaps, and all tokens are ERC-6909 on the hook contract.

## Chain & Addresses

All addresses come from env vars, resolved in `src/lib/contracts.ts` and `src/lib/chain.ts`.

| Env var | Purpose |
|---------|---------|
| `NEXT_PUBLIC_CHAIN_ID` | Default 8453 (Base); testnet uses 1301 (Unichain Sepolia) |
| `NEXT_PUBLIC_LMSR_HOOK_ADDRESS` | FPMMHook contract |
| `NEXT_PUBLIC_COLLATERAL_TOKEN` | ERC-20 collateral (18 decimals) |
| `NEXT_PUBLIC_UNIVERSAL_ROUTER` | Uniswap UniversalRouter |
| `NEXT_PUBLIC_ORACLE_ACCOUNT` | Oracle wallet address |
| `UNICHAIN_SEPOLIA_RPC` | RPC endpoint |
| `ORACLE_PK` | Oracle private key (server-only) |

## Key Library Files

- `src/lib/contracts.ts` — FPMM_ABI, ERC20_ABI, PERMIT2_ABI, UNIVERSAL_ROUTER_ABI, `outcomeTokenIdLocal`, `lpTokenIdLocal`, `computeImpliedPrice`
- `src/lib/tx-builder.ts` — All unsigned tx builders: `buildTradeTxs`, `buildSplitCollateralTxs`, `buildMergeCollateralTxs`, `buildSplitPositionTxs`, `buildMergePositionTxs`, `buildRedeemTxs`, `buildAddLiquidityTxs`, `buildRemoveLiquidityTxs`, `buildWithdrawFeesTxs`. Amounts are bigint wei; use `parseUsdcToWei(str)` to convert.
- `src/lib/oracle-client.ts` — `getPublicClient()`, `getOracleWalletClient()`, `getOracleAccount()`
- `src/lib/chain.ts` — `getChain()`, `TARGET_CHAIN_ID`
- `src/lib/db.ts` — `sql` tagged-template Postgres client; schema: `markets`, `market_tokens`, `agent_events`
- `src/lib/agent-swap.ts` — `computeTradeSize` (binary search), `executeNudgeTrade` (oracle-signed swap)

## Token ID Encoding (mirrors Solidity)

```ts
outcomeTokenId(osIndex, linearIdx) = (linearIdx << 224n) | (osIndex & MARKET_MASK)
lpTokenId(osIndex)                 = (1n << 255n) | (osIndex & MARKET_MASK)
```

Use `outcomeTokenIdLocal` / `lpTokenIdLocal` from `contracts.ts` — do not reimplement.

## Mixed / Conditional Markets

A market with N conditions has `product(slotCounts)` leaf outcomes. Each `linearIdx` encodes a combination via mixed-radix: `slotIdx_i = (linearIdx / product(slotCounts[0..i-1])) % slotCount_i`.

Sub-outcome-space index when stripping condition C:
```
subOsIndex = keccak256(abi.encode(collateral, sorted(conditions \ {C})))
```
Use the on-chain `getOSIndex(collateral, subConditions[])` pure function — already in `FPMM_ABI`.

## MCP Server

`src/app/api/mcp/route.ts` — stateless per-request McpServer with 19 tools:

**Discovery & state:** `list_markets`, `read_market`, `get_price`

**Quoting:** `calc_buy_amount`, `calc_sell_amount`

**Position info:** `get_token_ids`, `get_user_positions`, `get_fees_withdrawable`, `check_operator`

**Mixed market structure:** `get_condition_tree` (subOsIndex per condition), `get_outcome_matrix` (linearIdx → condition slots)

**Tx builders:** `build_trade_tx`, `build_split_collateral_tx`, `build_merge_collateral_tx`, `build_split_position_tx`, `build_merge_position_tx`, `build_redeem_tx`, `build_add_liquidity_tx`, `build_remove_liquidity_tx`, `build_withdraw_fees_tx`

All tx tools return `{ transactions: UnsignedTx[], chainId }`. Transactions must be submitted in order.

## Conditional Entry Pattern (agent strategy)

1. `get_condition_tree(slug)` → get `subOsIndex` and condition IDs
2. `get_outcome_matrix(slug)` → find which `linearIdx` values match target scenario
3. `build_split_collateral_tx` → own all outcomes
4. `build_trade_tx(sell)` on unwanted leaf outcomes → concentrated position
5. On resolution: `build_redeem_tx`

## Agent Loop

`src/app/api/admin/run-agent/route.ts` — cron-triggered; for each unresolved simple market: research via Grok → resolve (confidence ≥ 80%) or nudge trade (confidence 60–80%). Logs to `agent_events`. Only processes simple markets (single condition).

## DB Schema (key columns)

**markets:** `slug`, `os_index`, `collateral`, `hook_address`, `condition_id`, `conditions` (JSONB — `[{id, slots}]` for mixed markets), `end_time`, `attention_topics[]`, `attention_entities[]`, `search_vector`

**market_tokens:** `market_id`, `outcome_index`, `label`, `position_id`

**agent_events:** `market_id`, `event_type` (resolved|nudged|skipped|error), `confidence`, `reasoning`, `tx_hash`, `trade_amount_usdc`
