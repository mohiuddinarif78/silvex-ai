import { createServerFn } from "@tanstack/react-start";

/** Creates a one-off payment link for a wallet top-up. */
export const createDepositLink = createServerFn({ method: "POST" })
  .inputValidator(
    (input: {
      usd: number;
      uid: string;
      name?: string;
      email?: string;
      phone?: string;
      siteUrl?: string;
    }) => {
      const usd = Number(input.usd);
      const uid = String(input.uid || "").trim();
      if (!uid) throw new Error("Sign in first.");
      if (!Number.isFinite(usd) || usd <= 0) throw new Error("Enter a valid amount.");
      return {
        usd,
        uid,
        name: String(input.name || ""),
        email: String(input.email || ""),
        phone: String(input.phone || ""),
        siteUrl: String(input.siteUrl || ""),
      };
    },
  )
  .handler(async ({ data }) => {
    // The link credits whoever it names, so name the verified caller only.
    const { requireCaller } = await import("./auth-guard.server");
    const rl = await import("./rate-limit.server");
    rl.limitByIp("rzp-link", 20, rl.MINUTE);
    const who = await requireCaller();
    rl.limitBy("rzp-link", who.uid, 5, rl.MINUTE);
    const { createPaymentLink } = await import("./razorpay.server");
    return createPaymentLink({ ...data, uid: who.uid, source: "web" });
  });

/**
 * Asks the payment provider whether one link was really paid and, if so,
 * adds the balance. Safe to call many times: the money is only added once.
 */
export const checkDepositLink = createServerFn({ method: "POST" })
  .inputValidator((input: { linkId: string }) => {
    const linkId = String(input.linkId || "").trim();
    if (!linkId) throw new Error("Missing payment link.");
    return { linkId };
  })
  .handler(async ({ data }) => {
    const rl = await import("./rate-limit.server");
    rl.limitByIp("rzp-check", 30, rl.MINUTE);
    const { settlePaymentLink } = await import("./razorpay.server");
    return settlePaymentLink(data.linkId);
  });

/** Tells the website whether card/UPI deposits are switched on, and the rate. */
export const razorpayStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { razorpayConfig } = await import("./razorpay.server");
  const conf = await razorpayConfig();
  return {
    enabled: Boolean(conf.keyId && conf.keySecret),
    inrPerDollar: conf.inrPerDollar,
    feePercent: conf.feePercent,
  };
});
