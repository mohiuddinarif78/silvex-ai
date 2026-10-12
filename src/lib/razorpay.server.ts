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
 * Adds a paid amount to a wallet exactly once and tells the buyer.
 * Every id Razorpay gives us for the same payment (payment id and payment
 * link id) is remembered, so the same rupee can never be counted twice even
 * when Razorpay sends several notifications for one payment.
 */
export async function creditDeposit(opts: {
  uid: string;
  usd: number;
  inr: number;
  paymentId: string;
  linkId?: string;
  email?: string;
  /** Product to hand over right after the money is confirmed. */
  productId?: string;
  qty?: number;
  chatId?: number;
}): Promise<{ credited: boolean; balance: number }> {
  const { dbCreateIfAbsent, dbGet, dbPut, dbPatch, dbPush, notifyOwners, money, tg } = await import("./telegram.server");
  const current = Number((await dbGet<number>(`users/${opts.uid}/wallet`)) || 0);
  if (!opts.uid || !opts.paymentId || !(opts.usd > 0)) return { credited: false, balance: current };

  const keys = [...new Set([opts.paymentId, opts.linkId || ""].filter(Boolean))];
  const seen = await Promise.all(
    keys.map((k) => dbGet<any>(`razorpayPayments/${k}`).catch(() => null)),
  );
  if (seen.some(Boolean)) return { credited: false, balance: current };

  const date = new Date().toISOString();
  const record = {
    uid: opts.uid,
    usd: opts.usd,
    inr: opts.inr,
    status: "Credited",
    email: opts.email || "",
    paymentId: opts.paymentId,
    linkId: opts.linkId || "",
    date,
  };

  // One payment link is one irreversible claim. A button tap and Razorpay's
  // webhook can arrive together on separate servers; an ordinary read/write
  // pair lets both continue. The ETag claim allows exactly one of them through.
  const claimId = String(opts.linkId || opts.paymentId).replace(/[.#$/[\]]/g, "_");
  const claimed = await dbCreateIfAbsent(`razorpayPaymentClaims/${claimId}`, record);
  if (!claimed) {
    const latest = Number((await dbGet<number>(`users/${opts.uid}/wallet`)) || 0);
    return { credited: false, balance: latest };
  }

  // Keep the old lookup records for compatibility and payment-id auditing.
  await Promise.all(keys.map((k) => dbPut(`razorpayPayments/${k}`, record)));
  const { walletAdd } = await import("./wallet.server");
  const balance = Number((await walletAdd(opts.uid, opts.usd)) ?? current);

  // Turn the earlier "Pending" line into a paid one, or add a fresh paid line.
  const entry = {
    type: "Deposit",
    status: "Paid",
    amount: opts.usd,
    desc: `Card/UPI payment (₹${opts.inr.toFixed(0)})`,
    paymentId: opts.paymentId,
    linkId: opts.linkId || "",
    date,
  };
  const safeLink = String(opts.linkId || "").replace(/[.#$/[\]]/g, "_");
  if (safeLink) await dbPut(`users/${opts.uid}/history/rzp_${safeLink}`, entry);
  else await dbPush(`users/${opts.uid}/history`, entry);
  if (safeLink) await dbPatch(`razorpayLinks/${safeLink}`, { status: "Paid", paidAt: date });


  const tgId = Number(opts.uid.startsWith("tg_") ? opts.uid.slice(3) : 0);
  if (tgId > 0) {
    await tg("sendMessage", {
      chat_id: tgId,
      parse_mode: "HTML",
      text: `✅ <b>Deposit done</b>\n${money(opts.usd)} added by card/UPI (₹${opts.inr.toFixed(0)}).\nNew balance: <b>${money(balance)}</b>`,
    }).catch(() => undefined);
  }
  void import("./push.server").then(({ pushUser }) =>
    pushUser(opts.uid, { title: "✅ Deposit done", body: `${money(opts.usd)} added. New balance ${money(balance)}`, url: "/history" }),
  ).catch(() => undefined);
  await notifyOwners(
    `💳 Deposit credited\nUser: ${opts.uid}\nAmount: ${money(opts.usd)} (₹${opts.inr.toFixed(0)})\nPayment: ${opts.paymentId}`,
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
          desc: `Card/UPI payment (₹${opts.inr.toFixed(0)}) — order delivered`,
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

  // Only a link Razorpay itself marks as paid, with money really received.
  const amountPaid = Number(json?.amount_paid || 0);
  const paid = String(json?.status || "") === "paid" && amountPaid > 0;
  if (!paid) return { status: "pending", message: "We have not received this payment yet." };

  const notes = (json?.notes || {}) as Record<string, string>;
  const inr = amountPaid / 100;
  const usd =
    Number(notes["usd"]) > 0 ? Number(notes["usd"]) : Math.round((inr / conf.inrPerDollar) * 100) / 100;
  const uid = String(notes["uid"] || "");
  const link = String(json?.id || linkId);
  const captured = (Array.isArray(json?.payments) ? json.payments : []).find(
    (p: any) => String(p?.status || "") === "captured" || Number(p?.amount || 0) > 0,
  );
  const paymentId = String(captured?.payment_id || captured?.id || link);
  const out = await creditDeposit({
    uid,
    usd,
    inr,
    paymentId,
    linkId: link,
    email: notes["email"] || "",
    productId: String(notes["pid"] || ""),
    qty: Number(notes["qty"] || 1),
    chatId: Number(notes["chat"] || 0),
  });
  return out.credited
    ? { status: "paid", message: "Payment received.", balance: out.balance }
    : { status: "paid", message: "This payment was already added to your wallet.", balance: out.balance };
}
