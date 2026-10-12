/**
 * Live support inside the bot: the customer writes here, the owners get the
 * message in their own chat and can answer by replying to it. If no owner
 * answers within five seconds, the AI assistant replies instead — in the same
 * tone the owners use, and it can take payments, sell and deliver.
 */
import { dbGet, dbPush, dbPut, money, ownerIds, siteUrl, tg } from "@/lib/telegram.server";
import { allProducts, backHome, cfg, ensureUser, say, setState, siteName } from "./core";
import { hasAiKey, runSupportAgent, type AgentTool } from "./ai-support.server";

const OWNER_ONLINE_MS = 5 * 60_000;
const WAIT_FOR_OWNER_MS = 5_000;

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

export async function startSupportChat(chatId: number) {
  await ensureUser(chatId);
  await setState(chatId, { k: "support" });
  const name = await siteName();
  await say(
    chatId,
    `💬 <b>${esc(name)} support</b>\n\nWrite your question here. A real person sees every message, and our assistant answers straight away if they are busy.\n\nYou can ask for a payment link, a top-up check, or to buy and receive a product right in this chat.`,
    {
      inline_keyboard: [
        [{ text: "🛍 Products", callback_data: "products" }],
        [{ text: "⬅️ Back to Shop", callback_data: "home" }],
      ],
    },
  );
}

/* ---------------- owner side ---------------- */

/** Owner replied to a forwarded support message — send it back to the customer. */
export async function handleOwnerReply(
  ownerChatId: number,
  replyToMessageId: number,
  text: string,
): Promise<boolean> {
  const uid = await dbGet<string>(`supportRelay/${ownerChatId}_${replyToMessageId}`);
  if (!uid) return false;
  const chat =
    Number(await dbGet<number>(`users/${uid}/telegramChatId`)) ||
    Number(await dbGet<number>(`support/${uid}/chatId`));
  if (!chat) return false;

  await Promise.all([
    dbPut(`support/${uid}/lastOwnerAt`, Date.now()),
    dbPush(`support/${uid}/messages`, { from: "owner", text, date: new Date().toISOString() }),
  ]);
  await tg("sendMessage", {
    chat_id: chat,
    text: `💬 <b>Support</b>\n\n${esc(text)}`,
    parse_mode: "HTML",
  }).catch(() => undefined);
  await tg("sendMessage", { chat_id: ownerChatId, text: "✅ Sent to the customer." }).catch(
    () => undefined,
  );
  return true;
}

async function relayToOwners(uid: string, chatId: number, text: string) {
  const u = (await dbGet<any>(`users/${uid}`)) || {};
  const head =
    `💬 <b>Support message</b>\n` +
    `From: ${esc(u.name || "Telegram user")} (${esc(u.email || chatId)})\n` +
    `Wallet: ${money(Number(u.wallet || 0))}\n\n` +
    `${esc(text)}\n\n` +
    `<i>Reply to this message to answer them.</i>`;
  await Promise.all(
    ownerIds().map(async (id) => {
      try {
        const res = await tg("sendMessage", { chat_id: id, text: head, parse_mode: "HTML" });
        const mid = res?.result?.message_id;
        if (mid) void dbPut(`supportRelay/${id}_${mid}`, uid).catch(() => undefined);
      } catch {
        /* one owner unreachable must not stop support */
      }
    }),
  );
}

/* ---------------- learning from the owners ---------------- */

let styleCache: { at: number; v: string[] } | null = null;

/** Recent owner answers, used as the tone the assistant must copy. */
async function ownerStyleExamples(): Promise<string[]> {
  if (styleCache && Date.now() - styleCache.at < 5 * 60_000) return styleCache.v;
  const all = (await dbGet<Record<string, any>>("support")) || {};
  const pairs: { date: string; q: string; a: string }[] = [];
  for (const thread of Object.values(all)) {
    const msgs = Object.values((thread as any)?.messages || {}) as any[];
    msgs.sort((a, b) => String(a?.date).localeCompare(String(b?.date)));
    msgs.forEach((m, i) => {
      if (m?.from !== "owner" || !m?.text) return;
      const prev = [...msgs.slice(0, i)].reverse().find((x) => x?.from === "user");
      pairs.push({ date: String(m.date || ""), q: String(prev?.text || ""), a: String(m.text) });
    });
  }
  pairs.sort((a, b) => b.date.localeCompare(a.date));
  const v = pairs
    .slice(0, 20)
    .reverse()
    .map((p) => (p.q ? `Customer: ${p.q}\nOwner: ${p.a}` : `Owner: ${p.a}`));
  styleCache = { at: Date.now(), v };
  return v;
}

