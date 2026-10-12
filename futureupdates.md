# Future Updates

Deferred work, not urgent today. Security findings reference `securityanalysis.md`.

## 1. Deposit hashes can be claimed by another account (F-10, Medium)

**Problem.** Crypto deposits are credited to whichever signed-in account submits
the transaction hash first. Hashes are public on block explorers, so someone
watching the store's deposit wallet can paste a stranger's hash into their own
account before the real payer does.

**Affected code**
- Website: `submitCryptoDeposit` → `creditCryptoDeposit` (`src/lib/wallet.server.ts`)
- Bot: `dep_hash` flow → `claimAndCreditDeposit` (`src/lib/bot/route-text.ts`)
- Support bot: `check_deposit` tool (`src/lib/bot/support.ts`)
- Binance on-chain deposits: `settleBinanceDeposit` (`src/lib/binance.server.ts`)
- Not affected: Binance Pay (order id is private to the payer).

**Recommended fix — unique amount per deposit request**
1. Customer taps Deposit and enters an amount (e.g. $10).
2. Server creates a request `{ uid, amount: 10.03, expiresAt: +2h }`, choosing
   cents so no other open request has the same amount (claim atomically).
3. Customer sends exactly that amount and pastes the hash as today.
4. On verification, credit the account that owns the matching open request,
   not the submitter. Mark the request used.
5. No match (wrong amount, exchange fee deducted, expired) → send to the
   existing admin manual-approval queue instead of auto-crediting.

Tradeoff: one extra step for customers; exchange withdrawals that deduct fees
will need manual approval.

**Rejected alternatives**
- Register sending wallet first: addresses are public and exchange hot wallets
  are shared, so this can be pre-claimed or can't identify the customer.
- All deposits manual: safest but slow and more admin work. Use as a stopgap
  if abuse is seen before the fix lands.

**Small related tightening.** `findBinanceDeposit` accepts a partial tx id
(`cleanTx(r.txId).includes(wanted)`, min 16 chars). Require an exact full-id
match.

## 2. Reseller API: partial supplier delivery charges full price

`src/routes/api/public/reseller/$.ts` — if a supplier delivers fewer items than
ordered (e.g. 3 of 5), the API charges the full price and marks the order
Pending. Website checkout refunds the missing items; the API should do the same
(atomic refund of `missing × unit price`).

## 3. Rate-limit storage for scale-out

`src/lib/rate-limit.server.ts` keeps counters in memory. Fine for the current
single Railway instance; move to Redis or the database if the service runs more
than one replica.

## 4. Supplier keys in git history

Old supplier API keys (Qamify, MMO Store, Safwan Tiger, CupponHub, Eklas) were
removed from source but remain in git history. They belong to the previous
owner, who should revoke them at each shop.
