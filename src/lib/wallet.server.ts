/**
 * Every wallet change made from the website runs here, on the server, after
 * checking the customer's login. Customers can no longer change their own
 * balance from the browser — the database rules block it.
 */
import { dbCreateIfAbsent, dbGet, dbPatch, dbPush, dbPut, dbTransact, dbWalletAdjust, loadBotRuntime } from "./telegram.server";

const round = (n: number) => Math.round(n * 100) / 100;
const now = () => new Date().toISOString();

/** Confirms a Firebase login token and returns the account id. */
export async function verifyIdToken(idToken: string): Promise<{ uid: string; email: string }> {
  const { callerFromToken } = await import("./cloud-access.server");
  const who = await callerFromToken(idToken);
  if (!who) throw new Error("Please log in again.");
  if (await dbGet<boolean>(`users/${who.uid}/blocked`).catch(() => false)) throw new Error("This account is blocked.");
  return { uid: who.uid, email: who.email };
}

/**
 * The ONE way to change a balance by an amount: an atomic compare-and-swap.
 * Returns the new balance, or `undefined` (and writes nothing) when the change
 * would make the balance negative. Never read a wallet and write it back.
 */
export async function walletAdd(uid: string, delta: number): Promise<number | undefined> {
  return dbTransact<number>(`users/${uid}/wallet`, (w) => {
    const next = round((Number(w) || 0) + delta);
    return next < 0 ? undefined : next;
  });
}

/** Writes a wallet-history line (used by the purchase debit path). */
async function history(uid: string, type: string, amount: number, desc: string) {
  await dbPush(`users/${uid}/history`, { type, amount, desc, date: now() });
}

/**
 * Record a verified on-chain deposit exactly once and credit it atomically.
 * Returns the new balance, or `null` when this transaction was already used
 * (a second tap / second channel gets nothing).
 */
export async function claimAndCreditDeposit(
  uid: string,
  hash: string,
  record: Record<string, unknown>,
  amount: number,
  desc: string,
): Promise<number | null> {
  const claimed = await dbCreateIfAbsent(`deposits/${hash}`, { ...record, status: "Credited" });
  if (!claimed) return null;
  const balance = await dbWalletAdjust(uid, amount, "Deposit", desc);
  return Number(balance ?? 0);
}

/**
 * Approve or reject a pending wallet request exactly once. The request is
 * claimed atomically, so two admins (or a double tap) cannot apply it twice.
 */
export async function decideWalletRequest(
  id: string,
  approve: boolean,
): Promise<{ ok: true; request: any; delta: number } | { ok: false; error: string }> {
  let claimed: any = null;
  const out = await dbTransact<any>(`requests/${id}`, (r) => {
    if (!r || String(r.status || "").toLowerCase() !== "pending") return undefined;
    claimed = r;
    return { ...r, status: approve ? "Approved" : "Rejected" };
  });
  if (!out || !claimed) return { ok: false, error: "Request not found or already handled." };
  if (!approve) return { ok: true, request: claimed, delta: 0 };

  const amount = Number(claimed.amount) || 0;
  const delta = claimed.type === "Deposit" ? amount : -amount;
  const balance = await dbWalletAdjust(String(claimed.uid), delta, claimed.type, `${claimed.type} approved`);
  if (balance === undefined) {
    // Not enough money for a withdrawal: put the request back untouched.
    await dbPatch(`requests/${id}`, { status: "Pending" });
    return { ok: false, error: "User has insufficient balance." };
  }
  return { ok: true, request: claimed, delta };
}

/** Admin cancel: mark the order cancelled once, then refund it atomically. */
export async function adminCancelAndRefund(
  orderId: string,
): Promise<{ ok: boolean; refund: number; uid: string }> {
  let refund = 0;
  let uid = "";
  const out = await dbTransact<any>(`orders/${orderId}`, (o) => {
    if (!o || o.status === "Cancelled") return undefined;
    refund = Number(o.total) || 0;
    uid = String(o.uid || "");
    return { ...o, status: "Cancelled" };
  });
  if (!out) return { ok: false, refund: 0, uid: "" };
  if (uid && refund > 0) {
    await dbWalletAdjust(uid, refund, "Refund", `Cancelled ${orderId.slice(-4)}`);
  }
  return { ok: true, refund, uid };
}

/**
 * Pay the referrer their commission on a purchase, capped per friend. The cap
 * counter and the wallet are both changed atomically. Returns the amount paid.
 */
