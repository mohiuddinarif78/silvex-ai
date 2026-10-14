# Payment System Security (Razorpay Deposits)

This document describes how card/UPI wallet deposits work, how they are secured,
and the rules every change to this subsystem must preserve.

The guiding principle: **the webhook endpoint is public, so security never relies
on it being hidden.** Every credit is proven by a server-to-server re-fetch from
Razorpay using the secret key, validated server-side, and applied atomically and
exactly once.

---

## 1. Components

| File | Responsibility |
|------|----------------|
| `src/lib/razorpay.server.ts` | Config, link creation, **payment verification**, crediting, link settlement, webhook signature check. |
| `src/routes/api/public/razorpay/webhook.ts` | Public webhook endpoint. Verifies signature, then delegates to verification + crediting. |
| `src/lib/razorpay.functions.ts` | Authenticated server functions: `createDepositLink` (credits the verified caller only), `checkDepositLink` (manual settle). |
| `src/lib/wallet.server.ts` | Atomic wallet primitives (`walletAdd` CAS). |
| `src/lib/telegram.server.ts` | DB helpers: `dbCreateIfAbsent` (atomic claim), `dbTransact` (CAS), `dbGet/dbPut/dbPatch`. |
| `scripts/audit-razorpay-credits.ts` | Read-only historical audit for mis-credits. |

---

## 2. Payment flow

1. **Link creation** — a signed-in user calls `createDepositLink`. The server
   verifies the caller's token (`requireCaller`) and creates the link for **that
   verified uid only** — never a browser-supplied uid. It stores the expected
   charge at `razorpayLinks/<linkId>` as `{ uid, usd, inr }`. This stored
   `inr` is the amount the user is expected to pay and is later used for
   reconciliation.
2. **Payment** — the user pays on Razorpay's hosted page.
3. **Notification** — Razorpay calls the webhook (`payment.captured` /
   `payment_link.paid` / `order.paid`). A manual `checkDepositLink` path exists as
   a fallback.
4. **Verification** — the server re-fetches the payment from Razorpay and
   validates it (section 4).
5. **Credit** — only if verification passes, the wallet is credited atomically,
   exactly once, by the server-derived USD amount (section 5–7).

---

## 3. Webhook integration & signature verification

- The endpoint reads the **raw request body** (`request.text()`) *before* any
  JSON parsing. The signature is computed over the exact bytes Razorpay signed.
- `verifyWebhook(rawBody, signature)` computes `HMAC-SHA256(rawBody,
  webhookSecret)` and compares it to the `x-razorpay-signature` header using a
  **constant-time** comparison (`timingSafe`). Missing secret or signature →
  reject.
- An invalid signature returns `401` and nothing else happens.

Signature verification authenticates the *trigger*. It is **not** the source of
truth for the amount — see section 4. This is intentional: even a perfectly
signed webhook body is treated as untrusted data for amount/status/notes.

---

## 4. Server-side verification (the trust boundary)

`verifyRazorpayPayment(paymentId)` is the single source of truth. It:

1. Takes **only the payment id** from the (already signature-checked) webhook, or
   from the payment link in the manual path.
2. Calls `GET https://api.razorpay.com/v1/payments/{id}` with the **secret key**
   (HTTP Basic auth). This is a server-to-server call Razorpay authenticates;
   the response cannot be forged by a client.
3. Accepts the payment **only if all** of these hold:
   - the server is configured with a **live key** (`rzp_live_…`) — a live key
     cannot fetch test-mode payments, so this is the real test/live boundary.
     (The payment entity's own `live` flag is recorded for auditing but not
     used to reject: Razorpay stamps `live: false` on genuine payments for
     provisional/not-fully-activated accounts, and that is still real money.)
   - `status === "captured"` and `captured === true` — rejects
     authorized-but-not-captured, failed, pending, refunded.
   - `currency === "INR"` — rejects unexpected currencies.
   - `amount_captured > 0` — rejects zero captures.
4. Returns `inrCaptured` (the rupees Razorpay actually captured), `notes`,
   `linkId`, and an `ok` flag with a human `reason` when rejected.

If `ok` is false, **no credit happens.**

