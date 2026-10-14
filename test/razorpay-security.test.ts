/**
 * Razorpay payment-security test suite.
 *
 * Covers: fake/test-mode payments, uncaptured/failed states, currency and
 * amount manipulation, server-side amount derivation, underpayment
 * reconciliation, idempotency / duplicate-webhook / replay, concurrent
 * crediting, and webhook signature verification + tampering.
 *
 * The payment gateway (fetch) and the database/wallet layer are mocked so the
 * tests exercise the real decision logic without external services.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ----------------------------- in-memory DB ----------------------------- */

/** A tiny store that mimics the atomic primitives the real code relies on. */
function makeStore() {
  const data = new Map<string, any>();
  return {
    data,
    reset() {
      data.clear();
    },
    async dbGet(path: string) {
      return data.has(path) ? data.get(path) : null;
    },
    async dbPut(path: string, value: unknown) {
      data.set(path, value);
    },
    async dbPatch(path: string, value: Record<string, unknown>) {
      data.set(path, { ...(data.get(path) || {}), ...value });
    },
    async dbPush(path: string, value: unknown) {
      const list = data.get(path) || [];
      list.push(value);
      data.set(path, list);
    },
    /** Atomic create-if-absent — the idempotency claim. */
    async dbCreateIfAbsent(path: string, value: unknown) {
      if (data.has(path)) return false;
      data.set(path, value);
      return true;
    },
    money: (n: number) => `$${Number(n || 0).toFixed(2)}`,
    notifyOwners: vi.fn(async () => undefined),
    tg: vi.fn(async () => undefined),
  };
}

let store = makeStore();

/** Config the server reads via dbGet("site_settings/config"). */
const CONFIG = {
  razorpayKeyId: "rzp_live_test",
  razorpayKeySecret: "secret_xyz",
  razorpayWebhookSecret: "whsec_123",
  inrPerDollar: 100,
  siteName: "Test Shop",
};

/* ------------------------------- mocks ---------------------------------- */

vi.mock("@/lib/telegram.server", () => ({
  dbGet: (p: string) => store.dbGet(p),
  dbPut: (p: string, v: unknown) => store.dbPut(p, v),
  dbPatch: (p: string, v: Record<string, unknown>) => store.dbPatch(p, v),
  dbPush: (p: string, v: unknown) => store.dbPush(p, v),
  dbCreateIfAbsent: (p: string, v: unknown) => store.dbCreateIfAbsent(p, v),
  notifyOwners: (...a: any[]) => store.notifyOwners(...a),
  tg: (...a: any[]) => store.tg(...a),
  money: (n: number) => store.money(n),
}));

// The relative import inside razorpay.server.ts resolves to the same module.
vi.mock("./telegram.server", () => ({
  dbGet: (p: string) => store.dbGet(p),
  dbPut: (p: string, v: unknown) => store.dbPut(p, v),
  dbPatch: (p: string, v: Record<string, unknown>) => store.dbPatch(p, v),
  dbPush: (p: string, v: unknown) => store.dbPush(p, v),
  dbCreateIfAbsent: (p: string, v: unknown) => store.dbCreateIfAbsent(p, v),
  notifyOwners: (...a: any[]) => store.notifyOwners(...a),
  tg: (...a: any[]) => store.tg(...a),
  money: (n: number) => store.money(n),
}));

/** Atomic wallet add, mirroring walletAdd's CAS refuse-negative behaviour. */
const walletAdd = vi.fn(async (uid: string, delta: number) => {
  const key = `users/${uid}/wallet`;
  const cur = Number(store.data.get(key) || 0);
  const next = Math.round((cur + delta) * 100) / 100;
  if (next < 0) return undefined;
  store.data.set(key, next);
  return next;
});
vi.mock("@/lib/wallet.server", () => ({ walletAdd: (u: string, d: number) => walletAdd(u, d) }));
vi.mock("./wallet.server", () => ({ walletAdd: (u: string, d: number) => walletAdd(u, d) }));

vi.mock("@/lib/push.server", () => ({ pushUser: vi.fn(async () => undefined) }));
vi.mock("./push.server", () => ({ pushUser: vi.fn(async () => undefined) }));
vi.mock("@/lib/bot/shop", () => ({ buy: vi.fn(async () => undefined) }));

/**
 * Belt-and-braces: mock the leaf DB module too. Even if a dynamic
 * import("./telegram.server") resolves to the real module, its DB primitives
 * are backed by the same in-memory store — so no test can ever reach Supabase.
 */
