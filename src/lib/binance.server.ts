/**
 * Server-only Binance deposit verification.
 *
 * The store owner keeps a read-only Binance API key (IP-whitelisted to the
 * Railway static IP). A customer sends USDT/USDC to the store's Binance
 * deposit address and pastes the transaction id; we ask Binance whether that
 * exact transfer landed in the store account and, if so, top up the balance
 * once — 1 USDT = $1.
 */
import { dbCreateIfAbsent, dbGet, dbPut, money, notifyOwners, tg } from "./telegram.server";

const BASE = "https://api.binance.com";

export type BinanceConf = {
  apiKey: string;
  apiSecret: string;
  address: string;
  network: string;
  coins: string[];
  /** The store's Binance ID / Pay ID customers can send internal transfers to. */
  payId: string;
};

export async function binanceConfig(): Promise<BinanceConf> {
  const c = (await dbGet<any>("site_settings/config").catch(() => null)) || {};
  const coins = String(c.binanceCoins || "USDT,USDC")
    .split(/[,\s]+/)
    .map((s: string) => s.trim().toUpperCase())
    .filter(Boolean);
  return {
    apiKey: String(c.binanceApiKey || process.env["BINANCE_API_KEY"] || "").trim(),
    apiSecret: String(c.binanceApiSecret || process.env["BINANCE_API_SECRET"] || "").trim(),
    address: String(c.binanceAddress || process.env["BINANCE_DEPOSIT_ADDRESS"] || "").trim(),
    network: String(c.binanceNetwork || "BSC").trim().toUpperCase(),
    coins: coins.length ? coins : ["USDT"],
    payId: String(c.binancePayId || process.env["BINANCE_PAY_ID"] || "").trim(),
  };
}

async function sign(secret: string, payload: string): Promise<string> {
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

/** Signed read-only call to Binance. */
async function signedGet<T = any>(
  conf: BinanceConf,
  path: string,
  params: Record<string, string | number>,
): Promise<T> {
  const query = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    timestamp: String(Date.now()),
    recvWindow: "60000",
  }).toString();
  const signature = await sign(conf.apiSecret, query);
  const res = await fetch(`${BASE}${path}?${query}&signature=${signature}`, {
    headers: { "X-MBX-APIKEY": conf.apiKey },
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    const msg = String(json?.msg || `Binance error (${res.status})`);
    throw new Error(
      res.status === 401 || json?.code === -2015
        ? "Binance rejected the API key. Check the key, its permissions and the allowed IP address."
        : msg,
    );
  }
  return json as T;
}

export type BinanceDepositRow = {
  amount: string;
  coin: string;
  network: string;
  status: number;
  address: string;
  txId: string;
  insertTime: number;
};

/** The store's own Binance deposit address for one coin/network. */
export async function binanceDepositAddress(
  coin: string,
  network: string,
): Promise<{ address: string; tag: string } | null> {
  const conf = await binanceConfig();
  if (!conf.apiKey || !conf.apiSecret) return null;
  try {
    const out = await signedGet<{ address: string; tag?: string }>(
      conf,
      "/sapi/v1/capital/deposit/address",
      { coin: coin.toUpperCase(), network: network.toUpperCase() },
    );
    return { address: String(out.address || ""), tag: String(out.tag || "") };
  } catch {
    return null;
  }
}

function cleanTx(tx: string): string {
  return String(tx || "").trim().toLowerCase().replace(/^0x/, "");
}

export type BinanceCheck =
  | { ok: true; amount: number; coin: string; network: string; txId: string }
  | { ok: false; message: string };