export async function addReferralCommission(refBy: string, buyerUid: string, total: number): Promise<number> {
  if (!refBy || refBy === buyerUid) return 0;
  const { referralRate, referralCap } = await import("./referral");
  let commission = 0;
  const out = await dbTransact<number>(`users/${refBy}/refEarned/${buyerUid}`, (cur) => {
    const earned = Number(cur) || 0;
    const c = round(Math.min(Number(total) * referralRate(), referralCap() - earned));
    if (!(c > 0)) return undefined;
    commission = c;
    return round(earned + c);
  });
  if (out === undefined || !(commission > 0)) return 0;
  await dbWalletAdjust(refBy, commission, "Referral commission", "From a friend's purchase");
  return commission;
}

/* ---------------- Checkout ---------------- */

export type CheckoutInput = {
  items: { id: string; qty: number }[];
  coupon?: string | undefined;
  phone?: string | undefined;
  note?: string | undefined;
};

export async function webCheckout(uid: string, email: string, input: CheckoutInput) {
  await loadBotRuntime().catch(() => undefined);
  const [products, flash, profile] = await Promise.all([
    dbGet<Record<string, any>>("products"),
    dbGet<{ pid?: string; price?: number; endTime?: number }>("site_settings/flash_sale").catch(() => null),
    dbGet<any>(`users/${uid}`),
  ]);
  const flashOn = !!flash?.pid && Number(flash.endTime) > Date.now() && Number(flash.price) > 0;

  // Prices always come from the database, never from the browser.
  const lines = input.items
    .map((i) => ({ id: String(i.id), qty: Math.max(1, Math.min(100, Math.floor(Number(i.qty) || 1))) }))
    .filter((i) => products?.[i.id]);
  if (!lines.length) throw new Error("Your cart is empty.");
  const cart = lines.map((l) => {
    const p = products![l.id];
    if (p.soldOut) throw new Error(`${p.title} is out of stock`);
    const price = flashOn && flash!.pid === l.id ? Number(flash!.price) : Number(p.price || 0);
    return { ...p, id: l.id, qty: l.qty, price };
  });
  const subTotal = round(cart.reduce((s, i) => s + i.price * i.qty, 0));

  let discount = 0;
  const code = String(input.coupon || "").trim().toUpperCase();
  if (code) {
    const c = await dbGet<any>(`coupons/${code}`);
    const used = Number(profile?.used_coupons?.[code]) || 0;
    if (c && subTotal >= Number(c.minOrder || 0) && used < Number(c.maxUsage || 1)) {
      discount = c.type === "percent" ? Math.round((subTotal * Number(c.value)) / 100) : Number(c.value);
    }
  }
  const total = round(Math.max(0, subTotal - discount));

  // Take the money first, atomically. Fails if the balance is too low.
  const paid = await dbTransact<number>(`users/${uid}/wallet`, (w) => {
    const cur = Number(w) || 0;
    if (cur < total) return undefined;
    return round(cur - total);
  });
  if (paid === undefined) throw new Error("Not enough wallet balance");

  const orderId = "ORD" + Date.now();
  const delivered: { title: string; content: string }[] = [];
  const refunds: { title: string; missing: number; amount: number }[] = [];
  let allDelivered = true;

  for (const item of cart) {
    try {
      if (item.delivery === "supplier") {
        const { supplierBuy } = await import("./supplier.server");
        const got = await supplierBuy(String(item.supplierId ?? ""), item.qty, orderId, String(item.provider || "custom")).catch(() => [] as string[]);
        got.forEach((content) => delivered.push({ title: item.title, content }));
        for (const content of got) void dbPush(`usedStock/${item.id}`, { content, orderId, email, date: now() });
        if (got.length < item.qty) {
          if (!got.length) allDelivered = false;
          else refunds.push({ title: item.title, missing: item.qty - got.length, amount: round((item.qty - got.length) * item.price) });
        }
        continue;
      }
      if (item.delivery === "repeat" && item.link) {
        for (let n = 0; n < item.qty; n++) delivered.push({ title: item.title, content: item.link });
        continue;
      }
      if (item.delivery === "auto") {
        let taken: string[] = [];
        await dbTransact<string[]>(`products/${item.id}/stock`, (cur) => {
          const list = Array.isArray(cur) ? cur.filter(Boolean) : [];
          if (list.length < item.qty) return undefined;
          taken = list.slice(0, item.qty);
          return list.slice(item.qty);
        });
        if (taken.length === item.qty) {
          taken.forEach((content) => delivered.push({ title: item.title, content }));
          await Promise.all(taken.map((content) => dbPush(`usedStock/${item.id}`, { content, orderId, email, date: now() })));
          continue;
        }
      }
    } catch {
      /* treated as not delivered */
    }
    allDelivered = false;
  }

  for (const r of refunds) {
    await dbWalletAdjust(uid, r.amount, "Refund", `Partial delivery: ${r.title} (${r.missing} undelivered)`);
  }

  const status = delivered.length && allDelivered ? "Completed" : "Pending";
  const note = String(input.note || "").slice(0, 500);
  await dbPut(`orders/${orderId}`, {
    orderId,
    uid,
    email,
    items: cart.map(({ stock, ...rest }) => rest),
    subTotal,
    couponDiscount: discount,
    couponCode: discount > 0 ? code : null,
    total,
    phone: String(input.phone || "").slice(0, 30),
    note: refunds.length
      ? `${note ? note + " · " : ""}Partial delivery: ${refunds.map((r) => `${r.title} ${r.missing} refunded $${r.amount}`).join(", ")}`
      : note,
    delivered,
    status,
    date: now(),
  });
  await history(uid, "Purchase", total, `Order ${orderId.slice(-4)}`);
  if (input.phone && input.phone !== profile?.phone) await dbPatch(`users/${uid}`, { phone: String(input.phone).slice(0, 30) });
  if (discount > 0) await dbTransact<number>(`users/${uid}/used_coupons/${code}`, (v) => (Number(v) || 0) + 1);
  await Promise.all(cart.map((i) => dbTransact<number>(`products/${i.id}/salesCount`, (c) => (Number(c) || 0) + 1).catch(() => undefined)));

  // Referral commission for whoever invited this buyer (capped per friend).
  try {
    const refBy = String(profile?.refBy || "");
    await addReferralCommission(refBy, uid, total);
  } catch {
    /* never block an order on commission */
  }

  return {
    ok: true as const,
    orderId,
    status,
    total,
    discount,
    delivered,
    refunded: round(refunds.reduce((s, r) => s + r.amount, 0)),
    items: cart.map((i) => ({ title: i.title, qty: i.qty, price: i.price })),
  };
}

