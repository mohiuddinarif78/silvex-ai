# Security Analysis — silvex-ai Store

Date: 2026-10-12
Scope: wallet/credits, admin panel, auth/authorization, payment & crypto
deposit flows, database access rules, secret handling.
Incident under investigation: an attacker edited the credit (wallet) balance on
an account and bought goods, causing a ~$12 loss, and the admin panel was
reportedly compromised.

---

## 0. Remediation Status (updated 2026-10-12, commits ad9c809 + bdd3637)

A round of hardening was completed and pushed to `main` after the initial
analysis. Current status of each finding:

| ID | Title | Severity | Status |
|----|-------|----------|--------|
| F-1 | Legacy Firebase rules grant admin + wallet-write | Critical | **Fixed** — `database.rules.json` deleted; app runs only on Supabase + `cloud-access.server.ts`. (Firebase RTDB itself should still be confirmed decommissioned — it has reportedly hit its free-plan limit and is being abandoned.) |
| F-2 | Service-role key committed in `.env` | Critical | **Partially fixed** — `.env` removed from the repo and git-ignored; `.env.example` added with names only. **The previously committed key still exists in git history and MUST be rotated in Supabase.** |
| F-3 | Reseller API non-atomic wallet debit (overspend) | High | **Fixed** — `reseller/$.ts` now debits via an atomic `dbTransact` CAS with the insufficient-funds guard inside the transaction, claims `auto` stock atomically, refunds in full when delivery yields nothing, and supports an optional `idempotencyKey` claimed via `dbCreateIfAbsent` to make retries safe. (Minor residual: a *partial* supplier delivery still charges full price — tracked separately, not an overspend.) |
| F-4 | Inconsistent owner identity across codebase | High | **Fixed** — owner/revoked lists now come from env (`OWNER_EMAILS` / `REVOKED_ADMIN_EMAILS`), single source via `owners.ts`; hardcoded emails removed from `StoreContext`, `push.server.ts`, and the deleted Firebase rules. The DB signup trigger grants the owner role to the configured owner email. |
| F-5 | Public `binance-check` leaks config/status | Medium | **Fixed** — endpoint deleted; the same config (keys-saved, address, Pay ID) is available to the owner through the admin panel. No code referenced it. |
| F-6 | Crypto deposit verification weaknesses | Medium | **Fixed** — auto-credit now requires a minimum confirmation count per chain (BSC 15 / Polygon 30) computed from block height, plus agreement from a second independent RPC on the receipt + block; anything short of that is held for manual admin approval. Rounding still truncates to 2dp (against the user, not the store) — acceptable. |
| F-7 | Admin UI gating is client-only | Low → **High** (re-rated) | **Fixed** — audit found 11 of 14 server-function files had no server-side identity check, so admin actions were callable directly by anyone: read/change supplier URLs+keys (`providers.functions`), swap the Telegram bot token (`bot-setup`), broadcast to all bot users (`broadcast`), redeploy/restart hosting (`railway`), force supplier sync (`supplier`). Added `src/lib/auth-guard.server.ts` (`requireStaff` / `requireCaller`, verifying the bearer token server-side) and applied `requireStaff` to every admin-only function. Customer payment functions (`verifyBinancePay`, `verifyBinanceDeposit`, `createDepositLink`) now credit the **verified** caller instead of a browser-supplied `uid`; `notifyTelegramOrder` requires login and limits non-staff to their own chat. Verified against the production build: an unauthenticated same-origin call to `listProviders` now returns "Please sign in again." instead of supplier keys. Left public by design: `getStoreSnapshot`, `binanceInfo`, `razorpayStatus`, `checkDeposit`, `checkDepositLink`, `getVapidKey`, `autoSyncSupplier` (self-throttled). `sendSmtpMail` uses caller-supplied SMTP credentials, so it exposes no store secret (residual: can be used as a mail relay with the caller's own credentials). |
| F-8 | Wallet column clamped on full-row writes | Medium → **Medium-High** (re-rated) | **Fixed** — clamp removed from `cloud-db.server.ts` so the DB `CHECK (wallet >= 0)` rejects negatives instead of hiding them. Audit found ~10 read-then-write balance updates (lost-update / free-goods race), now all routed through new atomic helpers in `wallet.server.ts`: `walletAdd` (CAS, refuses overdraw), `claimAndCreditDeposit` (bot + support-agent crypto deposits — also fixed a **double-credit** race where the "already used" check ran before the slow chain lookup), `decideWalletRequest` (request claimed once; used by bot and a new staff-only `decideRequestWeb` server fn replacing the browser read-then-write in `RequestsAdmin`), `adminCancelAndRefund` (no double refund), `addReferralCommission` (cap counter + wallet both atomic). Razorpay and Binance credits use `walletAdd`. Verified with 7 concurrent-update tests against an in-memory CAS store (all pass). Left as intended direct sets: admin "set balance" in `UsersAdmin.tsx` and bot `u_wallet`. |
| F-9 | No rate limiting | Medium | **Fixed** — new `src/lib/rate-limit.server.ts` (in-memory sliding window, keyed by Railway's `X-Real-IP` and by account / API key / email / chat where known). Limits: checkout & cancel 10/min per account (30/min per IP); crypto & Binance deposit checks 10/min per account (30/min per IP); public deposit lookup 20/min per IP; Razorpay link create 5/min per account, status check 30/min per IP; signup referral 5/h per account (10/h per IP); `prepareLegacyLogin` 3 per email / 10 per IP per 10 min; `sendSmtpMail` 20 per IP / 5 per recipient per 10 min (staff exempt); order notifications 10/min per customer; bot & support-agent deposit checks 10/min per chat. Reseller API: 120/min per IP, 60/min per key, 20 orders/min per key, and an IP is locked out for 10 min after 20 wrong keys (returns 429 + `Retry-After`). Verified on the production build: 20 bad keys → 401, then 429. Limitations: counters reset on restart and are per replica — move to Redis/DB if the service is scaled out. Login/password brute force is handled by Supabase Auth's own limits (logins go browser → Supabase directly). `cloudRead`/`cloudWrite` are not limited because the site polls them heavily. |
| F-10 | Public tx hashes can be claimed by another account | Medium | **Deferred** (found during F-7 audit) — on-chain deposits (`submitCryptoDeposit`, `verifyBinanceDeposit`, bot/support deposits) credit whichever signed-in account submits the hash first, and hashes are public on block explorers. Fix plan (unique amount per deposit request) recorded in `futureupdates.md`. |

Also done this session: supplier API keys moved out of source
(`providers.server.ts`) into `PROVIDER_*_KEY` env vars; the old owner's keys are
no longer in the working tree (they remain in git history and should be revoked
by their owner at each supplier shop).

### Still required before considering the incident closed
1. **Rotate the Supabase service-role and publishable keys** (F-2) — the leaked
   value is still recoverable from git history.
2. **Confirm the Firebase RTDB is decommissioned** so no legacy client-writable
   money path exists (F-1).
3. ~~Fix the full-row wallet clamp (F-8)~~ — done; reseller overspend F-3 also fixed.
4. Rotate the exposed supplier API keys at each shop.

---

## 1. Executive Summary

The store was migrated from Firebase Realtime Database to Lovable Cloud
(Supabase/Postgres). The **current Cloud backend is largely sound**: every money
and role change flows through server functions that verify the login token and
re-check authorization server-side, wallet math is atomic, Postgres RLS is
default-deny, and the service-role key is only used server-side.

**Most likely root cause of the original incident (now remediated in code):**
the repository previously carried the **legacy Firebase security rules
(`database.rules.json`)**, which granted full admin — including the right to
write any user's `wallet` — to anyone whose account carried an `isAdmin` flag
*and* one of two hardcoded Gmail addresses that were **not** the project's real
owner. On Firebase RTDB, clients write directly to the database and that rules
file was the only gate, so an attacker authenticated as one of those emails could
overwrite any wallet straight from the browser — exactly the described attack.

As of commits ad9c809 + bdd3637 this path is closed **in the codebase**:
`database.rules.json` has been deleted, the app runs only on Supabase with
server-side authorization (`cloud-access.server.ts`) + default-deny RLS, and all
owner identity is now sourced from environment variables with the hardcoded
non-owner emails removed (F-1, F-4 fixed). **Two external actions still remain**
to fully close the incident: confirm the Firebase RTDB instance
(`silvex-ai-default-rtdb.firebaseio.com`) is actually decommissioned, and rotate
the Supabase keys (F-2) since the old service-role key is still recoverable from
git history.

Two further issues could independently enable wallet tampering or financial
loss going forward:

- The committed `.env` contains the Supabase **service-role key**, which bypasses
  all RLS. Anyone who obtained it (via git history, the build, or a leak) has god
  mode over the database.
- The public reseller API debits wallets **non-atomically** and silently clamps
  negative balances to zero, allowing concurrent requests to spend credit the
  user does not have (double-spend / overspend).

### Most likely root cause of the reported hack

> **Legacy Firebase rules granting admin + wallet-write via a client-settable
> `isAdmin` flag and non-owner hardcoded emails, against a Firebase RTDB that may
> still be live.** On Firebase RTDB, clients write directly to the database and
> the only gate is `database.rules.json`. Because admin there is `isAdmin ===
> true && email in (red.eyes.owner121@…, mohiuddinarif78@…)`, and the website
> auto-sets `isAdmin`/`isOwner` on the user's own record for "owner" emails, the
> admin boundary depended on data an attacker could influence rather than on a
> server-verified role. A compromised or attacker-registered admin email could
> then run `set(users/<victim>/wallet, …)` straight from the browser.

If, instead, the hack happened *after* the Cloud migration, the exposed
service-role key or the reseller-API race are the viable paths; both are covered
below.

---

## 2. Findings

| ID | Title | Severity | Location |
|----|-------|----------|----------|
| F-1 | Legacy Firebase rules: admin via `isAdmin` flag + non-owner hardcoded emails | **Critical** | `database.rules.json` |
| F-2 | Supabase service-role key committed in `.env` | **Critical** | `.env`, `README.md` |
| F-3 | Reseller API debits wallet non-atomically (double-spend / overspend) | **High** | `src/routes/api/public/reseller/$.ts` |
| F-4 | Owner identity is inconsistent across the codebase | **High** | `owners.ts`, `database.rules.json`, migration `handle_new_auth_user` |
| F-5 | Public `binance-check` endpoint leaks config + account status, no auth | **Medium** | `src/routes/api/public/binance-check.ts` |
| F-6 | On-chain deposit verification: no min-confirmations, precision truncation, single-RPC trust | **Medium** | `src/lib/deposit.server.ts` |
| F-7 | Admin UI gating is client-only (defense-in-depth gap) | **Low** | `src/routes/admin.tsx` |
| F-8 | `wallet.server.ts` wallet column clamps to `Math.max(0, …)` on full-row writes | **Medium** | `src/lib/cloud-db.server.ts` (`userToRow`) |
| F-9 | No rate limiting on auth / deposit / checkout / reseller endpoints | **Medium** | server functions & API routes |

---

## 3. Detailed Findings

### F-1 — Legacy Firebase rules grant admin + wallet-write (Critical)

Evidence — `database.rules.json`, repeated on every node including `users`:

```json
".write": "auth != null && root.child('users/' + auth.uid + '/isAdmin').val() === true && (auth.token.email === 'red.eyes.owner121@gmail.com' || auth.token.email === 'mohiuddinarif78@gmail.com')"
```

And the per-user field rule lets a user write a set of own fields, while the
whole-record `.write` is granted to those "admin" emails — which can write
`users/<anyUid>/wallet`.

Problems:
1. Admin is defined partly by a value stored *in the database* (`isAdmin`), not
   by a trusted server role. On Firebase, the `users/<uid>` whole-node `.write`
   is itself gated on `isAdmin`, but the website code
   (`StoreContext.tsx`) **auto-writes `isAdmin: true` for any "owner" email** and
   for the first account on a fresh project ("bootstrap owner"). The security of
   the money boundary therefore rests on who controls those emails.
2. The hardcoded admin emails (`red.eyes.owner121@gmail.com`,
   `mohiuddinarif78@gmail.com`) are **not** the project's real owner
   (`adithyanbraj@gmail.com` per `owners.ts`). One of them,
   `mohiuddinarif*`, also appears in `REVOKED_ADMIN_EMAILS` in `owners.ts` —
   indicating a former admin whose access was supposed to be removed, but whose
   address is still hardwired as admin in the Firebase rules.
3. If the Firebase RTDB (`silvex-ai-default-rtdb.firebaseio.com`, see
   `README.md`) is still provisioned, these rules are **live** and a browser
   client authenticated as one of those emails can run
   `set(ref(db, 'users/<victim>/wallet'), 9999)` directly — no server involved.

Exploit scenario: attacker signs in/registers as (or compromises) one of the
hardcoded admin emails → website sets their `isAdmin`/`isOwner` → attacker opens
the browser console or the admin "Set balance" button → writes their own (or any)
`wallet` to an arbitrary value → buys goods with the fabricated credit.

Fix:
- If Firebase is truly retired: **delete `database.rules.json` and decommission
  the RTDB instance** so no client-writable money path exists. Also remove the
  Firebase config block from `README.md`.
- If any Firebase surface remains: rewrite the rules so **no path grants
  `.write` to `users/$uid/wallet`, `isAdmin`, `isOwner`, `history`, `blocked`,
  roles, products, stock, or settings** to any client. Admin must be a custom
  claim set by a trusted server using the Admin SDK, never a DB field. Make
  wallet/history/role writes server-only.

### F-2 — Service-role key committed in `.env` (Critical)

Evidence — `.env` (tracked on disk; `.gitignore` now excludes `.env`, but the
file is present and was likely committed before the ignore rule):

```
SUPABASE_SERVICE_ROLE_KEY=sb_secret_<REDACTED — rotate this key in Supabase>
```

> Note: the actual leaked key value is intentionally not reproduced in this
> document. Treat the previously committed `sb_secret_...` value as compromised
> and rotate it.

The service-role key **bypasses RLS entirely** (`client.server.ts` comment:
"service role key - bypasses RLS"). Anyone with it can read/write every table,
including every wallet and role, from anywhere.

Exploit scenario: the key leaks via git history, a built artifact, a log, or a
shared repo → attacker calls Supabase REST/`supabase-js` with it → sets any
wallet, grants themselves a role, drains stock.

Fix (do all):
1. **Rotate the key immediately** in the Supabase dashboard (and the publishable
   key as a precaution). Treat the committed value as burned.
2. Remove `.env` from the repo and purge it from git history
   (`git filter-repo` / BFG). Note: this project syncs to Lovable; coordinate so
   history rewrite does not break the Lovable connection — rotating the key makes
   the leaked value worthless even if history cannot be purged.
3. Store secrets only in the host's environment (Railway/Lovable Cloud secrets),
   never in a tracked file. Provide a `.env.example` with placeholder names only.
4. Confirm `SUPABASE_SERVICE_ROLE_KEY` is **not** `VITE_`-prefixed anywhere (it
   is not today — good) so it can never reach the client bundle.

### F-3 — Reseller API non-atomic wallet debit (High)

Evidence — `src/routes/api/public/reseller/$.ts`, `order` handler:

```ts
const balance = Number(user.wallet || 0);
if (balance < price) { return json({ ok:false, error:"Insufficient balance", ... }, 402); }
// ... deliver ...
await dbPut(`users/${uid}/wallet`, balance - price);   // read-modify-write, not atomic
```

`user` was read once at the top of the request (`resolveKey`). The balance check
and the debit are a classic time-of-check/time-of-use (TOCTOU) gap, and the
debit is a plain `dbPut` of a client-derived value rather than an atomic
transaction. Two concurrent API calls both read the same balance, both pass the
check, and both write `balance - price` — the user spends more than they have.
There is also **no idempotency key**, so a retried request can place duplicate
orders.

Contrast with the website checkout (`wallet.server.ts`), which correctly uses an
atomic compare-and-swap:

```ts
const paid = await dbTransact(`users/${uid}/wallet`, (w) => {
  const cur = Number(w) || 0;
  if (cur < total) return undefined;    // atomic guard
  return round(cur - total);
});
```

Exploit scenario: user with $5 fires N parallel `POST /order` for a $5 item;
several succeed, delivering goods worth far more than $5 of credit.

Fix: debit atomically and reject on insufficient funds inside the transaction,
then deliver; refund atomically if delivery fails. Add an `Idempotency-Key`
header (or dedupe on a client order id) and claim it once, like the deposit
flows already do with `dbCreateIfAbsent`.

### F-4 — Inconsistent owner identity (High)

Evidence:
- `src/lib/owners.ts`: `PERMANENT_OWNER_EMAILS = ["adithyanbraj@gmail.com"]`,
  `REVOKED_ADMIN_EMAILS = ["mohiuddinarif0278@…","mohiuddinarif8299@…"]`.
- `drizzle/migrations/0000_store_core_schema.sql` → `handle_new_auth_user`
  grants `owner`/`admin` only to `adithyanbraj@gmail.com`.
- `database.rules.json` hardcodes `red.eyes.owner121@…` and
  `mohiuddinarif78@…` as admins (different again).

Three sources of truth disagree about who is an owner. This is both a correctness
and a security problem: a reviewer cannot tell which identities actually hold
power, revoked addresses linger in the Firebase rules, and the `staff` check in
`cloud-access.server.ts` (`hasRole && owners.includes(email)`) depends on
`PERMANENT_OWNER_EMAILS` matching reality.

Fix: pick **one** authoritative source — the Postgres `user_roles` table — and
derive admin from it everywhere. Remove hardcoded emails from rules. Keep a
single, documented bootstrap owner. Ensure every revoked address is actually
removed from `user_roles` and from any remaining rules.

### F-5 — Public `binance-check` leaks config + account status (Medium)

Evidence — `src/routes/api/public/binance-check.ts` is an **unauthenticated
GET** that returns `keySaved`, `secretSaved`, `address`, `payId`, the HTTP status
of a signed Binance `account/status` call, and the **first 300 chars of
Binance's raw response**.

While it does not print the API key itself, it discloses the deposit address,
Pay ID, whether keys are configured, and a slice of live Binance account output —
useful reconnaissance and a privacy leak, exposed to the whole internet.

Fix: require staff auth (verify the login token and `is_staff`), or restrict to
an internal/health path with a shared secret. Never return provider response
bodies to anonymous callers.

### F-6 — On-chain deposit verification weaknesses (Medium)

Evidence — `src/lib/deposit.server.ts`:
- `rpc()` returns the **first** RPC that answers; a single untrusted/misbehaving
  RPC can shape the receipt the server trusts.
- No **minimum confirmation count**: a transaction mined one block ago (age ≤ 10
  min) is credited immediately as `status: "credited"`. Short reorgs could
  reverse a credited deposit.
- `toAmount()` truncates to 2 decimals via integer math; combined with summing
  multiple logs this is a rounding concern, though it rounds against the user,
  not the store.

The idempotency is good — `creditCryptoDeposit` claims `deposits/<hash>` via an
atomic transaction, so a given tx hash credits at most once.

Fix: require N confirmations (e.g. ≥ 12 on BSC/Polygon) before auto-credit;
cross-check at least two RPC endpoints for the receipt; keep large/old deposits
on the manual-approval path (already done for > 10 min).

### F-7 — Admin UI gating is client-only (Low, defense-in-depth)

Evidence — `src/routes/admin.tsx` renders the admin area based solely on the
client `useStore().isAdmin`. A user can force-render the admin UI in the browser.
On the **current Cloud backend this grants nothing**, because every write is
re-authorized server-side in `writeProblem`/`cloudWrite` and RLS blocks direct
table writes. Still, relying on the server check alone is fragile; a future
endpoint that forgets the check would be exposed.

Fix: keep the server-side checks as the real boundary (they are correct today),
and additionally gate admin data loads behind a server `is_staff` check so the UI
cannot even fetch admin data without a role.

### F-8 — Wallet column silently clamped on full-row writes (Medium)

Evidence — `src/lib/cloud-db.server.ts`, `userToRow`:

```ts
row.wallet = Math.max(0, num(u.wallet));
```

When a whole `users/<uid>` node is written (as opposed to the atomic
`dbTransact` on `users/<uid>/wallet`), a negative computed balance is silently
clamped to 0 instead of failing. Combined with F-3's non-atomic debit, an
overspend does not even surface as a negative balance — it just resets to 0,
hiding the loss. The Postgres `CHECK (wallet >= 0)` only guards direct column
updates, not this clamped full-row upsert.

Fix: never recompute wallet on full-row writes; route all balance changes through
the atomic `wallet_adjust()` SQL function (already defined, server-only) or the
`dbTransact` CAS, and let insufficient-funds raise an error rather than clamp.

### F-9 — No rate limiting (Medium)

No throttling is applied to login, password reset, crypto/Binance deposit checks,
checkout, or the reseller API. This enables brute force, deposit-hash guessing,
and amplifies the F-3 race (parallel requests). Add per-IP and per-account rate
limits (and the F-3 fix removes the race regardless).

---

## 4. What Is Already Done Well

- Website wallet changes go through `wallet.server.ts` with an **atomic
  compare-and-swap** that refuses to overspend; prices are read from the DB, not
  the browser.
- All client reads/writes funnel through `cloudRead`/`cloudWrite`
  (`clouddb.functions.ts`) which verify the Supabase token and re-check
  authorization in `cloud-access.server.ts` (`canRead` / `writeProblem`), with a
  default-deny `return "Not allowed"`.
- Postgres **RLS is default-deny**; customers may only `UPDATE` nothing on
  `customers` (only staff policy exists), wallet/stock/payments are server-only,
  and sensitive mutations are `SECURITY DEFINER` functions revoked from
  `anon`/`authenticated`.
- The **service-role key is only used server-side** (`client.server.ts`,
  dynamically imported inside handlers); secret config keys are stripped from the
  public store snapshot (`store-snapshot.server.ts` `SECRET_CONFIG` /
  `publicConfig`).
- **Razorpay webhook signature** is verified with an HMAC-SHA256 and a
  constant-time comparison; deposits are credited **idempotently**
  (`dbCreateIfAbsent` / claim records) across Razorpay, Binance, and crypto.
- Checkout stock claiming uses `claim_stock()` with `FOR UPDATE SKIP LOCKED`.

---

## 5. Hardening Plan (Prioritized)

### Immediate (do today)
1. **Rotate** the Supabase service-role key and publishable key (F-2).
2. **Decommission the Firebase RTDB** and **delete `database.rules.json`** (and
   the Firebase config in `README.md`) if Firebase is retired; otherwise rewrite
   the rules to remove all client wallet/role/admin writes (F-1).
3. Remove `.env` from version control; move secrets to host env; add
   `.env.example` with names only (F-2).
4. Make the reseller `order` debit **atomic** and add idempotency (F-3, F-8).

### Short-term (this week)
5. Make `user_roles` the single source of truth for admin; delete hardcoded
   emails and reconcile revoked admins (F-4).
6. Add auth to `binance-check` or remove it (F-5).
7. Require confirmations + multi-RPC agreement for auto-credit crypto deposits
   (F-6).
8. Add rate limiting to auth, deposits, checkout, and the reseller API (F-9).

### Long-term (ongoing)
9. Route **every** balance change through `wallet_adjust()` and forbid full-row
   wallet recomputation (F-8); add a DB invariant/alert for any direct wallet
   column write outside that function.
10. Add server-side `is_staff` gating for admin data loads, keeping server
    authorization as the real boundary (F-7).
11. Add an immutable audit log for wallet adjustments and admin actions (who,
    when, before/after, request id) and alert the owner on large or unusual
    changes.
12. Add integration tests that assert a non-staff user cannot (a) write their own
    wallet via `cloudWrite`, (b) overspend via concurrent reseller orders, and
    (c) read secret settings — to prevent regressions.

---

## 6. Verification Notes

Findings are based on direct reads of: `database.rules.json`, `.env`,
`README.md`, `src/lib/owners.ts`, `src/lib/cloud-access.server.ts`,
`src/lib/wallet.server.ts`, `src/lib/wallet.functions.ts`,
`src/lib/clouddb.functions.ts`, `src/lib/cloud-db.server.ts`,
`src/context/StoreContext.tsx`, `src/lib/fb/auth.ts`, `src/lib/fb/database.ts`,
`src/components/admin/UsersAdmin.tsx`, `src/routes/admin.tsx`,
`src/routes/admin.index.tsx`, `src/lib/deposit.server.ts`,
`src/lib/binance.server.ts`, `src/lib/razorpay.server.ts`,
`src/routes/api/public/razorpay/webhook.ts`,
`src/routes/api/public/reseller/$.ts`,
`src/routes/api/public/binance-check.ts`,
`src/integrations/supabase/client.ts`,
`src/integrations/supabase/client.server.ts`,
`src/lib/store-snapshot.server.ts`, and
`drizzle/migrations/0000_store_core_schema.sql`.

Not verified at runtime (requires live access): whether the Firebase RTDB
instance is still provisioned and reachable, and whether the committed
service-role key is still valid. Both should be treated as compromised and
rotated/decommissioned regardless. The exact attacker path for the specific $12
incident could not be confirmed from code alone; F-1 is the most consistent
explanation, with F-2 and F-3 as viable alternatives on the Cloud backend.