/** Looks for one transaction id in the store's Binance deposit history. */
export async function findBinanceDeposit(txId: string): Promise<BinanceCheck> {
  const conf = await binanceConfig();
  if (!conf.apiKey || !conf.apiSecret) {
    return { ok: false, message: "Binance deposits are not set up yet." };
  }
  const wanted = cleanTx(txId);
  if (wanted.length < 16) return { ok: false, message: "That does not look like a transaction id." };

  const endTime = Date.now();
  const startTime = endTime - 89 * 24 * 60 * 60 * 1000;
  for (const coin of conf.coins) {
    let rows: BinanceDepositRow[] = [];
    try {
      rows = await signedGet<BinanceDepositRow[]>(conf, "/sapi/v1/capital/deposit/hisrec", {
        coin,
        startTime,
        endTime,
        limit: 1000,
      });
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "Could not reach Binance." };
    }
    const hit = (Array.isArray(rows) ? rows : []).find((r) => cleanTx(r.txId).includes(wanted));
    if (!hit) continue;
    if (Number(hit.status) !== 1) {
      return {
        ok: false,
        message: "Binance can see this transfer but it is still confirming. Try again in a minute.",
      };
    }
    const amount = Math.round(Number(hit.amount) * 100) / 100;
    if (!(amount > 0)) return { ok: false, message: "That transfer has no amount." };
    return { ok: true, amount, coin: String(hit.coin || coin), network: String(hit.network || ""), txId: cleanTx(hit.txId) };
  }
  return {
    ok: false,
    message: "Binance has not received this transfer yet. Wait for the network confirmations and try again.",
  };
}

export type BinanceSettle = {
  ok: boolean;
  credited: boolean;
  amount: number;
  balance: number;
  message: string;
};

/**
 * Verifies one Binance transfer and adds it to a wallet exactly once.
 * The transaction id is claimed atomically, so repeated taps, the website and
 * the bot can never credit the same money twice.
 */
