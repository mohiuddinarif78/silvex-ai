/** Wallet, profile, referrals and support screens in the bot. */

import {
  botReferralLink,
  referralEarnings,
  referralCap,
  referralPercent,
  referralRate,
  websiteReferralLink,
} from "@/lib/referral";
import { dbCountByUsedRef, dbGet, dbOrdersByUser, dbPatch, dbPush, dbPut, dbUidByRefCode, money, notifyGroup, siteUrl, tg } from "@/lib/telegram.server";
import { be } from "@/lib/emoji.server";
import { resellerApiDocs } from "@/lib/reseller-docs";
import { tgSendDocument } from "@/lib/bot/delivery-files.server";
import { backHome, cfg, channelLink, ensureUser, invalidateUsers, say, setState } from "./core";


export async function sendWallet(chatId: number) {
  const uid = await ensureUser(chatId);
  const wallet = (await dbGet<number>(`users/${uid}/wallet`)) || 0;
  await say(chatId, `👛 <b>Wallet</b>\n\nBalance: <b>${money(wallet)}</b>`, {
    inline_keyboard: [
      [
        { text: `🟢 ${be("btn.deposit")} Deposit`, callback_data: "dep" },
        { text: "➖ Withdraw", callback_data: "wd" },
      ],
      [{ text: "📜 History", callback_data: "whist" }],
      [{ text: "📥 Download full statement", callback_data: "stmt" }],
      [{ text: "⬅️ Back to Shop", callback_data: "home" }],
    ],
  });
}

export async function walletHistory(chatId: number) {
  const uid = await ensureUser(chatId);
  const h = (await dbGet<Record<string, any>>(`users/${uid}/history`)) || {};
  const list = Object.values(h).slice(-10).reverse();
  const text = list.length
    ? list
        .map(
          (x: any) =>
            `• ${x.type} ${money(x.amount)}${x.status ? ` [${x.status}]` : ""} — ${x.desc || ""}`,
        )
        .join("\n")
    : "No transactions yet.";
  await say(chatId, `📜 <b>Wallet history</b>\n\n${text}`, {
    inline_keyboard: [[{ text: "📥 Download full statement", callback_data: "stmt" }], ...backHome.inline_keyboard],
  });
}

export async function startDeposit(chatId: number) {
  await ensureUser(chatId);
  const c = await cfg();
  await setState(chatId, { k: "dep_hash" });
  const rows: any[][] = [];
  if (String(c.razorpayKeyId || "").trim()) {
    rows.push([{ text: "💳 Pay by card / UPI", callback_data: "depcard" }]);
  }
  rows.push([{ text: "❌ Cancel", callback_data: "home" }]);

  // Binance transfers are checked straight in the store's Binance account.
  let binance = "";
  try {
    const { binanceConfig, binanceDepositAddress } = await import("@/lib/binance.server");
    const b = await binanceConfig();
    if (b.apiKey && b.apiSecret) {
      if (b.payId) {
        binance += `\n\n🟡 <b>Binance Pay</b> (no network fee):\nSend ${b.coins.join(" / ")} to Binance ID <code>${b.payId}</code>, then paste the Pay order id here — it is credited automatically.`;
      }
      const addr = b.address || (await binanceDepositAddress(b.coins[0] || "USDT", b.network))?.address || "";
      if (addr) {
        binance += `\n\n🟡 <b>Binance address</b> (${b.coins.join(" / ")}${b.network ? ` on ${b.network}` : ""}):\n<code>${addr}</code>\nSend the transaction id here and it is credited automatically.`;
      }
    }
  } catch {
    /* Binance is optional */
  }

  await say(
    chatId,
    `➕ <b>Deposit</b>\n\nSend USDT / USDC (BEP20, Polygon or Ethereum) to:\n<code>${c.depositAddress || "-"}</code>\n\nThen send the transaction hash (TXID) here. Payments confirmed within 10 minutes are credited automatically.${binance}`,
    { inline_keyboard: rows },
  );
}

export async function startCardDeposit(chatId: number) {
  await ensureUser(chatId);
  const c = await cfg();
  if (!String(c.razorpayKeyId || "").trim()) {
    return say(chatId, "Card / UPI payments are not switched on yet.", backHome);
  }
  const rate = Number(c.inrPerDollar) > 0 ? Number(c.inrPerDollar) : 100;
  await setState(chatId, { k: "dep_card" });
  await say(
    chatId,
    `💳 <b>Card / UPI deposit</b>\n\n₹${rate} = $1, no extra fees.\nSend how many dollars you want to add (for example <code>5</code>).`,
    { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "home" }]] },
  );
}

