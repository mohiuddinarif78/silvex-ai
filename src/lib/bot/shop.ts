/** Everything a shopper does in the bot: products, wallet, orders, buying. */
import { defaultDepositAddress } from "@/lib/deposit.server";
import { formatDescription } from "@/lib/format-desc";

import { dbGet, dbPush, dbPut, money, notifyOwners, siteUrl, tg, tgSendPhoto, tgTag } from "@/lib/telegram.server";
import { be, e as em, productEmoji, productEmojiChar } from "@/lib/emoji.server";
import { allProducts, backHome, cfg, editTarget, ensureUser, invalidateProducts, invalidateUsers, productById, say, type Product } from "./core";
import { payReferralCommission } from "./wallet";

export { defaultDepositAddress };
export {
  sendWallet,
  walletHistory,
  startDeposit,
  startCryptoDeposit,
  startCardDeposit,
  createCardLink,
  payProductByCard,
  checkCardPayment,
  startWithdraw,
  sendProfile,
  sendApiKey,
  sendApiDocsFile,
  sendOrders,
  sendReviews,
  submitReview,
  payReferralCommission,
  applyStartReferral,
  sendRefer,
  sendSupport,
} from "./wallet";

async function visibleProducts() {
  const all = await allProducts();
  return Object.entries(all).filter(
    ([, p]) => p && (p as any).hidden !== true && String(p.title || "").trim() !== "",
  ) as [string, Product][];
}

/** Live stock count by delivery mode (matches the detail view). */
function stockCount(p: Product): number | null {
  const anyP = p as unknown as { delivery?: string; supplierStock?: number; soldOut?: boolean };
  if (anyP.soldOut) return 0;
  if (anyP.delivery === "auto") return Array.isArray(p.stock) ? p.stock.filter(Boolean).length : 0;
  if (anyP.delivery === "supplier") return Number(anyP.supplierStock || 0);
  if (anyP.delivery === "manual") return null; // no countable stock
  return Infinity; // repeat = unlimited
}

const isOutOfStock = (p: Product) => stockCount(p) === 0;

/** Button label: emoji + name + price + stock, red when unavailable. */
function listButton(id: string, p: Product) {
  const stock = stockCount(p);
  const stockPart =
    stock === null ? "" : stock === Infinity ? " | ♾️" : ` | 📦 ${stock}`;
  const button: Record<string, unknown> = {
    text: `${productEmojiChar(id)} ${p.title} | ${money(p.price || 0)}${stockPart}`,
    callback_data: `p:${id}`,
  };
  if (isOutOfStock(p)) button["style"] = "danger";
  return button;
}

const PAGE_SIZE = 10;

type Entry = { kind: "product"; id: string; p: Product };

const norm = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Loose match so "cap" finds "CapCut" and "gemni" still finds "Gemini". */
function matches(haystack: string, query: string) {
  const h = norm(haystack);
  const q = norm(query);
  if (!q) return true;
  return q.split(" ").every((term) => {
    if (!term) return true;
    if (h.includes(term)) return true;
    return h.split(" ").some((word) => {
      if (word.startsWith(term) || term.startsWith(word)) return true;
      if (term.length < 4) return false;
      // allow one typo
      let diff = 0;
      const len = Math.max(word.length, term.length);
      if (Math.abs(word.length - term.length) > 1) return false;
      for (let i = 0, j = 0; i < len; i++, j++) {
        if (word[i] === term[j]) continue;
        if (++diff > 1) return false;
        if (word.length > term.length) j--;
        else if (term.length > word.length) i--;
      }
      return true;
    });
  });
}

/** All visible products, optionally filtered by a search term. */
async function catalog(query = ""): Promise<Entry[]> {
  const entries = await visibleProducts();
  const out: Entry[] = [];
  for (const [id, p] of entries) {
    if (matches(`${p.title || ""} ${(p as any).type || ""}`, query))
      out.push({ kind: "product", id, p });
  }
  return out;
}

const searchButton = () => ({ text: "Search products", callback_data: "psearch" });