function cloudMock() {
  const get = (p: string) => store.dbGet(p);
  return {
    cloudGet: (p: string) => get(p),
    cloudPut: (p: string, v: unknown) => store.dbPut(p, v),
    cloudPatch: (p: string, v: Record<string, unknown>) => store.dbPatch(p, v),
    cloudPush: async (p: string, v: unknown) => {
      await store.dbPush(p, v);
      return "id_" + Math.random().toString(36).slice(2);
    },
    cloudCreateIfAbsent: (p: string, v: unknown) => store.dbCreateIfAbsent(p, v),
    cloudTransact: async (p: string, update: (cur: any) => any) => {
      const cur = await store.dbGet(p);
      const next = update(cur);
      if (next === undefined) return undefined;
      await store.dbPut(p, next);
      return next;
    },
  };
}
vi.mock("@/lib/cloud-db.server", () => cloudMock());
vi.mock("./cloud-db.server", () => cloudMock());

/* ------------------------- fetch (Razorpay API) ------------------------- */

/** The payment object Razorpay would return for GET /v1/payments/{id}. */
let paymentResponse: any = null;
let fetchStatus = 200;

beforeEach(() => {
  store = makeStore();
  store.data.set("site_settings/config", CONFIG);
  walletAdd.mockClear();
  paymentResponse = null;
  fetchStatus = 200;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      // Only the payment-verification endpoint is used in these tests.
      if (String(url).includes("/v1/payments/")) {
        return {
          ok: fetchStatus >= 200 && fetchStatus < 300,
          status: fetchStatus,
          json: async () => paymentResponse ?? {},
        } as any;
      }
      return { ok: false, status: 404, json: async () => ({}) } as any;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A genuine, live, captured INR payment (₹100000 = $1000 at rate 100). */
function livePayment(overrides: Record<string, any> = {}) {
  return {
    id: "pay_REAL123",
    status: "captured",
    captured: true,
    live: true,
    currency: "INR",
    amount: 10000000,
    amount_captured: 10000000,
    order_id: "order_1",
    payment_link_id: "plink_1",
    notes: { uid: "tg_1", usd: "1000" },
    ...overrides,
  };
}

/* ============================ verification ============================== */

describe("verifyRazorpayPayment", () => {
  it("accepts a live, captured, INR payment and reports captured rupees", async () => {
    const { verifyRazorpayPayment } = await import("@/lib/razorpay.server");
    paymentResponse = livePayment();
    const v = await verifyRazorpayPayment("pay_REAL123");
    expect(v.ok).toBe(true);
    expect(v.inrCaptured).toBe(100000);
    expect(v.currency).toBe("INR");
  });

  it("accepts a genuine captured payment even when the entity live flag is false (live key)", async () => {
    // Razorpay stamps live:false on real payments for provisional accounts.
    // Since the server uses a live key, this is still real money and must credit.
    const { verifyRazorpayPayment } = await import("@/lib/razorpay.server");
    paymentResponse = livePayment({ live: false });
    const v = await verifyRazorpayPayment("pay_REAL123");
    expect(v.ok).toBe(true);
    expect(v.inrCaptured).toBe(100000);
  });

  it("rejects everything when the server is configured with a test key", async () => {
    // A test key is the real test/live boundary — it can only see test money.
    store.data.set("site_settings/config", { ...CONFIG, razorpayKeyId: "rzp_test_abc" });
    const { verifyRazorpayPayment } = await import("@/lib/razorpay.server");
    paymentResponse = livePayment();
    const v = await verifyRazorpayPayment("pay_REAL123");
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not using live/i);
  });

  it("rejects uncaptured / authorized payments", async () => {
    const { verifyRazorpayPayment } = await import("@/lib/razorpay.server");
    paymentResponse = livePayment({ status: "authorized", captured: false, amount_captured: 0 });
    const v = await verifyRazorpayPayment("pay_REAL123");
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not captured/i);
  });

  it("rejects failed payments", async () => {
    const { verifyRazorpayPayment } = await import("@/lib/razorpay.server");
    paymentResponse = livePayment({ status: "failed", captured: false, amount_captured: 0 });
    const v = await verifyRazorpayPayment("pay_REAL123");
    expect(v.ok).toBe(false);
  });

  it("rejects non-INR currency (currency manipulation)", async () => {
    const { verifyRazorpayPayment } = await import("@/lib/razorpay.server");
    paymentResponse = livePayment({ currency: "USD" });
    const v = await verifyRazorpayPayment("pay_REAL123");
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/currency/i);
  });

  it("rejects a zero captured amount", async () => {
    const { verifyRazorpayPayment } = await import("@/lib/razorpay.server");
    paymentResponse = livePayment({ amount: 0, amount_captured: 0 });
    const v = await verifyRazorpayPayment("pay_REAL123");
    expect(v.ok).toBe(false);
  });

  it("rejects when the Razorpay API lookup fails (fail-closed)", async () => {
    const { verifyRazorpayPayment } = await import("@/lib/razorpay.server");
    fetchStatus = 404;
    paymentResponse = { error: { description: "not found" } };
    const v = await verifyRazorpayPayment("pay_MISSING");
    expect(v.ok).toBe(false);
  });

  it("rejects an empty payment id", async () => {
    const { verifyRazorpayPayment } = await import("@/lib/razorpay.server");
    const v = await verifyRazorpayPayment("");
    expect(v.ok).toBe(false);
  });
});

