# Agent Guide — Declareindependence Prediction Markets

This document is for AI agents interacting with the app via its MCP server. It covers how to connect, which tools to call, and how to execute common strategies.

## MCP Server

**Endpoint:** `https://opinologos-v2.vercel.app/api/mcp`

The server is stateless — each request is independent, no session setup required. Use the HTTP Streamable MCP transport (POST to the endpoint).

**Claude Code config** (`.claude/settings.json` or global `~/.claude/settings.json`):
```json
{
  "mcpServers": {
    "declareindependence": {
      "type": "http",
      "url": "https://opinologos-v2.vercel.app/api/mcp"
    }
  }
}
```

All 19 tools are prefixed `mcp__declareindependence__` in Claude Code.

---

## Key Concepts

**Chain:** Unichain Sepolia (chainId 1301) in testnet. All tokens are ERC-6909 on the FPMMHook contract — there are no separate ERC-20 outcome tokens.

**Collateral:** A single ERC-20 token (18 decimals). Amounts are always expressed as USDC strings like `"5.0"` in MCP tool calls.

**Outcome space (OS):** A market is identified by its `os_index` (bytes32 keccak hash). You never need to handle `os_index` directly — all tools accept `slug` and resolve it internally.

**linearIdx:** The numeric index of a leaf outcome within a market's outcome space. For simple (single-condition) markets: 0 = No, 1 = Yes (or as labeled). For mixed markets, see the Mixed Markets section.

**Transactions:** All `build_*` tools return `{ transactions: UnsignedTx[], chainId }`. Each `UnsignedTx` has `{ to, data, value, description, optional? }`. Submit them in order with the user's wallet on the correct chain.

**Market file:** A market information is in stored in the contentHash of an ens subdomain formed as: `slug.declareindependence.eth`

---

## Tool Reference

### Discovery

#### `list_markets`
Search and list markets. Returns slug, question, end_time, os_index.
```
list_markets({ query?: string, topic?: string, entity?: string, limit?: number })
```
- Use `query` for free-text search (PostgreSQL full-text)
- Use `topic` / `entity` for structured filters (e.g. `"crypto"`, `"Bitcoin"`)
- Default limit: 10, max: 50

#### `read_market`
Full market spec + live on-chain state. Always call this before building transactions.
```
read_market({ slug: string })
```
Returns: `{ market: { slug, question, conditions, end_time, outcomes: [{outcomeIndex, label}] }, state: { resolved, balances, prices } }`

Prices are implied probabilities 0–1 from FPMM pool balances.

#### `get_price`
Current implied probability per outcome.
```
get_price({ slug: string, outcomeIndex?: number })
```
Returns probabilities 0–1. Omit `outcomeIndex` to get all outcomes.

---

### Quoting

Always quote before presenting a trade to a user.

#### `calc_buy_amount`
How many outcome tokens the user receives for a given USDC spend.
```
calc_buy_amount({ slug: string, outcomeIndex: number, amountUsdc: string })
→ { outcomeTokens: string }   // wei string
```

#### `calc_sell_amount`
How many outcome tokens the user must sell to receive a given USDC amount.
```
calc_sell_amount({ slug: string, outcomeIndex: number, returnAmountUsdc: string })
→ { outcomeTokensRequired: string }   // wei string
```

---

### Position Info

#### `get_user_positions`
All ERC-6909 balances for a user in a market (outcome tokens + LP token).
```
get_user_positions({ slug: string, account: string })
→ { lpTokenId, lpBalance, outcomes: [{ outcomeIndex, label, tokenId, balance }] }
```
Call this before planning any sell, merge, or exit.

#### `get_token_ids`
ERC-6909 token IDs for a market without on-chain balance reads. Use when you only need IDs, not balances.
```
get_token_ids({ slug: string, outcomeIndexes?: number[] })
→ { lpTokenId, outcomeTokenIds: [{ outcomeIndex, tokenId }] }
```

#### `get_fees_withdrawable`
Collateral (wei) claimable by an LP for a market.
```
get_fees_withdrawable({ slug: string, account: string })
→ { feesWei: string }
```

#### `check_operator`
Whether the hook is approved as operator (required for sells). Also checks ERC-6909 allowance for a token ID.
```
check_operator({ owner: string, operator: string, tokenId?: string })
→ { isOperator: boolean, hookAddress: string, allowance?: string }
```
For sell transactions, `operator` should be the hook address returned here.

---

### Transaction Builders

All return `{ transactions: UnsignedTx[], chainId }`. Submit each transaction in sequence.

#### `build_trade_tx` — Buy or sell an outcome
```
build_trade_tx({ slug, outcomeIndex, direction: "buy"|"sell", amountUsdc, from })
```
- Buy: spends `amountUsdc` collateral, receives outcome tokens
- Sell: receives `amountUsdc` collateral, burns outcome tokens
- For mixed markets with many leaf outcomes, prefer `build_split_collateral_tx` + sell unwanted outcomes (better price efficiency)

#### `build_split_collateral_tx` — Collateral → all outcome tokens
```
build_split_collateral_tx({ slug, amountUsdc, from })
```
Splits `amountUsdc` collateral into equal amounts of every outcome token. Use as the first step in the conditional entry pattern.

#### `build_merge_collateral_tx` — All outcome tokens → collateral
```
build_merge_collateral_tx({ slug, amountUsdc, from })
```
Burns equal amounts of all outcome tokens, returns `amountUsdc` collateral. Requires holding the amount in all outcomes.

