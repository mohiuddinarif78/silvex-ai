/** Server-only Razorpay payment links + webhook verification. */
import { dbGet } from "./telegram.server";

export type RazorpayConf = {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  /** How many rupees equal one dollar (default 100). */
  inrPerDollar: number;
  /** Razorpay + GST charge added on top of the payment, in percent (default 3). */
  feePercent: number;
  /** Auto verification fee, in percent (default 1); a random decimal is added to it per payment. */
  verifyFeePercent: number;
  /** Shop name shown on the payment page so buyers know what they are paying for. */
  siteName: string;
};

/** Admin panel settings first, project secrets as fallback. */
export async function razorpayConfig(): Promise<RazorpayConf> {
  const c = (await dbGet<any>("site_settings/config").catch(() => null)) || {};
  return {
    keyId: String(c.razorpayKeyId || process.env["RAZORPAY_KEY_ID"] || "").trim(),
    keySecret: String(c.razorpayKeySecret || process.env["RAZORPAY_KEY_SECRET"] || "").trim(),
    webhookSecret: String(
      c.razorpayWebhookSecret || process.env["RAZORPAY_WEBHOOK_SECRET"] || "",
    ).trim(),
    inrPerDollar: Number(c.inrPerDollar) > 0 ? Number(c.inrPerDollar) : 100,
    // Deposits have no fees anymore — the customer pays exactly the top-up amount.
    feePercent: 0,
    verifyFeePercent: 0,
    siteName: String(c.siteName || "").trim() || "Store",
  };
}

function authHeader(conf: RazorpayConf): string {
  const raw = `${conf.keyId}:${conf.keySecret}`;
  // btoa is available in the Worker runtime.
  return `Basic ${btoa(raw)}`;
}

/**
 * The single source of truth about one payment. Never trust the webhook body
 * or any client input for the amount — this re-fetches the payment straight
 * from Razorpay with the secret key and reports only what Razorpay confirms.
 */
export type VerifiedPayment = {
  ok: boolean;
  /** Why it was rejected (for logs); empty when ok. */
  reason: string;
  paymentId: string;
  /** Rupees Razorpay actually captured (major units). 0 unless ok. */
  inrCaptured: number;
  currency: string;
  live: boolean;
  status: string;
  orderId: string;
  linkId: string;
  notes: Record<string, string>;
};

/**
 * Fetch one payment from Razorpay by id and decide whether it may credit a
 * wallet. A payment qualifies ONLY when Razorpay itself reports it captured,
 * in INR, with a positive captured amount, AND the server is configured with
 * LIVE keys (so test-mode money can never be seen). Authorized-but-not-captured,
 * failed, refunded, or wrong-currency payments are rejected regardless of what
 * the webhook body claimed.
 *
 * Note: we gate on the *key* being live (rzp_live_…), not the payment entity's
 * `live` flag. Razorpay stamps `live: false` on genuine payments for accounts
 * that are activated but not fully live-flagged, and those are still real money.
 * Test payments are only visible with rzp_test_ keys, so a live key is the
 * authoritative test/live boundary; the amount reconciliation in creditDeposit
 * is the primary fraud defence.
 */