/* ============================= crediting ================================ */

describe("creditDeposit — amount integrity & idempotency", () => {
  it("credits USD derived server-side from captured INR, ignoring notes.usd", async () => {
    const { creditDeposit } = await import("@/lib/razorpay.server");
    // Link expected ₹100000 ($1000). Attacker's notes.usd is irrelevant now.
    store.data.set("razorpayLinks/plink_1", { uid: "tg_1", usd: 1000, inr: 100000 });
    const out = await creditDeposit({ uid: "tg_1", inr: 100000, paymentId: "pay_1", linkId: "plink_1" });
    expect(out.credited).toBe(true);
    // $1000 = ₹100000 / 100, computed by the server, not from any label.
    expect(store.data.get("users/tg_1/wallet")).toBe(1000);
  });

  it("blocks the ₹60-for-$1000 underpayment against the link's expected amount", async () => {
    const { creditDeposit } = await import("@/lib/razorpay.server");
    store.data.set("razorpayLinks/plink_1", { uid: "tg_1", usd: 1000, inr: 100000 });
    // Only ₹60 actually captured against a ₹100000 link.
    const out = await creditDeposit({ uid: "tg_1", inr: 60, paymentId: "pay_1", linkId: "plink_1" });
    expect(out.credited).toBe(false);
    expect(out.reason).toMatch(/below expected/i);
    expect(store.data.get("users/tg_1/wallet")).toBeUndefined();
    expect(store.notifyOwners).toHaveBeenCalled();
  });

  it("credits only once for a duplicate/replayed webhook (same link)", async () => {
    const { creditDeposit } = await import("@/lib/razorpay.server");
    store.data.set("razorpayLinks/plink_1", { uid: "tg_1", usd: 10, inr: 1000 });
    const a = await creditDeposit({ uid: "tg_1", inr: 1000, paymentId: "pay_1", linkId: "plink_1" });
    const b = await creditDeposit({ uid: "tg_1", inr: 1000, paymentId: "pay_1", linkId: "plink_1" });
    expect(a.credited).toBe(true);
    expect(b.credited).toBe(false);
    expect(store.data.get("users/tg_1/wallet")).toBe(10);
    expect(walletAdd).toHaveBeenCalledTimes(1);
  });

  it("credits only once when the same payment arrives with different/empty link ids (webhook vs settle)", async () => {
    // UPI payments can lack payment_link_id, so the webhook and the "I have
    // paid" settle path pass different linkId values for the same payment.
    // The claim is keyed on the payment id, so it must still credit once.
    const { creditDeposit } = await import("@/lib/razorpay.server");
    const a = await creditDeposit({ uid: "tg_9", inr: 500, paymentId: "pay_DUP", linkId: "" });
    const b = await creditDeposit({ uid: "tg_9", inr: 500, paymentId: "pay_DUP", linkId: "plink_DUP" });
    expect(a.credited).toBe(true);
    expect(b.credited).toBe(false);
    expect(store.data.get("users/tg_9/wallet")).toBe(5);
  });

  it("credits only once under concurrent delivery (webhook races manual check)", async () => {
    const { creditDeposit } = await import("@/lib/razorpay.server");
    // Warm the lazy dynamic imports once (sequentially) so the concurrent trio
    // below all hit the already-resolved mocked modules.
    store.data.set("razorpayLinks/plink_warm", { uid: "tg_warm", usd: 1, inr: 100 });
    await creditDeposit({ uid: "tg_warm", inr: 100, paymentId: "pay_warm", linkId: "plink_warm" });

    store.data.set("razorpayLinks/plink_2", { uid: "tg_2", usd: 5, inr: 500 });
    const results = await Promise.all([
      creditDeposit({ uid: "tg_2", inr: 500, paymentId: "pay_2", linkId: "plink_2" }),
      creditDeposit({ uid: "tg_2", inr: 500, paymentId: "pay_2", linkId: "plink_2" }),
      creditDeposit({ uid: "tg_2", inr: 500, paymentId: "pay_2", linkId: "plink_2" }),
    ]);
    expect(results.filter((r) => r.credited)).toHaveLength(1);
    expect(store.data.get("users/tg_2/wallet")).toBe(5);
  });

  it("refuses to credit a payment with no captured amount", async () => {
    const { creditDeposit } = await import("@/lib/razorpay.server");
    const out = await creditDeposit({ uid: "tg_1", inr: 0, paymentId: "pay_1", linkId: "plink_1" });
    expect(out.credited).toBe(false);
  });

  it("rejects crediting a link that belongs to a different user", async () => {
    const { creditDeposit } = await import("@/lib/razorpay.server");
    store.data.set("razorpayLinks/plink_3", { uid: "tg_owner", usd: 10, inr: 1000 });
    const out = await creditDeposit({ uid: "tg_attacker", inr: 1000, paymentId: "pay_3", linkId: "plink_3" });
    expect(out.credited).toBe(false);
    expect(out.reason).toMatch(/different user/i);
  });

  it("allows the small gateway-rounding tolerance", async () => {
    const { creditDeposit } = await import("@/lib/razorpay.server");
    store.data.set("razorpayLinks/plink_4", { uid: "tg_4", usd: 10, inr: 1000 });
    // ₹999 vs expected ₹1000 — within 1% tolerance.
    const out = await creditDeposit({ uid: "tg_4", inr: 999, paymentId: "pay_4", linkId: "plink_4" });
    expect(out.credited).toBe(true);
  });
});