async function threadHistory(uid: string): Promise<any[]> {
  const msgs = Object.values((await dbGet<Record<string, any>>(`support/${uid}/messages`)) || {});
  msgs.sort((a: any, b: any) => String(a?.date).localeCompare(String(b?.date)));
  return msgs.slice(-16).map((m: any) => ({
    role: m?.from === "user" ? "user" : "assistant",
    content: [
      {
        type: m?.from === "user" ? "input_text" : "output_text",
        text: String(m?.text || ""),
      },
    ],
  }));
}

/* ---------------- tools the assistant can use ---------------- */

const obj = (props: Record<string, unknown>) => ({
  type: "object",
  properties: props,
  required: Object.keys(props),
  additionalProperties: false,
});

const TOOLS: AgentTool[] = [
  {
    name: "get_account",
    description: "The customer's wallet balance, email and last orders.",
    parameters: obj({}),
  },
  {
    name: "list_products",
    description: "Everything on sale right now with price and stock.",
    parameters: obj({}),
  },
  {
    name: "create_payment_link",
    description: "Create a card / UPI payment link to top up the customer's wallet.",
    parameters: obj({ amount_usd: { type: "number", description: "Amount in dollars" } }),
  },
  {
    name: "check_deposit",
    description: "Check a crypto transaction hash and credit the wallet when it is valid.",
    parameters: obj({ tx_hash: { type: "string", description: "Transaction hash starting with 0x" } }),
  },
  {
    name: "buy_product",
    description:
      "Buy a product for the customer, taking the money from their wallet and delivering it in this chat.",
    parameters: obj({
      product_id: { type: "string" },
      quantity: { type: "number" },
    }),
  },
];

async function execTool(chatId: number, uid: string, name: string, args: any): Promise<string> {
  if (name === "get_account") {
    const u = (await dbGet<any>(`users/${uid}`)) || {};
    const orders = Object.values((await dbGet<Record<string, any>>("orders")) || {})
      .filter((o: any) => o?.uid === uid)
      .sort((a: any, b: any) => String(b.date).localeCompare(String(a.date)))
      .slice(0, 5)
      .map((o: any) => `${o.orderId} • ${money(o.total)} • ${o.status}`);
    return JSON.stringify({
      wallet: Number(u.wallet || 0),
      email: u.email || null,
      recent_orders: orders,
    });
  }

  if (name === "list_products") {
    const all = await allProducts();
    const list = Object.entries(all)
      .filter(([, p]: [string, any]) => p && p.hidden !== true && String(p.title || "").trim())
      .slice(0, 60)
      .map(([id, p]: [string, any]) => ({
        id,
        title: p.title,
        price: Number(p.price || 0),
        delivery: p.delivery || "manual",
        stock:
          p.delivery === "auto"
            ? (Array.isArray(p.stock) ? p.stock.filter(Boolean).length : 0)
            : p.delivery === "supplier"
              ? Number(p.supplierStock || 0)
              : "unlimited",
      }));
    return JSON.stringify(list);
  }

  if (name === "create_payment_link") {
    const usd = Number(args?.amount_usd);
    if (!Number.isFinite(usd) || usd <= 0) return "Error: amount must be a positive number.";
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
    if (!res.ok) return `Error: ${res.error}`;
    return JSON.stringify({ pay_url: res.url, total_inr: res.inr, usd });
  }

  if (name === "check_deposit") {
    const hash = String(args?.tx_hash || "").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return "Error: that is not a valid transaction hash.";
    const c = await cfg();
    const { defaultDepositAddress, verifyDepositAnyChain } = await import("@/lib/deposit.server");
    const address = c.depositAddress || defaultDepositAddress();
    if (!address) return "Error: no deposit wallet is set up.";
    if (await dbGet<any>(`deposits/${hash}`)) return "This transaction was already used.";
    const res = await verifyDepositAnyChain(hash, address);
    if (!res.ok) return `Not credited: ${res.message}`;
    const u = (await dbGet<any>(`users/${uid}`)) || {};
    const base = {
      uid,
      name: u.name || "",
      email: u.email || "",
      amount: res.amount,
      symbol: res.symbol,
      chain: res.chain,
      txHash: hash,
      source: "telegram-support",
      date: new Date().toISOString(),
    };
    if (res.status === "credited") {
      const { claimAndCreditDeposit } = await import("@/lib/wallet.server");
      const balance = await claimAndCreditDeposit(uid, hash, base, res.amount, `${res.symbol} on ${res.chain}`);
      if (balance === null) return "This transaction was already used.";
      return JSON.stringify({ credited: res.amount, new_balance: balance });
    }
    await dbPut(`deposits/${hash}`, { ...base, status: "Pending" });
    await dbPush("requests", { ...base, type: "Deposit", utr: hash, status: "Pending" });
    return `Payment found but it is ${res.ageMinutes} minutes old, so an owner will approve it manually.`;
  }

  if (name === "buy_product") {
    const id = String(args?.product_id || "").trim();
    const qty = Math.max(1, Math.min(20, Math.floor(Number(args?.quantity) || 1)));
    const p = await dbGet<any>(`products/${id}`);
    if (!p) return "Error: no product with that id.";
    const wallet = Number((await dbGet<number>(`users/${uid}/wallet`)) || 0);
    const total = Math.round(Number(p.price || 0) * qty * 100) / 100;
    if (wallet < total)
      return `Not enough balance: wallet ${money(wallet)}, order ${money(total)}. Offer a top-up.`;
    const { buy } = await import("./shop");
    await buy(chatId, id, qty);
    return "Purchased and delivered in the chat. Do not repeat the delivery details.";
  }

  return "Error: unknown tool.";
}

