# DB migration cleanup — Firebase→Supabase inefficiencies

Goal: stop emulating Firebase "read the whole node" semantics on top of the
relational schema. Use the indexes and RPCs that already exist. Cut read-time
complexity, write amplification, and `product_stock` bloat.

Files: `src/lib/cloud-db.server.ts`, hot-path callers in `src/lib/bot/*`,
`src/lib/wallet.server.ts`, `drizzle/migrations/*`.

## Tasks

- [x] **1. Targeted query helpers (kill whole-collection scans).**
  Added `ordersByUser`, `recentOrders`, `uidByChatId`, `telegramChatIds` to
  `cloud-db.server.ts`; exposed as `dbOrdersByUser`/`dbRecentOrders`/
  `dbUidByChatId`/`dbTelegramChatIds` in `telegram.server.ts`. Wired:
  `bot/wallet.ts` `sendOrders` + single-user `sendStatement`,
  `reseller/$.ts` orders endpoint, `broadcast-runner.server.ts`
  `allBotUserIds` (now reads only the chat-id column). Uses
  `orders_customer_idx` / `telegram_chat_id` unique index.

- [x] **2. Wallet mutations via `wallet_adjust()` RPC.**
  Added `walletAdjust()` (RPC) in `cloud-db.server.ts`, exposed as
  `dbWalletAdjust`. Converted pure credit/debit+history pairs in
  `wallet.server.ts`: deposit claim, request approval, admin cancel/refund,
  partial-delivery refunds, referral commission, order cancel, crypto deposit,
  signup referral. Left intentionally as CAS: website purchase debit (gates
  delivery), bot `shop.ts` buy + `reseller/$.ts` (gated debit, deliberate
  no-history refunds), `binance.server.ts`/`razorpay.server.ts` (keyed history
  ids for idempotent dedup).

- [x] **3. Skip history/alerts diff when untouched.**
  `writeNode` now accepts the previously-read value; `cloudTransact` passes it.
  `syncUserChildren` compares `prev.history`/`prev.alerts` to the written value
  (JSON equality) and skips each SELECT-all + diff when unchanged. Full-object
  `cloudPut` (no prev) still syncs — conservative and correct.

- [x] **4. `product_stock_count` trigger → `FOR EACH STATEMENT`.**
  `drizzle/migrations/0003_stock_count_statement_trigger.sql`: drops the per-row
  trigger, adds two statement-level triggers (INSERT via `NEW TABLE`, DELETE via
  `OLD TABLE`) that recount each affected product once. Idempotent. **Needs
  manual apply** via the Lovable/run_sql flow (not applied from here — no DB
  creds, high-risk schema change).

- [x] **5. Resolve Telegram chat ↔ uid via `telegram_chat_id` unique column.**
  Added `uidByChatId`, `uidByRefCode`, `countByUsedRef` helpers. `core.ts`
  `linkedUid` resolves via the indexed column first (kv `telegramLinks`
  fallback). `applyStartReferral`/`sendRefer` (bot) and `applySignupReferral`
  (web) replaced their `allUsers()` JS scans with indexed ref-code lookup +
  COUNT query.

- [x] **6. Verify.** `bun x tsc --noEmit` → exit 0, no type errors.
  `bun run build` → exit 0 (client + SSR + nitro all built). Remaining console
  output is pre-existing (`inputValidator` deprecation in untouched
  `*.functions.ts`, chunking warnings).

## Notes
- Schema itself is sound (good indexes, atomic RPCs, RLS). Cost is in the
  Firebase-shaped shim, not the tables.
- Do NOT break the Firebase-style public API other callers depend on; add
  helpers alongside it.
