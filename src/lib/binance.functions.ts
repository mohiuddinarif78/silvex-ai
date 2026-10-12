import { createServerFn } from "@tanstack/react-start";

/** Tells the website whether Binance deposits are on, and where to send them. */
export const binanceInfo = createServerFn({ method: "GET" }).handler(async () => {
  const { binanceConfig, binanceDepositAddress } = await import("./binance.server");
  const conf = await binanceConfig();
  const enabled = Boolean(conf.apiKey && conf.apiSecret);
  let address = conf.address;
  if (enabled && !address) {
    const live = await binanceDepositAddress(conf.coins[0] || "USDT", conf.network);
    address = live?.address || "";
  }
  return { enabled, address, network: conf.network, coins: conf.coins, payId: conf.payId };
});

/**
 * Checks one Binance Pay transfer (internal transfer to the store's
 * Binance ID) and tops the balance up once.
 */
export const verifyBinancePay = createServerFn({ method: "POST" })
  .inputValidator((input: { uid: string; ref: string }) => {
    const uid = String(input.uid || "").trim();
    const ref = String(input.ref || "").trim();
    if (!uid) throw new Error("Sign in first.");
    if (ref.replace(/[^0-9A-Za-z]/g, "").length < 6) throw new Error("Paste the full Binance Pay order id.");
    return { uid, ref };
  })
  .handler(async ({ data }) => {
    // Credit only the verified signed-in account, never a uid sent by the browser.
    const { requireCaller } = await import("./auth-guard.server");
    const rl = await import("./rate-limit.server");
    rl.limitByIp("binance", 30, rl.MINUTE);
    const who = await requireCaller();
    rl.limitBy("binance", who.uid, 10, rl.MINUTE);
    const { settleBinancePay } = await import("./binance.server");
    return settleBinancePay(who.uid, data.ref);
  });

/**
 * Checks one Binance transfer and tops the balance up once.
 * Safe to call many times: the same transfer is only ever counted once.
 */
export const verifyBinanceDeposit = createServerFn({ method: "POST" })
  .inputValidator((input: { uid: string; txId: string }) => {
    const uid = String(input.uid || "").trim();
    const txId = String(input.txId || "").trim();
    if (!uid) throw new Error("Sign in first.");
    if (txId.replace(/^0x/i, "").length < 16) throw new Error("Paste the full transaction id.");
    return { uid, txId };
  })
  .handler(async ({ data }) => {
    // Credit only the verified signed-in account, never a uid sent by the browser.
    const { requireCaller } = await import("./auth-guard.server");
    const rl = await import("./rate-limit.server");
    rl.limitByIp("binance", 30, rl.MINUTE);
    const who = await requireCaller();
    rl.limitBy("binance", who.uid, 10, rl.MINUTE);
    const { settleBinanceDeposit } = await import("./binance.server");
    return settleBinanceDeposit(who.uid, data.txId);
  });