export async function sendProducts(chatId: number, page = 0, query = "") {
  const q = String(query || "").slice(0, 30);
  const entries = await catalog(q);

  if (!entries.length) {
    if (q) {
      // Nobody found anything for this search — let the owners and the log group know.
      void notifyOwners(
        `🔍 <b>Search with no result</b>\nUser: ${await tgTag(chatId)}\nSearched: <b>${q.replace(/</g, "&lt;")}</b>`,
      ).catch(() => undefined);
      return say(
        chatId,
        `🔍 Nothing found for <b>${q.replace(/</g, "&lt;")}</b>.\n\nWe told the store owner — they will add it or reply to you soon.`,
        {
          inline_keyboard: [
            [searchButton()],
            [{ text: "⬅️ Back to Products", callback_data: "products" }],
          ],
        },
      );
    }
    return say(chatId, "No products available right now.", backHome);
  }

  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const current = Math.min(Math.max(0, Math.floor(page)), pages - 1);
  const slice = entries.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE);
  const move = (n: number) => (q ? `sq:${n}:${q}` : `pg:${n}`);

  // Premium (custom) emoji only render inside message text, never on buttons,
  // so the list itself carries them and the buttons stay plain.
  const lines = slice
    .map((entry) => `${productEmoji(entry.id)} <b>${entry.p.title}</b> — ${money(entry.p.price || 0)}`)
    .join("\n");

  const nav: { text: string; callback_data: string }[] = [];
  if (current > 0) nav.push({ text: "Previous Page", callback_data: move(current - 1) });
  if (current < pages - 1) nav.push({ text: "Next Page", callback_data: move(current + 1) });

  const header = q ? `🔍 <b>Results for “${q.replace(/</g, "&lt;")}”</b>` : `${em("btn.products")} <b>Products</b>`;

  await say(
    chatId,
    `${header}\n\n${lines}\n\nPage <b>${current + 1}</b> of <b>${pages}</b> — tap any item below to see details.`,
    {
      inline_keyboard: [
        ...slice.map((entry) => [listButton(entry.id, entry.p)]),
        ...(nav.length ? [nav] : []),
        [searchButton()],
        [{ text: "Back to Shop", callback_data: "home" }],
      ],
    },
  );
}

/** Asks the shopper what they are looking for. */
export async function askProductSearch(chatId: number) {
  const { setState } = await import("./core");
  await setState(chatId, { k: "prod_search" });
  return say(chatId, "🔍 Send what you are looking for (for example <code>cap</code> for CapCut).", {
    inline_keyboard: [[{ text: "⬅️ Back to Products", callback_data: "products" }]],
  });
}