export async function createCardLink(chatId: number, text: string) {
  const usd = Number(String(text).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(usd) || usd <= 0) return say(chatId, "Send a number, like 5.");
  const uid = await ensureUser(chatId);
  const u = (await dbGet<any>(`users/${uid}`)) || {};
  const { createPaymentLink } = await import("@/lib/razorpay.server");
  const res = await createPaymentLink({
    usd,
    uid,
    name: u.name || "",
    email: u.email || "",
    phone: u.phone || "",
    source: "telegram",
    siteUrl: siteUrl(),
  });
  if (!res.ok) return say(chatId, `❌ ${res.error}`, backHome);
  await setState(chatId, null);
  return say(
    chatId,
    `💳 <b>Payment link ready</b>\n\nFor: wallet top-up of ${money(usd)}\n<b>Total to pay: ₹${res.inr.toFixed(2)}</b> (no extra fees)\n\nPay with any card, UPI or netbanking. Your balance is topped up on its own right after the payment.`,
    {
      inline_keyboard: [
        [{ text: "💳 Pay now", url: res.url }],
        [{ text: "✅ I have paid", callback_data: `pchk:${res.id}` }],
        [{ text: "⬅️ Back to Shop", callback_data: "home" }],
      ],
    },
  );
}

/**
 * Card / UPI payment for one product: the amount that is still missing is
 * charged, and the product is delivered by itself once the payment clears.
 */
export async function payProductByCard(chatId: number, productId: string, qty: number) {
  const uid = await ensureUser(chatId);
  const [p, u] = await Promise.all([
    dbGet<any>(`products/${productId}`),
    dbGet<any>(`users/${uid}`),
  ]);
  if (!p) return say(chatId, "Product not found.", backHome);
  const count = Math.max(1, Math.floor(Number(qty) || 1));
  const total = Math.round(Number(p.price || 0) * count * 100) / 100;
  const wallet = Number(u?.wallet || 0);
  const need = Math.round(Math.max(total - wallet, 0) * 100) / 100;
  if (need <= 0) {
    const { buy } = await import("./shop");
    return buy(chatId, productId, count);
  }
  const { createPaymentLink } = await import("@/lib/razorpay.server");
  const res = await createPaymentLink({
    usd: need,
    uid,
    name: u?.name || "",
    email: u?.email || "",
    phone: u?.phone || "",
    source: "telegram",
    siteUrl: siteUrl(),
    productId,
    qty: count,
    chatId,
  });
  if (!res.ok) return say(chatId, `❌ ${res.error}`, backHome);
  await setState(chatId, null);
  return say(
    chatId,
    `💳 <b>Payment link ready</b>\n\nFor: ${p.title} × ${count}\nOrder total: ${money(total)}\nTo pay now: ${money(need)}\n<b>Total to pay: ₹${res.inr.toFixed(2)}</b> (no extra fees)\n\nOnce the payment is confirmed, your order is delivered here automatically.`,
    {
      inline_keyboard: [
        [{ text: "💳 Pay now", url: res.url }],
        [{ text: "✅ I have paid", callback_data: `pchk:${res.id}` }],
        [{ text: "⬅️ Back to Shop", callback_data: "home" }],
      ],
    },
  );
}

/**
 * "I have paid" button. It only asks Razorpay whether the money really
 * arrived. One payment can be credited and delivered a single time only,
 * because the wallet credit is claimed atomically, so extra taps are safe.
 */
export async function checkCardPayment(chatId: number, linkId: string) {
  const id = String(linkId || "").trim();
  if (!id) return say(chatId, "This payment link is no longer available.", backHome);
  const { settlePaymentLink } = await import("@/lib/razorpay.server");
  const out = await settlePaymentLink(id);
  if (out.status === "paid") {
    return say(
      chatId,
      `✅ <b>Payment confirmed</b>\n${out.message}${
        typeof out.balance === "number" ? `\nBalance: <b>${money(out.balance)}</b>` : ""
      }`,
      backHome,
    );
  }
  if (out.status === "pending") {
    return say(
      chatId,
      "⏳ We have not received this payment yet. If you just paid, wait a few seconds and tap again.",
      { inline_keyboard: [[{ text: "🔄 I have paid", callback_data: `pchk:${id}` }], [{ text: "⬅️ Back to Shop", callback_data: "home" }]] },
    );
  }
  return say(chatId, `❌ ${out.message}`, backHome);
}