---

## 5. Amount & currency validation (no manipulation possible)

- The credited USD is **computed on the server** as
  `inrCaptured / inrPerDollar`, where `inrPerDollar` is the server's own rate
  from `site_settings/config` (default 100).
- `notes.usd`, any browser-supplied amount, and any webhook-body amount are
  **never** used to set the credit. The old bug was trusting `notes.usd`; that
  path no longer exists.
- **Reconciliation:** `creditDeposit` loads `razorpayLinks/<linkId>` and, if an
  expected `inr` is recorded, rejects the credit when
  `inrCaptured + tolerance < expectedInr` (tolerance = max(₹1, 1% of expected),
  to absorb only gateway fee rounding). This blocks the ₹60-for-$1000
  underpayment. Underpayments are logged and the owners are notified.
- **Ownership:** if the link records a `uid` that differs from the crediting
  uid, the credit is rejected (a link cannot credit a different account).

---

## 6. Idempotency (exactly-once crediting)

- Each payment is claimed via `dbCreateIfAbsent("razorpayPaymentClaims/<id>")`,
  an **atomic create-if-absent**. The claim key is the link id (preferred) or
  the payment id. Only the first caller wins the claim; concurrent or repeated
  webhooks lose and credit nothing.
- A secondary guard reads `razorpayPayments/<paymentId>` and
  `razorpayPayments/<linkId>` and skips if either already exists.
- Result: duplicate webhook delivery, retries, and the webhook racing the manual
  `checkDepositLink` all credit **at most once**.

---

## 7. Database & transaction handling

- The wallet is changed only through `walletAdd` → `dbTransact` on
  `users/<uid>/wallet`, an atomic **compare-and-swap** that refuses to go
  negative and never does read-modify-write. This prevents lost-update races and
  overspends.
- The claim (`dbCreateIfAbsent`) and the balance change (`walletAdd`) together
  make crediting atomic and single-shot even under concurrency across replicas.
- Customers cannot write wallet/history fields directly (server-only writes +
  Postgres RLS, see `cloud-access.server.ts`).

---

## 8. Invalid-state rejection

No credit is ever added for:
- test-mode payments (`live !== true`),
- non-captured states (authorized, failed, pending, refunded),
- non-INR currency,
- zero/negative captured amount,
- captured amount below the link's expected amount (beyond tolerance),
- payments whose link belongs to a different user,
- payments already credited.

---

## 9. Error handling & logging

- Network/API failures during verification return a non-credit result; the
  payment is simply not credited (fail-closed). Razorpay retries the webhook, so
  a transient failure self-heals without a bad credit.
- Rejections carry a `reason` string for logs.
- Owners are notified on: successful credit, blocked underpayment, and a paid
  order that needs manual delivery.
- The webhook never echoes secrets and returns only `ok` / `ignored` /
  `Invalid signature`.

---

## 10. Security best practices enforced here

- **Never trust the client or the webhook body for money.** Re-verify server to
  server with the secret key.
- **Public endpoint, zero-trust body.** Security does not depend on the endpoint
  being secret.
- **Server-side authoritative amount and rate.** No client/notes amount is used.
- **Exactly-once** via atomic claim; **atomic** wallet CAS.
- **Fail closed** on any uncertainty.
- Secret keys come from server config/env only, never the client bundle.

---

## 11. Operational checklist before enabling in production

1. Confirm **live** Razorpay keys and webhook secret are set in server config/env.
2. Confirm the webhook is subscribed to `payment.captured` (and optionally
   `payment_link.paid`).
3. Run `npx tsx scripts/audit-razorpay-credits.ts` and review/clawback any
   historical mis-credits.
4. Run the security test suite (`npm test`) — all green.
5. Run `npm run build` — succeeds.

---

## 12. Historical incident

An attacker generated payments (test-mode / tiny amounts) whose links were
created for `$1000` and received `$1000` credits each because the old code
credited `notes.usd` without checking the rupees actually captured or whether the
payment was live. The merchant received no money. Fixed by sections 4–6: credit
is now derived from the verified captured INR, reconciled against the expected
link amount, and test-mode payments are rejected outright.