export async function sendProduct(chatId: number, id: string) {
  const p = await productById(id);
  if (!p) return say(chatId, "Product not found.", backHome);

  const stock = Array.isArray(p.stock) ? p.stock.filter(Boolean).length : 0;
  const stockLine =
    p.delivery === "auto"
      ? `${em("norm.box")} Stock: <b>${stock}</b>`
      : p.delivery === "supplier"
        ? `${em("norm.box")} Stock: <b>${Number(p.supplierStock || 0)}</b>`
        : p.delivery === "repeat"
          ? `${em("norm.box")} Stock: <b>Unlimited</b>`
          : `${em("norm.clock")} Manual delivery`;
  const availability = isOutOfStock(p)
    ? `\n${em("norm.box")} <b>Out of stock</b>`
    : p.delivery === "manual"
      ? ""
      : `\n${em("norm.fast")} Instant delivery`;
  const sold = Number((p as any).salesCount || 0);

  const escDesc = formatDescription(String(p.desc || ""))
    .split("\n")
    .map((line) => line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"))
    .join("\n");
  const text =
    `${productEmoji(id)} <b>${p.title || "Item"}</b>\n\n` +
    `${em("norm.money")} Price: <b>${money(p.price || 0)}</b>\n` +
    `${stockLine}\n${em("norm.fire")} Total sold: <b>${sold}</b>${availability}` +
    // Description renders as an expandable quote. It must start on its own
    // line after the header block — the quote tag sits directly after the
    // separating newlines so the quote never swallows header text.
    (escDesc ? `\n\n<blockquote expandable>${escDesc}</blockquote>` : "");

  const keyboard = {
    inline_keyboard: [
      ...(isOutOfStock(p)
        ? [[{ text: "🚫 Out of stock", callback_data: `p:${id}` }]]
        : [[{ text: `🟢 ${be("btn.buy")} Buy now — ${money(p.price || 0)}`, callback_data: `b:${id}` }]]),
      [
        { text: `🔵 ${be("btn.back")} Back to Products`, callback_data: "products" },
        { text: `🟣 ${be("btn.wallet")} Wallet`, callback_data: "wallet" },
      ],
    ],
  };
  if (p.logo) {
    editTarget.delete(chatId);
    const sent = await tgSendPhoto(chatId, p.logo, text, keyboard);
    if (sent) return;
  }
  await say(chatId, text, keyboard);
}

async function maxQty(p: Product) {
  const anyP = p as unknown as { delivery?: string; supplierStock?: number };
  const stock = Array.isArray(p.stock) ? p.stock.filter(Boolean).length : 0;
  const available =
    anyP.delivery === "auto"
      ? stock
      : anyP.delivery === "supplier"
        ? Number(anyP.supplierStock || 0)
        : 20;
  return Math.max(1, Math.min(20, available || 1));
}

/** Asks how many copies the buyer wants. Buttons hold numbers only; the price is in the text. */
export async function askQty(chatId: number, productId: string, qty = 1) {
  const p = await productById(productId);
  if (!p) return say(chatId, "Product not found.", backHome);
  if (isOutOfStock(p))
    return say(chatId, "This product is out of stock right now.", backHome);
  const price = Number(p.price || 0);
  const max = await maxQty(p);
  const count = Math.max(1, Math.min(Math.floor(Number(qty) || 1), max));
  const choices = [1, 3, 5, 10, 20].filter((n) => n <= max);
  if (!choices.length) choices.push(1);
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < choices.length; i += 3) {
    rows.push(
      choices.slice(i, i + 3).map((n) => ({
        text: n === count ? `${productEmojiChar(productId)} ${n}` : `${n}`,
        callback_data: `bq:${productId}:${n}`,
      })),
    );
  }
  rows.push([{ text: "✏️ Custom number", callback_data: `bqc:${productId}` }]);
  rows.push([{ text: "➡️ Continue", callback_data: `bpm:${productId}:${count}` }]);
  await say(
    chatId,
    `${productEmoji(productId)} <b>${p.title}</b>\n\n` +
      `Price: <b>${money(price)}</b> each\n` +
      `Selected quantity: <b>${count}</b>\n` +
      `Total: <b>${money(Math.round(price * count * 100) / 100)}</b>\n\n` +
      `Pick another quantity if you like (1–${max}), then press Continue.`,
    { inline_keyboard: [...rows, [{ text: "⬅️ Back to Product", callback_data: `p:${productId}` }]] },
  );
}

/** Shows how the buyer can pay for the chosen quantity. */
export async function askPayMethod(chatId: number, productId: string, qty: number) {
  const p = await productById(productId);
  if (!p) return say(chatId, "Product not found.", backHome);
  if (isOutOfStock(p))
    return say(chatId, "This product is out of stock right now.", backHome);
  const uid = await ensureUser(chatId);
  const user = (await dbGet<any>(`users/${uid}`)) || {};
  const wallet = Number(user.wallet || 0);
  const total = Math.round(Number(p.price || 0) * qty * 100) / 100;
  const c = await cfg();
  const rows: any[] = [
    [{ text: `💰 Wallet (${money(wallet)})`, callback_data: `bcf:${productId}:${qty}` }],
  ];
  if (String(c.razorpayKeyId || "").trim())
    rows.push([{ text: "💳 Card / UPI", callback_data: `pbc:${productId}:${qty}` }]);
  rows.push([{ text: "🪙 Crypto (USDT)", callback_data: "depcrypto" }]);
  rows.push([{ text: "⬅️ Back to Quantity", callback_data: `bq:${productId}:${qty}` }]);
  await say(
    chatId,
    `💳 <b>Payment method</b>\n\n${productEmoji(productId)} ${p.title}\nQuantity: <b>${qty}</b>\nTotal: <b>${money(total)}</b>\n` +
      `Wallet balance: ${money(wallet)}\n\n` +
      (wallet < total
        ? "Your wallet is short for this order — top it up with card or crypto first."
        : "Choose how you want to pay."),
    { inline_keyboard: rows },
  );
}