#### `build_split_position_tx` — Parent outcome → leaf outcomes (mixed markets)
```
build_split_position_tx({ slug, parentLinearIdx, condition, amount, from })
```
- `parentLinearIdx`: linear index in the *parent* OS (the OS without this condition)
- `condition`: condition ID (bytes32 hex) from `get_condition_tree`
- `amount`: amount of parent outcome tokens to split (USDC string, same wei encoding)

#### `build_merge_position_tx` — Leaf outcomes → parent outcome (mixed markets)
```
build_merge_position_tx({ slug, parentLinearIdx, condition, amount, from })
```
Reverse of `build_split_position_tx`. Confirm user holds all required leaf balances with `get_user_positions` first.

#### `build_redeem_tx` — Claim winnings after resolution
```
build_redeem_tx({ slug, from })
```
Call `read_market` first to confirm the market is resolved (`state.resolved === true`).

#### `build_add_liquidity_tx` — Deposit collateral as LP
```
build_add_liquidity_tx({ slug, amountUsdc, from })
```
Deposits collateral, receives LP tokens (ERC-6909).

#### `build_remove_liquidity_tx` — Burn LP tokens, withdraw pool share
```
build_remove_liquidity_tx({ slug, lpAmount, from })
```
`lpAmount` is the LP token amount in USDC string format (same 18-decimal encoding).

#### `build_withdraw_fees_tx` — Claim trading fees as LP
```
build_withdraw_fees_tx({ slug, from })
```
Call `get_fees_withdrawable` first to confirm there are claimable fees.

---

## Common Workflows

### Simple Trade (Buy)

```
1. list_markets({ query: "bitcoin" })          → pick slug
2. read_market({ slug })                        → confirm not resolved, check prices
3. calc_buy_amount({ slug, outcomeIndex: 1, amountUsdc: "10.0" })  → show user expected tokens
4. build_trade_tx({ slug, outcomeIndex: 1, direction: "buy", amountUsdc: "10.0", from: userAddress })
5. Sign and submit each transaction in order on chainId from response
```

### Simple Trade (Sell)

```
1. get_user_positions({ slug, account: userAddress })   → find balance and tokenId
2. check_operator({ owner: userAddress, operator: hookAddress })
   → if isOperator is false, the tx sequence from build_trade_tx includes the approval
3. calc_sell_amount({ slug, outcomeIndex, returnAmountUsdc: "5.0" })
4. build_trade_tx({ slug, outcomeIndex, direction: "sell", amountUsdc: "5.0", from: userAddress })
5. Submit transactions in order
```

### Conditional Entry (Mixed Markets)

Use when you want exposure to a specific combination of condition outcomes.

```
1. get_condition_tree({ slug })
   → returns conditions: [{ id, slotCount, resolved, subOsIndex }]

2. get_outcome_matrix({ slug })
   → returns matrix: [{ linearIdx, label, conditionSlots: [{ conditionId, slotIdx }] }]
   → identify which linearIdx values match your target scenario
     e.g. "C0 = slot 1, any C1" → filter matrix where conditionSlots[0].slotIdx === 1

3. build_split_collateral_tx({ slug, amountUsdc: "100.0", from })
   → now holds equal amounts of all leaf outcomes

4. For each linearIdx NOT in your target set:
   build_trade_tx({ slug, outcomeIndex: unwantedIdx, direction: "sell", amountUsdc: ..., from })
   → sell them back for collateral

5. Hold remaining positions until resolution.

6. On resolution:
   build_redeem_tx({ slug, from })
```

### Liquidity Provision

```
1. read_market({ slug })                         → check market is active
2. build_add_liquidity_tx({ slug, amountUsdc: "500.0", from })
3. Submit transactions

Later:
4. get_fees_withdrawable({ slug, account })      → check claimable fees
5. build_withdraw_fees_tx({ slug, from })

To exit:
6. get_user_positions({ slug, account })         → get lpBalance
7. build_remove_liquidity_tx({ slug, lpAmount: <lpBalance in USDC string>, from })
```

---

## Transaction Submission

After calling any `build_*` tool, you receive:
```json
{
  "transactions": [
    { "to": "0x...", "data": "0x...", "value": "0", "description": "Approve Permit2", "optional": true },
    { "to": "0x...", "data": "0x...", "value": "0", "description": "Permit2 permit" },
    { "to": "0x...", "data": "0x...", "value": "0", "description": "Execute swap via UniversalRouter" }
  ],
  "chainId": 1301
}
```

Rules:
- Submit all transactions in order
- Skip transactions with `optional: true` only if the user has already performed that approval (check allowance first)
- Ensure the user's wallet is connected to `chainId` before submitting
- Wait for each transaction to be confirmed before submitting the next

---

## Error Handling

All tools return `{ error: string }` in the content body on failure — they do not throw HTTP errors. Always check for an `error` field in the response before using the result.

Common errors:
- `"Market not found"` — slug does not exist in DB, or market has no `os_index` yet (not yet deployed on-chain)
- `"Could not read pool balances"` — RPC issue or market OS not initialized
- `"Read failed"` — generic on-chain read error; retry or check RPC health

---

## Mixed Market Concepts

A market with N conditions has `product(slotCounts)` leaf outcomes. `linearIdx` is a mixed-radix index:

```
slotIdx for condition i = (linearIdx / product(slotCounts[0..i-1])) % slotCount_i
```

`get_outcome_matrix` does this decoding for you — use it instead of computing manually.

When splitting or merging positions, `parentLinearIdx` refers to the outcome index in the *parent* outcome space (the OS that contains all conditions except the one being split on). Use `get_condition_tree` to get `subOsIndex` values and match them to parent indices.