export async function startWithdraw(chatId: number) {
  const uid = await ensureUser(chatId);
  const wallet = (await dbGet<number>(`users/${uid}/wallet`)) || 0;
  await setState(chatId, { k: "wd_amount" });
  await say(
    chatId,
    `➖ <b>Withdraw</b>\n\nAvailable: <b>${money(wallet)}</b>\nSend the amount you want to withdraw in dollars.`,
    { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "home" }]] },
  );
}

export async function sendProfile(chatId: number) {
  const uid = await ensureUser(chatId);
  const u = await dbGet<any>(`users/${uid}`);
  await say(
    chatId,
    `👤 <b>Profile</b>\n\nName: ${u?.name || "-"}\nEmail: ${u?.email || "-"}\nPhone: ${u?.phone || "-"}\nWallet: ${money(u?.wallet || 0)}\nReferral code: <code>${u?.myRefCode || "-"}</code>`,
    {
      inline_keyboard: [
        [{ text: "📧 Set email", callback_data: "setmail" }],
        [{ text: "⬅️ Back to Shop", callback_data: "home" }],
      ],
    },
  );
}

export async function sendApiKey(chatId: number, regenerate: boolean) {
  const uid = await ensureUser(chatId);
  const user = (await dbGet<any>(`users/${uid}`)) || {};
  let key: string | undefined = user.apiKey;
  if (!key || regenerate) {
    if (key) await dbPut(`apiKeys/${key}`, null);
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    key = "sk_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    await dbPut(`apiKeys/${key}`, uid);
    await dbPatch(`users/${uid}`, { apiKey: key, apiEnabled: true });
    invalidateUsers();
  }
  const base = `${siteUrl()}/api/public/reseller`;
  await say(
    chatId,
    `🔑 <b>Your reseller API key</b>\n\n<code>${key}</code>\n\n` +
      `Base URL: <code>${base}</code>\n` +
      `Auth header: <code>x-api-key: ${key}</code>\n` +
      `Orders are paid from your wallet balance (same wallet as the bot and website).\n\n` +
      `<b>Endpoints</b>\n` +
      `<code>GET  /me</code> — your account\n` +
      `<code>GET  /balance</code> — wallet balance\n` +
      `<code>GET  /products</code> — price list + stock\n` +
      `<code>GET  /orders</code> — your orders\n` +
      `<code>GET  /orders/ORDER_ID</code> — one order\n` +
      `<code>POST /order</code> — buy: <code>{"productId":"ID","qty":1}</code>\n\n` +
      `<b>Example</b>\n` +
      `<code>curl -X POST ${base}/order \\\n -H "x-api-key: ${key}" \\\n -H "content-type: application/json" \\\n -d '{"productId":"ID","qty":1}'</code>\n\n` +
      `Instant items come back inside the order response; manual items stay <i>pending</i> until we deliver them (you get a message here).\n\n` +
      `⚠️ Keep this key private — anyone with it can spend your balance.`,
    {
      inline_keyboard: [
        [{ text: "♻️ Generate new key", callback_data: "apikey_new" }],
        [{ text: "⬇️ Download API docs", callback_data: "apikey_docs" }],
        [{ text: "📘 Full docs", url: `${siteUrl()}/api-key` }],
        [{ text: "⬅️ Back to Shop", callback_data: "home" }],
      ],
    },
  );
}

export async function sendApiDocsFile(chatId: number) {
  const uid = await ensureUser(chatId);
  const user = (await dbGet<any>(`users/${uid}`)) || {};
  const key = String(user.apiKey || "");
  if (!key) return sendApiKey(chatId, false);
  const base = `${siteUrl()}/api/public/reseller`;
  const bytes = new TextEncoder().encode(resellerApiDocs(base, key));
  await tgSendDocument(
    chatId,
    "silent-seller-reseller-api.txt",
    bytes,
    "text/plain;charset=utf-8",
    "🔑 <b>Your reseller API documentation</b>\nKeep this file private because it contains your API key.",
  );
}