/* ---------------- Cancel ---------------- */

export async function cancelOrder(uid: string, orderId: string) {
  let refund = 0;
  const out = await dbTransact<any>(`orders/${orderId}`, (o) => {
    if (!o || o.uid !== uid || o.status !== "Pending") return undefined;
    refund = Number(o.total) || 0;
    return { ...o, status: "Cancelled" };
  });
  if (!out) throw new Error("This order can no longer be cancelled.");
  if (refund > 0) {
    await dbWalletAdjust(uid, refund, "Refund", `Cancelled ${orderId.slice(-4)}`);
  }
  return { ok: true as const, refund };
}

/* ---------------- Crypto deposit ---------------- */

export async function creditCryptoDeposit(
  uid: string,
  email: string,
  input: { hash: string; chain: "bep20" | "polygon"; name?: string | undefined },
) {
  const c = (await dbGet<any>("site_settings/config")) || {};
  const { defaultDepositAddress, verifyDepositOnChain } = await import("./deposit.server");
  const address = String(c.depositAddress || defaultDepositAddress() || "");
  if (!address) throw new Error("No deposit wallet is set up yet.");
  const res = await verifyDepositOnChain(input.hash, input.chain, address);
  if (!res.ok) return { ok: false as const, message: res.message };

  const base = {
    uid,
    name: input.name || email,
    email,
    amount: res.amount,
    symbol: res.symbol,
    chain: res.chain,
    txHash: input.hash,
    date: now(),
  };
  // Claim the transaction once — a second claim gets nothing.
  const claimed = await dbTransact<any>(`deposits/${input.hash}`, (cur) =>
    cur ? undefined : { ...base, status: res.status === "credited" ? "Credited" : "Pending" },
  );
  if (!claimed) return { ok: false as const, message: "This transaction has already been used." };

  if (res.status === "credited") {
    await dbWalletAdjust(uid, res.amount, "Deposit", `${res.symbol} on ${res.chain}`);
    return { ok: true as const, credited: true, amount: res.amount, message: "" };
  }
  await dbPush("requests", { ...base, type: "Deposit", utr: input.hash, status: "Pending" });
  return { ok: true as const, credited: false, amount: res.amount, message: res.message };
}

/* ---------------- Signup referral ---------------- */

export async function applySignupReferral(uid: string, name: string, code: string) {
  const clean = code.trim().toUpperCase();
  if (!clean) return { ok: false as const };
  const me = (await dbGet<any>(`users/${uid}`)) || {};
  if (me.refBonusDone) return { ok: false as const };
  const { uidByRefCode } = await import("./cloud-db.server");
  const key = await uidByRefCode(clean);
  if (!key || key === uid) return { ok: false as const };
  const fresh = await dbTransact<any>(`users/${uid}/refBonusDone`, (v) => (v ? undefined : true));
  if (!fresh) return { ok: false as const };
  await dbPatch(`users/${uid}`, { refBy: key, usedRef: clean });
  await dbWalletAdjust(key, 20, "Referral", `User ${name || "a friend"} joined`);
  await dbWalletAdjust(uid, 20, "Referral", "Signup bonus");
  return { ok: true as const };
}
