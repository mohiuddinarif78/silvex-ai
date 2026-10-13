import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const token = z.string().min(10).max(5000);

export const checkoutCart = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        idToken: token,
        items: z.array(z.object({ id: z.string().min(1).max(200), qty: z.number() })).min(1).max(50),
        coupon: z.string().max(60).optional(),
        phone: z.string().max(30).optional(),
        note: z.string().max(500).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { verifyIdToken, webCheckout } = await import("./wallet.server");
    try {
      const rl = await import("./rate-limit.server");
      rl.limitByIp("checkout", 30, rl.MINUTE);
      const who = await verifyIdToken(data.idToken);
      rl.limitBy("checkout", who.uid, 10, rl.MINUTE);
      return await webCheckout(who.uid, who.email, data);
    } catch (err) {
      return { ok: false as const, error: (err as Error).message || "Checkout failed" };
    }
  });

export const cancelMyOrder = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ idToken: token, orderId: z.string().min(3).max(80) }).parse(d))
  .handler(async ({ data }) => {
    const { verifyIdToken, cancelOrder } = await import("./wallet.server");
    try {
      const rl = await import("./rate-limit.server");
      rl.limitByIp("cancel", 30, rl.MINUTE);
      const who = await verifyIdToken(data.idToken);
      rl.limitBy("cancel", who.uid, 10, rl.MINUTE);
      return await cancelOrder(who.uid, data.orderId);
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  });

export const submitCryptoDeposit = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        idToken: token,
        hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
        chain: z.enum(["bep20", "polygon", "ethereum"]),
        name: z.string().max(100).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { verifyIdToken, creditCryptoDeposit } = await import("./wallet.server");
    try {
      const rl = await import("./rate-limit.server");
      rl.limitByIp("deposit", 30, rl.MINUTE);
      const who = await verifyIdToken(data.idToken);
      rl.limitBy("deposit", who.uid, 10, rl.MINUTE);
      return await creditCryptoDeposit(who.uid, who.email, data);
    } catch (err) {
      return { ok: false as const, message: (err as Error).message || "Could not check that transaction" };
    }
  });

export const claimSignupReferral = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ idToken: token, code: z.string().max(30), name: z.string().max(100) }).parse(d))
  .handler(async ({ data }) => {
    const { verifyIdToken, applySignupReferral } = await import("./wallet.server");
    try {
      const rl = await import("./rate-limit.server");
      rl.limitByIp("referral", 10, rl.HOUR);
      const who = await verifyIdToken(data.idToken);
      rl.limitBy("referral", who.uid, 5, rl.HOUR);
      return await applySignupReferral(who.uid, data.name, data.code);
    } catch {
      return { ok: false as const };
    }
  });

/** Web admin changed a balance in the browser: tell the bot admins. */
export const reportBalanceChange = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        idToken: token,
        uid: z.string().min(1).max(200),
        type: z.string().max(60),
        amount: z.number(),
        desc: z.string().max(500),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { verifyIdToken } = await import("./wallet.server");
    const { isPermanentOwner } = await import("./owners");
    const who = await verifyIdToken(data.idToken);
    if (!isPermanentOwner(who.email)) return { ok: false as const };
    const { notifyBalanceChange } = await import("./telegram.server");
    await notifyBalanceChange(data.uid, { type: data.type, amount: data.amount, desc: data.desc, by: who.email });
    return { ok: true as const };
  });

/** Web admin approves/rejects a wallet request: claimed once, balance changed atomically. */
export const decideRequestWeb = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ id: z.string().min(1).max(200), approve: z.boolean() }).parse(d))
  .handler(async ({ data }) => {
    const { requireStaff } = await import("./auth-guard.server");
    const who = await requireStaff();
    const { decideWalletRequest } = await import("./wallet.server");
    const res = await decideWalletRequest(data.id, data.approve);
    if (!res.ok) return res;
    if (data.approve && res.delta !== 0) {
      const { notifyBalanceChange } = await import("./telegram.server");
      void notifyBalanceChange(String(res.request.uid), {
        type: res.request.type,
        amount: res.delta,
        desc: `${res.request.type} request approved`,
        by: who.email,
      }).catch(() => undefined);
    }
    return { ok: true as const };
  });