export async function settleBinanceDeposit(uid: string, txId: string): Promise<BinanceSettle> {
  const balanceNow = Number((await dbGet<number>(`users/${uid}/wallet`)) || 0);
  if (!uid) return { ok: false, credited: false, amount: 0, balance: 0, message: "Sign in first." };

  const found = await findBinanceDeposit(txId);
  if (!found.ok) return { ok: false, credited: false, amount: 0, balance: balanceNow, message: found.message };

  const key = found.txId.replace(/[.#$/[\]]/g, "_");
  const date = new Date().toISOString();
  const claimed = await dbCreateIfAbsent(`binanceDeposits/${key}`, {
    uid,
    amount: found.amount,
    coin: found.coin,
    network: found.network,
    txId: found.txId,
    status: "Credited",
    date,
  });
  if (!claimed) {
    return {
      ok: true,
      credited: false,
      amount: found.amount,
      balance: Number((await dbGet<number>(`users/${uid}/wallet`)) || 0),
      message: "This transfer was already added to a wallet.",
    };
  }

  const { walletAdd } = await import("./wallet.server");
  const balance = Number((await walletAdd(uid, found.amount)) ?? balanceNow);
  await dbPut(`users/${uid}/history/bnb_${key}`, {
    type: "Deposit",
    status: "Paid",
    amount: found.amount,
    desc: `Binance ${found.coin}${found.network ? ` (${found.network})` : ""}`,
    txId: found.txId,
    date,
  });

  void import("./push.server").then(({ pushUser }) =>
    pushUser(uid, { title: "✅ Deposit done", body: `${money(found.amount)} added. New balance ${money(balance)}`, url: "/history" }),
  ).catch(() => undefined);
  const tgId = Number(uid.startsWith("tg_") ? uid.slice(3) : 0);
  if (tgId > 0) {
    await tg("sendMessage", {
      chat_id: tgId,
      parse_mode: "HTML",
      text: `✅ <b>Deposit done</b>\n${money(found.amount)} received on Binance.\nNew balance: <b>${money(balance)}</b>`,
    }).catch(() => undefined);
  }
  await notifyOwners(
    `🟡 Binance deposit credited\nUser: ${uid}\nAmount: ${money(found.amount)} ${found.coin}\nTX: ${found.txId}`,
  ).catch(() => undefined);

  return {
    ok: true,
    credited: true,
    amount: found.amount,
    balance,
    message: `${money(found.amount)} added to your balance.`,
  };
}

export type BinancePayRow = {
  orderType: string;
  transactionId: string;
  transactionTime: number;
  amount: string;
  currency: string;
  fundsDetail?: { currency: string; amount: string }[];
};

/**
 * Looks for one Binance Pay transfer (internal Binance ID / Pay ID payment)
 * in the store's Pay history. Incoming transfers have orderType "PAYOUT".
 */
export async function findBinancePay(ref: string): Promise<BinanceCheck> {
  const conf = await binanceConfig();
  if (!conf.apiKey || !conf.apiSecret) {
    return { ok: false, message: "Binance deposits are not set up yet." };
  }
  const wanted = String(ref || "").trim().replace(/[^0-9A-Za-z]/g, "");
  if (wanted.length < 6) return { ok: false, message: "That does not look like a Binance Pay order id." };

  let out: { code?: string; success?: boolean; data?: BinancePayRow[] };
  try {
    out = await signedGet(conf, "/sapi/v1/pay/transactions", { limit: 100 });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not reach Binance." };
  }
  const rows = Array.isArray(out?.data) ? out.data : [];
  const hit = rows.find(
    (r) => String(r.transactionId || "") === wanted && String(r.orderType || "").toUpperCase() === "PAYOUT",
  );
  if (!hit) {
    return {
      ok: false,
      message:
        "Binance has not received this Pay transfer in the store account yet. Double-check the order id and try again.",
    };
  }
  const currency = String(hit.currency || "USDT").toUpperCase();
  if (!conf.coins.includes(currency)) {
    return { ok: false, message: `This store only accepts ${conf.coins.join(" / ")} by Binance Pay.` };
  }
  const amount = Math.round(Number(hit.amount) * 100) / 100;
  if (!(amount > 0)) return { ok: false, message: "That transfer has no amount." };
  return { ok: true, amount, coin: currency, network: "Binance Pay", txId: wanted };
}

/**
 * Verifies one Binance Pay transfer (internal transfer to the store's
 * Binance ID) and adds it to a wallet exactly once.
 */
export async function settleBinancePay(uid: string, ref: string): Promise<BinanceSettle> {
  const balanceNow = Number((await dbGet<number>(`users/${uid}/wallet`)) || 0);
  if (!uid) return { ok: false, credited: false, amount: 0, balance: 0, message: "Sign in first." };

  const found = await findBinancePay(ref);
  if (!found.ok) return { ok: false, credited: false, amount: 0, balance: balanceNow, message: found.message };

  const key = found.txId.replace(/[.#$/[\]]/g, "_");
  const date = new Date().toISOString();
  const claimed = await dbCreateIfAbsent(`binancePayDeposits/${key}`, {
    uid,
    amount: found.amount,
    coin: found.coin,
    ref: found.txId,
    status: "Credited",
    date,
  });
  if (!claimed) {
    return {
      ok: true,
      credited: false,
      amount: found.amount,
      balance: Number((await dbGet<number>(`users/${uid}/wallet`)) || 0),
      message: "This transfer was already added to a wallet.",
    };
  }

  const { walletAdd } = await import("./wallet.server");
  const balance = Number((await walletAdd(uid, found.amount)) ?? balanceNow);
  await dbPut(`users/${uid}/history/pay_${key}`, {
    type: "Deposit",
    status: "Paid",
    amount: found.amount,
    desc: `Binance Pay ${found.coin}`,
    txId: found.txId,
    date,
  });

  void import("./push.server").then(({ pushUser }) =>
    pushUser(uid, { title: "✅ Deposit done", body: `${money(found.amount)} added. New balance ${money(balance)}`, url: "/history" }),
  ).catch(() => undefined);
  const tgId = Number(uid.startsWith("tg_") ? uid.slice(3) : 0);
  if (tgId > 0) {
    await tg("sendMessage", {
      chat_id: tgId,
      parse_mode: "HTML",
      text: `✅ <b>Deposit done</b>\n${money(found.amount)} received by Binance Pay.\nNew balance: <b>${money(balance)}</b>`,
    }).catch(() => undefined);
  }
  await notifyOwners(
    `🟡 Binance Pay deposit credited\nUser: ${uid}\nAmount: ${money(found.amount)} ${found.coin}\nOrder: ${found.txId}`,
  ).catch(() => undefined);

  return {
    ok: true,
    credited: true,
    amount: found.amount,
    balance,
    message: `${money(found.amount)} added to your balance.`,
  };
}