/** Final confirmation, only needed when paying from the wallet. */
export async function confirmWalletPay(chatId: number, productId: string, qty: number) {
  const p = await productById(productId);
  if (!p) return say(chatId, "Product not found.", backHome);
  if (isOutOfStock(p))
    return say(chatId, "This product is out of stock right now.", backHome);
  const total = Math.round(Number(p.price || 0) * qty * 100) / 100;
  await say(
    chatId,
    `${productEmoji(productId)} <b>Confirm your order</b>\n\n${p.title}\nQuantity: <b>${qty}</b>\nTotal: <b>${money(total)}</b>\n\nThis amount will be taken from your wallet.`,
    {
      inline_keyboard: [
        [{ text: `${productEmojiChar(productId)} Confirm & pay`, callback_data: `bgo:${productId}:${qty}` }],
        [{ text: "⬅️ Back to Payment Methods", callback_data: `bpm:${productId}:${qty}` }],
      ],
    },
  );
}

const escHtml = (s: string) =>
  String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);

/** Splits delivered items into Telegram-sized messages (limit is 4096 chars). */
function deliveryChunks(items: { title: string; content: string }[], max = 3500): string[] {
  const out: string[] = [];
  let cur = "";
  items.forEach((d, i) => {
    const block = `${i + 1}. <code>${escHtml(d.content)}</code>`;
    if (cur && cur.length + block.length + 2 > max) {
      out.push(cur);
      cur = "";
    }
    cur += (cur ? "\n\n" : "") + block;
  });
  if (cur) out.push(cur);
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Safely add/remove wallet money even when several orders run at once. */
async function changeWallet(uid: string, delta: number, mustCover = 0): Promise<number | undefined> {
  const { dbTransact } = await import("@/lib/telegram.server");
  return dbTransact<number>(`users/${uid}/wallet`, (cur) => {
    const w = Number(cur || 0);
    if (mustCover > 0 && w < mustCover) return undefined;
    return round2(w + delta);
  });
}

export async function buy(chatId: number, productId: string, qty = 1) {
  const uid = await ensureUser(chatId);
  const [p, storedUser] = await Promise.all([
    dbGet<Product>(`products/${productId}`),
    dbGet<any>(`users/${uid}`),
  ]);
  if (!p) return say(chatId, "Product not found.", backHome);
  if (isOutOfStock(p))
    return say(chatId, "This product is out of stock right now.", backHome);
  const count = Math.max(1, Math.min(Math.floor(Number(qty) || 1), 100));
  const unitPrice = Number(p.price || 0);
  const price = round2(unitPrice * count);
  const user = storedUser || {};
  const title = p.title || "Item";
  const buyer = user.email || `tg:${chatId}`;

  // Never take money for more items than are available.
  if (p.delivery === "auto") {
    const have = Array.isArray(p.stock) ? p.stock.filter(Boolean).length : 0;
    if (have < count)
      return say(chatId, `Only <b>${have}</b> in stock right now — please choose a smaller quantity.`, backHome);
  } else if (p.delivery === "supplier" && p.supplierStock != null && Number(p.supplierStock) < count) {
    return say(
      chatId,
      `Only <b>${Number(p.supplierStock)}</b> in stock right now — please choose a smaller quantity.`,
      backHome,
    );
  }

  // Take the money first, atomically, so parallel taps can't overspend.
  const after = await changeWallet(uid, -price, price);
  if (after === undefined) {
    const wallet = Number((await dbGet<number>(`users/${uid}/wallet`)) || 0);
    return say(chatId, `Not enough wallet balance. You have ${money(wallet)}, this order costs ${money(price)}.`, {
      inline_keyboard: [[{ text: `🟢 ${be("btn.deposit")} Deposit`, callback_data: "dep" }]],
    });
  }

  const delivered: { title: string; content: string }[] = [];
  let complete = false;
  let failReason = "";
  if (p.delivery === "supplier") {
    try {
      const { supplierBuy } = await import("@/lib/supplier.server");
      const items = await supplierBuy(
        p.supplierId ?? "",
        count,
        `tg-${chatId}-${Date.now()}`,
        String(p.provider || "custom"),
      );
      for (const content of items) delivered.push({ title, content });
      complete = delivered.length >= count;
    } catch (err) {
      failReason = err instanceof Error ? err.message : String(err);
    }
  } else if (p.delivery === "repeat" && p.link) {
    for (let i = 0; i < count; i++) delivered.push({ title, content: p.link });
    complete = true;
  } else if (p.delivery === "auto") {
    // Claim the exact items atomically so two buyers never get the same account.
    const { dbTransact } = await import("@/lib/telegram.server");
    let taken: string[] = [];
    try {
      await dbTransact<string[]>(`products/${productId}/stock`, (cur) => {
        const list = Array.isArray(cur) ? cur.filter(Boolean) : [];
        if (list.length < count) {
          taken = [];
          return undefined;
        }
        taken = list.slice(0, count);
        return list.slice(count);
      });
    } catch (err) {
      failReason = err instanceof Error ? err.message : String(err);
    }
    for (const content of taken) delivered.push({ title, content });
    complete = taken.length === count;
    if (!complete && !failReason) failReason = "Not enough stock left";
  }

  // Automatic products that could not be delivered: give the money back.
  const autoKind = p.delivery === "supplier" || p.delivery === "auto";
  const missing = count - delivered.length;
  if (autoKind && delivered.length === 0) {
    await changeWallet(uid, price).catch(() => undefined);
    await say(
      chatId,
      `⚠️ <b>Delivery could not be completed</b>\n\n${escHtml(title)} × ${count}\nYour ${money(price)} has been returned to your wallet. Please try again in a moment or choose a smaller quantity.`,
      { inline_keyboard: [[{ text: "🛍 Back to shop", callback_data: "products" }]] },
    );
    await notifyOwners(
      `⚠️ <b>Telegram delivery failed — refunded</b>\n${escHtml(title)} × ${count}\nBuyer: ${await tgTag(chatId)}\nAmount: ${money(price)}\nReason: ${escHtml(failReason.slice(0, 300))}`,
    );
    return;
  }

  // Supplier sent fewer items than paid for: refund the missing units.
  let charged = price;
  if (autoKind && missing > 0) {
    const back = round2(missing * unitPrice);
    if (back > 0) {
      await changeWallet(uid, back).catch(() => undefined);
      charged = round2(price - back);
      await say(
        chatId,
        `⚠️ The supplier only had <b>${delivered.length}</b> of ${count} ${escHtml(title)} left. ${money(back)} has been returned to your wallet for the ${missing} undelivered.`,
      );
      await notifyOwners(
        `⚠️ <b>Partial supplier delivery</b>\n${escHtml(title)}\nOrdered: ${count} · Delivered: ${delivered.length}\nBuyer: ${await tgTag(chatId)}\nRefunded: ${money(back)}`,
      );
    }
  }

  // A partial supplier delivery still counts as delivered for what arrived.
  if (delivered.length > 0) complete = true;

  const orderId = "ORD" + Date.now() + Math.floor(Math.random() * 90 + 10);
  const now = new Date().toISOString();
  await Promise.all([
    ...(p.delivery === "repeat"
      ? []
      : delivered.map((d) =>
          dbPush(`usedStock/${productId}`, { content: d.content, orderId, email: buyer, date: now }),
        )),
    dbPut(`orders/${orderId}`, {
      orderId,
      uid,
      email: user.email || "",
      items: [{ ...p, stock: null, id: productId, qty: count, price: unitPrice }],
      subTotal: charged,
      couponDiscount: 0,
      couponCode: null,
      total: charged,
      phone: user.phone || "",
      note:
        missing > 0
          ? `Ordered from Telegram bot · partial delivery ${delivered.length}/${count}, ${money(round2(price - charged))} refunded`
          : "Ordered from Telegram bot",
      source: "telegram",
      telegramChatId: chatId,
      delivered,
      status: complete ? "Completed" : "Pending",
      date: now,
    }),
    dbPush(`users/${uid}/history`, {
      type: "Purchase",
      amount: charged,
      desc: `Order ${orderId.slice(-4)}`,
      date: now,
    }),
    ...(missing > 0
      ? [
          dbPush(`users/${uid}/history`, {
            type: "Refund",
            amount: round2(price - charged),
            desc: `Partial delivery on order ${orderId.slice(-4)} (${delivered.length}/${count})`,
            date: now,
          }),
        ]
      : []),
    dbPut(`products/${productId}/salesCount`, Number(p.salesCount || 0) + count),
  ]);
  invalidateProducts();
  invalidateUsers();
  await payReferralCommission(uid, charged);

  const footer = `\n\nOrder: <code>${orderId}</code>\nPaid: ${money(charged)}\n\n🌐 Website: ${siteUrl()}`;
  const keyboard = {
    inline_keyboard: [
      [{ text: "🌐 Visit website", url: siteUrl() }],
      [{ text: "🛍 Buy more", callback_data: "products" }],
    ],
  };
  if (!complete) {
    await say(chatId, `🧾 <b>Order placed</b>\n\n${escHtml(title)}\nWe will deliver it shortly.${footer}`, keyboard);
  } else {
    // Bulk orders (e.g. many mail accounts) are split so Telegram never rejects them.
    const chunks = deliveryChunks(delivered);
    const head = `✅ <b>Order delivered</b>\n\n${escHtml(title)} × ${delivered.length}`;
    if (chunks.length === 1 && head.length + chunks[0]!.length + footer.length < 3900) {
      await say(chatId, `${head}\n\n${chunks[0]}${footer}`, keyboard);
    } else {
      await say(chatId, `${head}\n\nYour items are below 👇`);
      for (let i = 0; i < chunks.length; i++) {
        await tg("sendMessage", {
          chat_id: chatId,
          text: `📦 <b>Part ${i + 1}/${chunks.length}</b>\n\n${chunks[i]}`,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }).catch((e) => console.error("delivery part failed", e));
      }
      await tg("sendMessage", {
        chat_id: chatId,
        text: `✅ All ${delivered.length} items delivered.${footer}`,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: keyboard,
      }).catch(() => undefined);
    }
    // A text file copy makes bulk orders easy to save.
    if (delivered.length >= 5) {
      const { tgSendDocument } = await import("./delivery-files.server");
      await tgSendDocument(
        chatId,
        `order-${orderId}.txt`,
        new TextEncoder().encode(delivered.map((d) => d.content).join("\n") + "\n"),
        "text/plain",
        `📄 ${escHtml(title)} × ${delivered.length}`,
      ).catch(() => undefined);
    }
  }
  // Delivery receipt files removed — the message above already carries the content.
  await notifyOwners(
    `🛒 <b>New Telegram order</b>\n${p.title}\n🔢 Quantity: <b>${count}</b>\n💵 Unit price: ${money(unitPrice)}\nBuyer: ${await tgTag(chatId)}${user.email ? ` (${user.email})` : ""}\nTotal: ${money(charged)}\nOrder: ${orderId}\nStatus: ${complete ? "Completed" : "Pending"}`,
  );
}