/* ======================= signature verification ========================= */

describe("verifyWebhook — signature authenticity & tampering", () => {
  async function sign(secret: string, body: string) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  it("accepts a correctly signed body", async () => {
    const { verifyWebhook } = await import("@/lib/razorpay.server");
    const body = JSON.stringify({ event: "payment.captured" });
    const good = await sign(CONFIG.razorpayWebhookSecret, body);
    expect(await verifyWebhook(body, good)).toBe(true);
  });

  it("rejects a tampered body (signature no longer matches)", async () => {
    const { verifyWebhook } = await import("@/lib/razorpay.server");
    const body = JSON.stringify({ event: "payment.captured" });
    const good = await sign(CONFIG.razorpayWebhookSecret, body);
    const tampered = JSON.stringify({ event: "payment.captured", hacked: true });
    expect(await verifyWebhook(tampered, good)).toBe(false);
  });

  it("rejects a signature made with the wrong secret (forgery)", async () => {
    const { verifyWebhook } = await import("@/lib/razorpay.server");
    const body = JSON.stringify({ event: "payment.captured" });
    const forged = await sign("not_the_secret", body);
    expect(await verifyWebhook(body, forged)).toBe(false);
  });

  it("rejects a missing signature", async () => {
    const { verifyWebhook } = await import("@/lib/razorpay.server");
    expect(await verifyWebhook("{}", "")).toBe(false);
  });
});

/* ===================== additional attack scenarios ====================== */

describe("verifyRazorpayPayment — more manipulation attempts", () => {
  it("rejects a refunded payment", async () => {
    const { verifyRazorpayPayment } = await import("@/lib/razorpay.server");
    paymentResponse = livePayment({ status: "refunded" });
    const v = await verifyRazorpayPayment("pay_REAL123");
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not captured/i);
  });

  it("rejects a lowercase/padded currency that is not exactly INR", async () => {
    const { verifyRazorpayPayment } = await import("@/lib/razorpay.server");
    paymentResponse = livePayment({ currency: " inr " });
    const v = await verifyRazorpayPayment("pay_REAL123");
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/currency/i);
  });

  it("credits the actually-captured amount on a partial capture, not the authorized amount", async () => {
    // Authorized ₹1000 but only ₹100 captured — only the captured counts.
    const { verifyRazorpayPayment } = await import("@/lib/razorpay.server");
    paymentResponse = livePayment({ amount: 100000, amount_captured: 10000 });
    const v = await verifyRazorpayPayment("pay_REAL123");
    expect(v.ok).toBe(true);
    expect(v.inrCaptured).toBe(100); // ₹100, not ₹1000
  });

  it("ignores notes.usd entirely — the API amount is the only truth", async () => {
    // Attacker stuffs a huge notes.usd; verifier reports the real captured INR.
    const { verifyRazorpayPayment } = await import("@/lib/razorpay.server");
    paymentResponse = livePayment({ amount: 500, amount_captured: 500, notes: { uid: "tg_x", usd: "999999" } });
    const v = await verifyRazorpayPayment("pay_REAL123");
    expect(v.ok).toBe(true);
    expect(v.inrCaptured).toBe(5); // ₹5, regardless of notes.usd=999999
  });

  it("rejects a negative captured amount", async () => {
    const { verifyRazorpayPayment } = await import("@/lib/razorpay.server");
    paymentResponse = livePayment({ amount: -100000, amount_captured: -100000 });
    const v = await verifyRazorpayPayment("pay_REAL123");
    expect(v.ok).toBe(false);
  });

  it("rejects a non-numeric captured amount", async () => {
    const { verifyRazorpayPayment } = await import("@/lib/razorpay.server");
    paymentResponse = livePayment({ amount: "lots", amount_captured: "lots" });
    const v = await verifyRazorpayPayment("pay_REAL123");
    expect(v.ok).toBe(false);
  });

  it("rejects when Razorpay returns a 5xx (fail closed, no credit)", async () => {
    const { verifyRazorpayPayment } = await import("@/lib/razorpay.server");
    fetchStatus = 500;
    paymentResponse = {};
    const v = await verifyRazorpayPayment("pay_REAL123");
    expect(v.ok).toBe(false);
  });
});