/* ---------------- the assistant ---------------- */

/** Writes the assistant's answer (empty string when it cannot answer). */
export async function buildSupportReply(
  chatId: number,
  uid: string,
  question: string,
): Promise<string> {
  if (!hasAiKey()) return "";
  const [c, name, style, history, products, user] = await Promise.all([
    cfg(),
    siteName(),
    ownerStyleExamples(),
    threadHistory(uid),
    allProducts(),
    dbGet<any>(`users/${uid}`),
  ]);

  const catalogue = Object.entries(products)
    .filter(([, p]: [string, any]) => p && p.hidden !== true && String(p.title || "").trim())
    .slice(0, 40)
    .map(([id, p]: [string, any]) => `${id} — ${p.title} — ${money(Number(p.price || 0))}`)
    .join("\n");

  const instructions =
    `You are the support agent of the digital goods store "${name}" inside its Telegram bot. ` +
    `You are talking to a customer right now.\n\n` +
    `Rules:\n` +
    `- Answer like the owners do: short, friendly, direct, same language the customer writes in.\n` +
    `- Never invent products, prices, stock or policies. Use the tools to check facts.\n` +
    `- You may create payment links, verify crypto deposits, and buy + deliver products paid from the customer's wallet. Only buy when the customer clearly asked for that product.\n` +
    `- If something needs a human (refund, complaint, warranty dispute), say an owner will reply soon.\n` +
    `- Plain text only, no markdown. Keep it under 80 words unless details are needed.\n\n` +
    `Store facts:\n` +
    `Website: ${siteUrl() || "-"}\n` +
    `Crypto deposits: USDT/USDC on BEP20 or Polygon to ${c.depositAddress || "-"} (credited automatically within 10 minutes, older ones go to an owner).\n` +
    `Card / UPI top-ups: ${String(c.razorpayKeyId || "").trim() ? "available" : "not available"}.\n` +
    `Customer wallet: ${money(Number(user?.wallet || 0))}. Email: ${user?.email || "not set"}.\n\n` +
    `Products (id — title — price):\n${catalogue || "none"}\n\n` +
    (style.length
      ? `How the owners answer customers (copy this tone and wording):\n${style.join("\n---\n")}`
      : "");

  const input = [
    ...history,
    { role: "user", content: [{ type: "input_text", text: question }] },
  ];

  let reply = "";
  try {
    reply = await runSupportAgent({
      instructions,
      input,
      tools: TOOLS,
      exec: (toolName, args) => execTool(chatId, uid, toolName, args),
    });
  } catch (err) {
    console.error("support ai failed", err);
    return "";
  }
  return reply.trim();
}

async function aiReply(chatId: number, uid: string, question: string) {
  const reply = await buildSupportReply(chatId, uid, question);
  if (!reply) return;

  await dbPush(`support/${uid}/messages`, {
    from: "bot",
    text: reply,
    date: new Date().toISOString(),
  });
  await tg("sendMessage", {
    chat_id: chatId,
    text: `💬 ${esc(reply)}`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🛍 Products", callback_data: "products" }],
        [{ text: "⬅️ Back to Shop", callback_data: "home" }],
      ],
    },
  }).catch(() => undefined);
}

/** Every message a customer sends inside the support chat. */
export async function handleSupportMessage(chatId: number, text: string) {
  const body = String(text || "").trim();
  if (!body) return;
  const uid = await ensureUser(chatId);
  const at = Date.now();

  await Promise.all([
    dbPush(`support/${uid}/messages`, { from: "user", text: body, date: new Date().toISOString() }),
    dbPut(`support/${uid}/chatId`, chatId),
    dbPut(`support/${uid}/lastUserAt`, at),
  ]);
  await relayToOwners(uid, chatId, body);

  // An owner who answered this customer moments ago is online — stay quiet.
  const lastOwnerAt = Number((await dbGet<number>(`support/${uid}/lastOwnerAt`)) || 0);
  if (at - lastOwnerAt < OWNER_ONLINE_MS) return;

  await new Promise((r) => setTimeout(r, WAIT_FOR_OWNER_MS));
  const after = Number((await dbGet<number>(`support/${uid}/lastOwnerAt`)) || 0);
  if (after >= at) return;

  await aiReply(chatId, uid, body);
}

export const supportBack = backHome;