export async function sendOrders(chatId: number) {
  const uid = await ensureUser(chatId);
  const all = (await dbOrdersByUser(uid, 8)) || {};
  const mine = Object.values(all)
    .sort((a: any, b: any) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 8);
  if (!mine.length) return say(chatId, "You have no orders yet.", backHome);
  const text = mine
    .map((o: any) => {
      const items = (o.items || []).map((i: any) => `${i.title} x${i.qty || 1}`).join(", ");
      const del = (o.delivered || []).map((d: any) => `\n<code>${d.content}</code>`).join("");
      return `🧾 <b>${o.orderId}</b>\n${items}\n${money(o.total)} • ${o.status}${del}`;
    })
    .join("\n\n");
  await say(chatId, text, {
    inline_keyboard: [[{ text: "📥 Download full statement", callback_data: "stmt" }], [{ text: "⬅️ Back to Shop", callback_data: "home" }]],
  });
}

export async function sendReviews(chatId: number) {
  const c = await cfg();
  const all = (await dbGet<Record<string, any>>("reviews")) || {};
  const list = Object.values(all).slice(-5).reverse();
  const text = list.length
    ? list.map((r: any) => `⭐ ${r.rating || 5}/5 — ${r.text || r.message || ""}`).join("\n\n")
    : "No reviews yet.";
  const rows: any[] = [[{ text: "✍️ Write a review", callback_data: "rev_new" }]];
  if (c.reviewChannel) rows.push([{ text: "📢 Review channel", url: channelLink(c.reviewChannel) }]);
  rows.push([{ text: "⬅️ Back to Shop", callback_data: "home" }]);
  await say(chatId, `⭐ <b>Reviews</b>\n\n${text}`, { inline_keyboard: rows });
}

export async function submitReview(chatId: number, text: string) {
  const uid = await ensureUser(chatId);
  const u = uid ? await dbGet<any>(`users/${uid}`) : null;
  const m = text.match(/^([1-5])\s+(.*)$/s);
  const rating = m ? Number(m[1]) : 5;
  const body = m ? m[2]! : text;
  const escapeHtml = (value: unknown) =>
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  await dbPush("reviews", {
    uid: uid || null,
    name: u?.name || u?.email || "Telegram user",
    rating,
    text: body,
    date: new Date().toISOString(),
  });
  await setState(chatId, null);
  await say(chatId, "🙏 Thanks for your review!", backHome);
  const c = await cfg();
  if (c.reviewChannel && !c.reviewChannel.startsWith("http")) {
    await tg("sendMessage", {
      chat_id: c.reviewChannel.startsWith("@") ? c.reviewChannel : `@${c.reviewChannel}`,
      text: `⭐ ${rating}/5 — ${escapeHtml(body)}\n\n— ${escapeHtml(u?.name || "Customer")}`,
      parse_mode: "HTML",
    }).catch(() => undefined);
  }
}

/* ---------------- referrals ---------------- */

/** Pays the buyer's referrer 2% of the purchase, capped per friend. */
export async function payReferralCommission(buyerUid: string, amount: number) {
  try {
    const refBy = await dbGet<string>(`users/${buyerUid}/refBy`);
    if (!refBy || refBy === buyerUid) return;
    const { addReferralCommission } = await import("@/lib/wallet.server");
    const commission = await addReferralCommission(refBy, buyerUid, Number(amount));
    if (commission <= 0) return;
    await dbPush(`users/${refBy}/history`, {
      type: "Referral commission",
      amount: commission,
      desc: `2% from a friend's purchase`,
      date: new Date().toISOString(),
    });
    const chat = await dbGet<number>(`users/${refBy}/telegramChatId`);
    if (chat) {
      await tg("sendMessage", {
        chat_id: chat,
        text: `🎁 You earned ${money(commission)} referral commission from a friend's purchase.`,
        parse_mode: "HTML",
      }).catch(() => undefined);
    }
  } catch {
    /* commission must never break an order */
  }
}