describe("creditDeposit — more abuse attempts", () => {
  it("credits only the server-computed USD when notes.usd is inflated and there is no link", async () => {
    // No stored link to reconcile against; the amount still comes from inr.
    const { creditDeposit } = await import("@/lib/razorpay.server");
    const out = await creditDeposit({ uid: "tg_n", inr: 500, paymentId: "pay_n", linkId: "" });
    expect(out.credited).toBe(true);
    expect(store.data.get("users/tg_n/wallet")).toBe(5); // ₹500/100 = $5, not any notes value
  });

  it("does not let a second user claim another user's already-credited payment id", async () => {
    const { creditDeposit } = await import("@/lib/razorpay.server");
    const a = await creditDeposit({ uid: "tg_victim", inr: 1000, paymentId: "pay_SHARED", linkId: "" });
    const b = await creditDeposit({ uid: "tg_thief", inr: 1000, paymentId: "pay_SHARED", linkId: "" });
    expect(a.credited).toBe(true);
    expect(b.credited).toBe(false); // same payment id already claimed
    expect(store.data.get("users/tg_victim/wallet")).toBe(10);
    expect(store.data.get("users/tg_thief/wallet")).toBeUndefined();
  });

  it("rejects a negative inr passed to the credit path", async () => {
    const { creditDeposit } = await import("@/lib/razorpay.server");
    const out = await creditDeposit({ uid: "tg_neg", inr: -1000, paymentId: "pay_neg", linkId: "" });
    expect(out.credited).toBe(false);
    expect(store.data.get("users/tg_neg/wallet")).toBeUndefined();
  });

  it("rejects an empty uid", async () => {
    const { creditDeposit } = await import("@/lib/razorpay.server");
    const out = await creditDeposit({ uid: "", inr: 1000, paymentId: "pay_nouid", linkId: "" });
    expect(out.credited).toBe(false);
  });

  it("rejects an empty payment id (no stable claim key)", async () => {
    const { creditDeposit } = await import("@/lib/razorpay.server");
    const out = await creditDeposit({ uid: "tg_e", inr: 1000, paymentId: "", linkId: "plink_e" });
    expect(out.credited).toBe(false);
  });

  it("credits the full captured amount on overpayment (paid more than the link asked)", async () => {
    // Customer paid ₹1200 against a ₹1000 link — above expected is fine; they
    // get credit for what actually arrived.
    const { creditDeposit } = await import("@/lib/razorpay.server");
    store.data.set("razorpayLinks/plink_over", { uid: "tg_o", usd: 10, inr: 1000 });
    const out = await creditDeposit({ uid: "tg_o", inr: 1200, paymentId: "pay_over", linkId: "plink_over" });
    expect(out.credited).toBe(true);
    expect(store.data.get("users/tg_o/wallet")).toBe(12); // ₹1200/100
  });

  it("blocks a 1-rupee-for-$1000 payment (extreme underpayment)", async () => {
    const { creditDeposit } = await import("@/lib/razorpay.server");
    store.data.set("razorpayLinks/plink_x", { uid: "tg_x2", usd: 1000, inr: 100000 });
    const out = await creditDeposit({ uid: "tg_x2", inr: 1, paymentId: "pay_x2", linkId: "plink_x" });
    expect(out.credited).toBe(false);
    expect(out.reason).toMatch(/below expected/i);
    expect(store.data.get("users/tg_x2/wallet")).toBeUndefined();
  });
});