export async function verifyRazorpayPayment(paymentId: string): Promise<VerifiedPayment> {
  const empty: VerifiedPayment = {
    ok: false,
    reason: "",
    paymentId: String(paymentId || ""),
    inrCaptured: 0,
    currency: "",
    live: false,
    status: "",
    orderId: "",
    linkId: "",
    notes: {},
  };
  const id = String(paymentId || "").trim();
  if (!id) return { ...empty, reason: "missing payment id" };

  const conf = await razorpayConfig();
  if (!conf.keyId || !conf.keySecret) return { ...empty, reason: "payment keys not configured" };

  let res: Response;
  try {
    res = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(id)}`, {
      headers: { authorization: authHeader(conf) },
    });
  } catch {
    return { ...empty, reason: "could not reach Razorpay" };
  }
  const p = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    return { ...empty, reason: `Razorpay fetch failed (${res.status})` };
  }

  const status = String(p?.status || "");
  const currency = String(p?.currency || "");
  // Razorpay marks sandbox entities with `live: false`. Treat a missing flag as
  // not-live so a malformed/foreign response can never slip through.
  const live = p?.live === true;
  const captured = p?.captured === true || status === "captured";
  const amount = Number(p?.amount_captured ?? (captured ? p?.amount : 0)) || 0;
  const inrCaptured = Math.round(amount) / 100;
  const notes = (p?.notes && typeof p.notes === "object" ? p.notes : {}) as Record<string, string>;

  const base: VerifiedPayment = {
    ...empty,
    paymentId: String(p?.id || id),
    inrCaptured,
    currency,
    live,
    status,
    orderId: String(p?.order_id || ""),
    linkId: String(p?.payment_link_id || ""),
    notes,
  };

  // The real test/live boundary is the key: a live key cannot even fetch a
  // test payment. We record the entity `live` flag for auditing but do not
  // reject on it (genuine payments can carry live:false on provisional
  // accounts).
  const liveKey = conf.keyId.startsWith("rzp_live_");
  if (!liveKey) return { ...base, reason: "server is not using live Razorpay keys" };
  if (status !== "captured" || !captured) return { ...base, reason: `payment not captured (status=${status || "unknown"})` };
  if (currency !== "INR") return { ...base, reason: `unexpected currency ${currency || "unknown"}` };
  if (!(inrCaptured > 0)) return { ...base, reason: "no amount captured" };

  return { ...base, ok: true };
}

export type LinkResult =
  | { ok: true; url: string; id: string; inr: number; baseInr: number; feeInr: number; feePercent: number }
  | { ok: false; error: string };

/** Creates a unique payment link for one deposit. */
export async function createPaymentLink(opts: {
  usd: number;
  uid: string;
  name?: string;
  email?: string;
  phone?: string;
  source: "web" | "telegram";
  siteUrl?: string;
  /** When the payment is for one product, it is delivered right after it clears. */
  productId?: string;
  qty?: number;
  /** Telegram chat that should receive the delivery. */
  chatId?: number;
}): Promise<LinkResult> {
  const conf = await razorpayConfig();
  if (!conf.keyId || !conf.keySecret) {
    return { ok: false, error: "Card/UPI payments are not set up yet." };
  }
  const usd = Math.round(Number(opts.usd) * 100) / 100;
  if (!usd || usd <= 0) return { ok: false, error: "Enter a valid amount." };
  // No deposit fees: the customer pays exactly the top-up amount.
  const basePaise = Math.round(usd * conf.inrPerDollar * 100);
  const totalPct = 0;
  const feePaise = 0;
  const totalPaise = basePaise;
  const baseInr = Math.round(basePaise) / 100;
  const feeInr = 0;
  const inr = Math.round(totalPaise) / 100;
  if (totalPaise < 100) return { ok: false, error: "Amount is too small." };


  // Razorpay rejects anything odd here, so only send details it accepts.
  const digits = String(opts.phone || "").replace(/[^\d+]/g, "");
  const contact = digits.length >= 8 && digits.length <= 14 ? digits : "";
  const rawEmail = String(opts.email || "").trim();
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) ? rawEmail : "";
  const name = String(opts.name || "").trim().slice(0, 60);

  const body: Record<string, unknown> = {
    amount: totalPaise,
    currency: "INR",
    accept_partial: false,
    description: `${conf.siteName}: $${usd.toFixed(2)} wallet top-up`.slice(0, 60),
    // Keep it unique but short: long user ids used to get cut off, which made
    // Razorpay reject every link after the first one.
    reference_id: `dep_${String(opts.uid).slice(-12)}_${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 6)}`.slice(0, 40),

    notify: { sms: false, email: Boolean(email) },
    reminder_enable: false,
    notes: {
      uid: opts.uid,
      usd: String(usd),
      source: opts.source,
      email,
      fee_inr: feeInr.toFixed(2),
      pid: String(opts.productId || ""),
      qty: String(Math.max(1, Math.floor(Number(opts.qty) || 1))),
      chat: String(opts.chatId || ""),
    },
  };

  const customer: Record<string, string> = {};
  if (name) customer["name"] = name;
  if (email) customer["email"] = email;
  if (contact) customer["contact"] = contact;
  if (Object.keys(customer).length) body["customer"] = customer;

  let base = String(opts.siteUrl || "").trim().replace(/\/+$/, "");
  if (base && !/^https?:\/\//i.test(base)) base = `https://${base}`;
  if (/^https:\/\/[^\s/]+\.[^\s/]+/i.test(base)) {
    body["callback_url"] = `${base}/profile`;
    body["callback_method"] = "get";
  }

  let res: Response;
  try {
    res = await fetch("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: authHeader(conf) },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: "Could not reach the payment provider. Try again." };
  }
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    const desc = String(json?.error?.description || "");
    if (res.status === 401) {
      return { ok: false, error: "Payment keys are wrong. Check the key ID and secret in Settings." };
    }
    return { ok: false, error: desc || `Payment provider error (${res.status})` };
  }
  if (!json?.short_url) return { ok: false, error: "Payment provider did not return a link." };

  // Show the payment straight away as "Pending" in the wallet history; it turns
  // into "Paid" the moment the money is confirmed.
  const linkId = String(json.id);
  const { dbPut } = await import("./telegram.server");
  await dbPut(`users/${opts.uid}/history/rzp_${linkId.replace(/[.#$/[\]]/g, "_")}`, {
    type: "Deposit",
    status: "Pending",
    amount: usd,
    desc: opts.productId
      ? `Card/UPI payment for an order (₹${inr.toFixed(0)}) — waiting for confirmation`
      : `Card/UPI payment (₹${inr.toFixed(0)}) — waiting for confirmation`,
    linkId,
    date: new Date().toISOString(),
  }).catch(() => undefined);
  await dbPut(`razorpayLinks/${linkId.replace(/[.#$/[\]]/g, "_")}`, {
    uid: opts.uid,
    usd,
    inr,
    productId: opts.productId || "",
    qty: Math.max(1, Math.floor(Number(opts.qty) || 1)),
    chatId: Number(opts.chatId || 0),
    status: "Pending",
    date: new Date().toISOString(),
  }).catch(() => undefined);

  return {
    ok: true,
    url: String(json.short_url),
    id: String(json.id),
    inr,
    baseInr,
    feeInr,
    feePercent: totalPct,
  };
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafe(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when the raw body really came from Razorpay. */
export async function verifyWebhook(rawBody: string, signature: string): Promise<boolean> {
  const conf = await razorpayConfig();
  if (!conf.webhookSecret || !signature) return false;
  return timingSafe(await hmacHex(conf.webhookSecret, rawBody), signature.trim());
}

/**
 * Adds a verified, captured payment to a wallet exactly once and tells the
 * buyer. The USD credited is computed HERE from the rupees Razorpay actually
 * captured and the server-side rate — the caller cannot dictate the amount.
 * Every id Razorpay gives us for the same payment (payment id and payment
 * link id) is remembered, so the same rupee can never be counted twice even
 * when Razorpay sends several notifications for one payment.
 */
export async function creditDeposit(opts: {
  uid: string;
  /** Rupees Razorpay actually captured. The ONLY input that sets the amount. */
  inr: number;
  paymentId: string;
  linkId?: string;
  email?: string;
  /** Product to hand over right after the money is confirmed. */
  productId?: string;
  qty?: number;
  chatId?: number;
}): Promise<{ credited: boolean; balance: number; reason?: string }> {
  const { dbCreateIfAbsent, dbGet, dbPut, dbPatch, dbPush, notifyOwners, money, tg } = await import("./telegram.server");
  const conf = await razorpayConfig();
  const current = Number((await dbGet<number>(`users/${opts.uid}/wallet`)) || 0);
  const inrCaptured = Math.round(Number(opts.inr) * 100) / 100;
  if (!opts.uid || !opts.paymentId || !(inrCaptured > 0)) {
    return { credited: false, balance: current, reason: "missing uid/payment or no captured amount" };
  }

  // The dollar amount is always derived server-side from the rupees received
  // and the server's own rate. notes.usd is never used to set the credit.
  const rate = Number(conf.inrPerDollar) > 0 ? Number(conf.inrPerDollar) : 100;
  const usd = Math.round((inrCaptured / rate) * 100) / 100;
  if (!(usd > 0)) return { credited: false, balance: current, reason: "computed usd is zero" };

  // Reconcile against what the deposit link was created to charge. A captured
  // amount far below the expected amount (the ₹60-for-$1000 attack) is rejected
  // and flagged, never credited.
  const safeLink = String(opts.linkId || "").replace(/[.#$/[\]]/g, "_");
  if (safeLink) {
    const link = await dbGet<any>(`razorpayLinks/${safeLink}`).catch(() => null);
    const expectedInr = Number(link?.inr) || 0;
    if (expectedInr > 0) {
      // Allow a 1% (or ₹1) tolerance for Razorpay fee rounding only.
      const tolerance = Math.max(1, expectedInr * 0.01);
      if (inrCaptured + tolerance < expectedInr) {
        await notifyOwners(
          `🚨 Razorpay underpayment blocked\nUser: ${opts.uid}\nExpected ₹${expectedInr.toFixed(0)} but captured ₹${inrCaptured.toFixed(0)}\nPayment: ${opts.paymentId}`,
        ).catch(() => undefined);
        return { credited: false, balance: current, reason: `captured ₹${inrCaptured} below expected ₹${expectedInr}` };
      }
    }
    if (link?.uid && String(link.uid) !== String(opts.uid)) {
      return { credited: false, balance: current, reason: "link belongs to a different user" };
    }
  }

  const keys = [...new Set([opts.paymentId, opts.linkId || ""].filter(Boolean))];
  const seen = await Promise.all(
    keys.map((k) => dbGet<any>(`razorpayPayments/${k}`).catch(() => null)),
  );
  if (seen.some(Boolean)) return { credited: false, balance: current, reason: "already credited" };

  const date = new Date().toISOString();
  const record = {
    uid: opts.uid,
    usd,
    inr: inrCaptured,
    status: "Credited",
    email: opts.email || "",
    paymentId: opts.paymentId,
    linkId: opts.linkId || "",
    date,
  };

  // One PAYMENT is one irreversible claim. The claim must be keyed on a value
  // that is identical across every path that can credit it. The payment id is
  // the only such value: a UPI payment may arrive with no payment_link_id (so
  // the link id differs or is empty between the webhook and the "I have paid"
  // settle path), which previously let the same payment be claimed twice under
  // two different keys — a double credit. The payment id is always present and
  // unique, so claim on it.
  const claimId = String(opts.paymentId).replace(/[.#$/[\]]/g, "_");
  const claimed = await dbCreateIfAbsent(`razorpayPaymentClaims/${claimId}`, record);
  if (!claimed) {
    const latest = Number((await dbGet<number>(`users/${opts.uid}/wallet`)) || 0);
    return { credited: false, balance: latest, reason: "already credited" };
  }

  // Keep the old lookup records for compatibility and payment-id auditing.
  await Promise.all(keys.map((k) => dbPut(`razorpayPayments/${k}`, record)));
  const { walletAdd } = await import("./wallet.server");
  const balance = Number((await walletAdd(opts.uid, usd)) ?? current);

  // Turn the earlier "Pending" line into a paid one, or add a fresh paid line.
  const entry = {
    type: "Deposit",
    status: "Paid",
    amount: usd,
    desc: `Card/UPI payment (₹${inrCaptured.toFixed(0)})`,
    paymentId: opts.paymentId,
    linkId: opts.linkId || "",
    date,
  };
  // Write the paid line under a STABLE, idempotent key so it can never be
  // duplicated. When a link id exists we reuse the "Pending" line's key
  // (rzp_<link>); otherwise (UPI payments often carry no link id) we key on the
  // payment id, which is always present and unique. The previous dbPush
  // fallback used a random key, so the history-sync layer could not dedupe it
  // and an overlapping re-sync inserted the same deposit twice (double credit).
  const historyKey = safeLink
    ? `rzp_${safeLink}`
    : `rzp_${String(opts.paymentId).replace(/[.#$/[\]]/g, "_")}`;
  await dbPut(`users/${opts.uid}/history/${historyKey}`, entry);
  if (safeLink) await dbPatch(`razorpayLinks/${safeLink}`, { status: "Paid", paidAt: date });


  const tgId = Number(opts.uid.startsWith("tg_") ? opts.uid.slice(3) : 0);
  if (tgId > 0) {
    await tg("sendMessage", {
      chat_id: tgId,
      parse_mode: "HTML",
      text: `✅ <b>Deposit done</b>\n${money(usd)} added by card/UPI (₹${inrCaptured.toFixed(0)}).\nNew balance: <b>${money(balance)}</b>`,
    }).catch(() => undefined);
  }
  void import("./push.server").then(({ pushUser }) =>
    pushUser(opts.uid, { title: "✅ Deposit done", body: `${money(usd)} added. New balance ${money(balance)}`, url: "/history" }),
  ).catch(() => undefined);
  await notifyOwners(
    `💳 Deposit credited\nUser: ${opts.uid}\nAmount: ${money(usd)} (₹${inrCaptured.toFixed(0)})\nPayment: ${opts.paymentId}`,
  ).catch(() => undefined);

  // The payment was made for one product: hand it over straight away.
  const deliverChat = Number(opts.chatId || tgId || 0);
  if (opts.productId && deliverChat > 0) {
    try {
      const { buy } = await import("@/lib/bot/shop");
      await buy(deliverChat, opts.productId, Math.max(1, Math.floor(Number(opts.qty) || 1)));
      if (safeLink) await dbPatch(`razorpayLinks/${safeLink}`, { status: "Delivered" });
      if (safeLink)
        await dbPatch(`users/${opts.uid}/history/rzp_${safeLink}`, {
          desc: `Card/UPI payment (₹${inrCaptured.toFixed(0)}) — order delivered`,
        });
    } catch {
      await notifyOwners(
        `⚠️ Paid order needs manual delivery\nUser: ${opts.uid}\nProduct: ${opts.productId} x${opts.qty || 1}`,
      ).catch(() => undefined);
    }
  }
  return { credited: true, balance };
}

/**
 * Asks Razorpay whether one payment link was paid, and credits it if so.
 * This keeps deposits working even before the callback address is saved in
 * the Razorpay dashboard.
 */
export async function settlePaymentLink(
  linkId: string,
): Promise<{ status: "paid" | "pending" | "error"; message: string; balance?: number }> {
  const conf = await razorpayConfig();
  if (!conf.keyId || !conf.keySecret) return { status: "error", message: "Card/UPI payments are not set up yet." };
  let res: Response;
  try {
    res = await fetch(`https://api.razorpay.com/v1/payment_links/${encodeURIComponent(linkId)}`, {
      headers: { authorization: authHeader(conf) },
    });
  } catch {
    return { status: "error", message: "Could not reach the payment provider. Try again." };
  }
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) return { status: "error", message: String(json?.error?.description || `Provider error (${res.status})`) };

  // Find the underlying payment id Razorpay recorded against this link, then
  // verify THAT payment directly (captured + live + INR). The payment-link
  // object's own amount_paid is never trusted to set the credit.
  const link = String(json?.id || linkId);
  const notes = (json?.notes || {}) as Record<string, string>;
  const payments = Array.isArray(json?.payments) ? json.payments : [];
  const paidRow = payments.find((p: any) => String(p?.status || "") === "captured") || payments[0];
  let paymentId = String(paidRow?.payment_id || paidRow?.id || "");

  // Fallback: UPI payments are not always listed under the payment link's
  // `payments[]` right away (and the link's order id differs from the final
  // pay_ id). When the link carries an order id, ask the order for its captured
  // payment directly — this is the reliable id to verify and credit.
  if (!paymentId) {
    const orderId = String(json?.order_id || "");
    if (orderId) {
      try {
        const ores = await fetch(
          `https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}/payments`,
          { headers: { authorization: authHeader(conf) } },
        );
        const ojson = (await ores.json().catch(() => ({}))) as any;
        const items = Array.isArray(ojson?.items) ? ojson.items : [];
        const captured = items.find((p: any) => String(p?.status || "") === "captured") || items[0];
        paymentId = String(captured?.id || "");
      } catch {
        /* fall through to "not received" below */
      }
    }
  }
  if (!paymentId) return { status: "pending", message: "We have not received this payment yet." };

  const verified = await verifyRazorpayPayment(paymentId);
  if (!verified.ok) {
    // Not a genuine captured live INR payment — do not credit anything.
    return { status: "pending", message: "We have not received a confirmed payment yet." };
  }

  const uid = String(verified.notes["uid"] || notes["uid"] || "");
  const out = await creditDeposit({
    uid,
    inr: verified.inrCaptured,
    paymentId: verified.paymentId,
    linkId: link,
    email: verified.notes["email"] || notes["email"] || "",
    productId: String(verified.notes["pid"] || notes["pid"] || ""),
    qty: Number(verified.notes["qty"] || notes["qty"] || 1),
    chatId: Number(verified.notes["chat"] || notes["chat"] || 0),
  });
  return out.credited
    ? { status: "paid", message: "Payment received.", balance: out.balance }
    : { status: "paid", message: "This payment was already added to your wallet.", balance: out.balance };
}