/** Links a new bot user to the referrer whose code came in the /start payload. */
export async function applyStartReferral(uid: string, rawCode: string) {
  const code = rawCode.trim().toUpperCase();
  if (!code) return;
  const me = (await dbGet<any>(`users/${uid}`)) || {};
  if (me.refBy || me.usedRef || me.myRefCode === code) return;
  const refBy = await dbUidByRefCode(code);
  if (!refBy || refBy === uid) return;
  await dbPatch(`users/${uid}`, { usedRef: code, refBy });
  invalidateUsers();
  void notifyGroup(
    `🎉 <b>New Referral Success!</b>\n\n` +
      `👤 User: <code>${uid}</code>\n` +
      `📌 Referred by: <code>${refBy}</code>\n` +
      `🤩 Code: <code>${code}</code>`,
  ).catch(() => undefined);
}

export async function sendRefer(chatId: number) {
  const uid = await ensureUser(chatId);
  const u = (await dbGet<any>(`users/${uid}`)) || {};
  const code = u.myRefCode || "-";
  const invited = code && code !== "-" ? await dbCountByUsedRef(code) : 0;
  const history = Object.values((await dbGet<Record<string, any>>(`users/${uid}/history`)) || {});
  const e = referralEarnings(history as any);
  await say(
    chatId,
    `🎁 <b>Refer &amp; Earn</b>\n\n` +
      `Earn <b>${referralPercent()}% commission</b> on every purchase your friend makes (up to ${money(referralCap())} per friend)!\n\n` +
      `🔗 <b>Your link:</b>\n${botReferralLink(code)}\n\n` +
      `🤩 <b>Code:</b> <code>${code}</code>\n\n` +
      `👥 <b>Total Referrals:</b> ${invited}\n\n` +
      `📈 <b>Earnings</b>\n` +
      `• Today: ${money(e.today)}\n` +
      `• This Week: ${money(e.week)}\n` +
      `• This Month: ${money(e.month)}\n` +
      `• Total: ${money(e.total)}\n\n` +
      `🌐 Website link: ${websiteReferralLink(code)}`,
    backHome,
  );
}

/** Turns "@name", "t.me/name" or a full link into a usable Telegram link. */
export function telegramSupportLink(value?: string) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  return `https://t.me/${v.replace(/^@/, "").replace(/^t\.me\//i, "")}`;
}

export async function sendSupport(chatId: number) {
  const c = await cfg();
  const rows: any[] = [[{ text: "💬 Chat with us", callback_data: "sup" }]];
  const tgLink = telegramSupportLink((c as any).supportTelegram);
  if (tgLink) rows.push([{ text: "✈️ Telegram support", url: tgLink }]);
  if (c.supportLink) rows.push([{ text: "💬 WhatsApp support", url: c.supportLink }]);
  rows.push([{ text: "⬅️ Back to Shop", callback_data: "home" }]);
  await say(chatId, "🆘 <b>Support</b>\n\nWe reply 24/7. You can also message us on the website.", {
    inline_keyboard: rows,
  });
}

/* ---------------- buying ---------------- */

/** How many copies of a product can be bought right now. */

/** Sends a CSV statement. uid = one user; uid omitted = whole store (admin). */
export async function sendStatement(chatId: number, uid?: string) {
  const { buildStatementCsv } = await import("@/lib/statement");
  const target = uid ?? null;
  let users: any[];
  let orders: any[];
  if (target) {
    const u = (await dbGet<any>(`users/${target}`)) || {};
    users = [{ uid: target, ...u }];
    orders = Object.values((await dbOrdersByUser(target, 1000)) || {});
  } else {
    const all = (await dbGet<Record<string, any>>("users")) || {};
    users = Object.entries(all).map(([id, u]) => ({ uid: id, ...(u || {}) }));
    orders = Object.values((await dbGet<Record<string, any>>("orders")) || {});
  }
  const csv = buildStatementCsv(users, orders, target ? `Statement for ${users[0].email || target}` : "Full store statement");
  const bytes = new TextEncoder().encode("\ufeff" + csv);
  await tgSendDocument(chatId, `statement-${target ? "account" : "store"}-${new Date().toISOString().slice(0, 10)}.csv`, bytes, "text/csv;charset=utf-8",
    `📥 <b>${target ? "Your full statement" : "Full store statement"}</b>\nAll orders and wallet changes.`);
}

export async function sendMyStatement(chatId: number) {
  const uid = await ensureUser(chatId);
  if (!uid) return;
  await sendStatement(chatId, uid);
}
