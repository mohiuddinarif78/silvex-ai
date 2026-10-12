/** Handles every typed message and command in the bot. */
import { defaultDepositAddress, verifyDepositAnyChain } from "@/lib/deposit.server";
import { dbGet, dbPatch, dbPush, dbPut, money, notifyGroup, notifyOwners, tgTag } from "@/lib/telegram.server";

import { adminBack, askEmail, backHome, cfg, ensureUser, getState, invalidateProducts, isBotAdmin, maintenanceGate, say, saveConfig, saveEmail, setState, startJoinPrompt, welcome } from "@/lib/bot/core";
import {
  applyStartReferral,
  askQty,
  createCardLink,
  sendApiKey,
  sendApiDocsFile,
  sendOrders,
  sendProducts,
  sendProfile,
  sendRefer,
  sendReviews,
  sendSupport,
  sendWallet,
  startDeposit,
  submitReview,
} from "@/lib/bot/shop";
import { adminDeliver, adminFindUser, adminHome, adminProduct, adminUser, broadcast, broadcastMenu } from "@/lib/bot/admin";
import { emojiHome, emojiProductMessage, emojiToMessage } from "@/lib/bot/emoji-ui";
import { ADMIN_COMMANDS, USER_COMMANDS, registerAdminCommands, registerBotCommands } from "@/lib/bot/commands";

export async function handleText(
  chatId: number,
  text: string,
  entities?: any[],
  sticker?: any,
  replyToMessageId?: number,
  fromUser?: { id?: number; first_name?: string; last_name?: string; username?: string },
) {
  const t = text.trim();
  void dbPut(`telegramUsers/${chatId}`, true).catch(() => undefined);

  /* An owner replying to a forwarded support message answers that customer. */
  if (replyToMessageId && t && (await isBotAdmin(chatId))) {
    const { handleOwnerReply } = await import("@/lib/bot/support");
    if (await handleOwnerReply(chatId, replyToMessageId, t)) return;
  }

  if (await maintenanceGate(chatId)) return;

  if (t === "/start" || t === "/menu" || t.startsWith("/start ")) {
    await setState(chatId, null);
    void registerBotCommands().catch(() => undefined);
    if (await startJoinPrompt(chatId)) return;
    // Every /start goes to the activity group right away.
    if (t.startsWith("/start")) {
      const fullName = [fromUser?.first_name, fromUser?.last_name].filter(Boolean).join(" ").trim();
      const tag = fromUser?.username
        ? `@${fromUser.username}`
        : `user <code>${fromUser?.id ?? chatId}</code>`;
      // Logging must never delay the greeting. Resolve new/returning status and
      // notify the activity group entirely in the background.
      void dbGet<string>(`telegramLinks/${chatId}`)
        .then((linked) =>
          notifyGroup(
            `🚀 <b>${linked ? "BOT START" : "NEW BOT START"}</b>\n\n` +
              `👤 Name: ${fullName || "-"}\n` +
              `🆔 ID: <code>${fromUser?.id ?? chatId}</code>\n` +
              `🔗 Username: ${tag}`,
          ),
        )
        .catch(() => undefined);
    }
    if (t.startsWith("/start ")) {
      const uid = await ensureUser(chatId);
      await applyStartReferral(uid, t.slice(7));
    }
    return welcome(chatId);
  }
  /* quick-menu buttons under the message box */
  const quick = t.replace(/^[^\p{L}\p{N}]+/u, "").toLowerCase();
  if (quick === "products") {
    await setState(chatId, null);
    return sendProducts(chatId);
  }
  if (quick === "support") {
    await setState(chatId, null);
    return sendSupport(chatId);
  }
  if (quick === "wallet") {
    await setState(chatId, null);
    return sendWallet(chatId);
  }
  if (quick === "api") {
    await setState(chatId, null);
    await sendApiKey(chatId, false);
    return sendApiDocsFile(chatId);
  }
  if (quick === "warranty") {
    await setState(chatId, null);
    const c = await cfg();
    const txt =
      (c as any).warrantyText ||
      "Every product comes with a replacement warranty for the period written on its page.\n\n" +
        "• Report any issue with your order id\n" +
        "• Valid within the warranty period only\n" +
        "• Misuse, password change or sharing voids it";
    return say(chatId, `🛡 <b>Warranty</b>\n\n${txt}`, backHome);
  }

  if (t === "/link" || t === "/email") return askEmail(chatId);
  if (t === "/admin") {
    if (!(await isBotAdmin(chatId))) return say(chatId, "This command is for store owners only.");
    await setState(chatId, null);
    void registerAdminCommands(chatId).catch(() => undefined);
    return adminHome(chatId);
  }
  if (t === "/broadcast") {
    if (!(await isBotAdmin(chatId))) return say(chatId, "This command is for store owners only.");
    return broadcastMenu(chatId);
  }
  if (t === "/setemoji") {
    if (!(await isBotAdmin(chatId))) return say(chatId, "This command is for store owners only.");
    await setState(chatId, null);
    return emojiHome(chatId);
  }
  if (t === "/products" || t === "/shop") {
    await setState(chatId, null);
    return sendProducts(chatId);
  }
  if (t === "/wallet" || t === "/balance") {
    await setState(chatId, null);
    return sendWallet(chatId);
  }
  if (t === "/deposit" || t === "/topup") {
    await setState(chatId, null);
    return startDeposit(chatId);
  }
  if (t === "/orders") {
    await setState(chatId, null);
    return sendOrders(chatId);
  }
  if (t === "/profile" || t === "/account") {
    await setState(chatId, null);
    return sendProfile(chatId);
  }
  if (t === "/refer" || t === "/referral") {
    await setState(chatId, null);
    return sendRefer(chatId);
  }
  if (t === "/reviews") {
    await setState(chatId, null);
    return sendReviews(chatId);
  }
  if (t === "/apikey" || t === "/api") {
    await setState(chatId, null);
    await sendApiKey(chatId, false);
    return sendApiDocsFile(chatId);
  }
  if (t === "/support" || t === "/contact") {
    await setState(chatId, null);
    return sendSupport(chatId);
  }
  if (t === "/help" || t === "/commands") {
    await setState(chatId, null);
    const list = ((await isBotAdmin(chatId)) ? ADMIN_COMMANDS : USER_COMMANDS)
      .map((c) => `/${c.command} — ${c.description}`)
      .join("\n");
    return say(chatId, `📋 <b>Commands</b>\n\n${list}`, backHome);
  }

  const state = await getState(chatId);
  const k = state?.k;

  if (k === "await_email") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t))
      return say(chatId, "That does not look like an email. Send it like name@mail.com");
    return saveEmail(chatId, t);
  }

  if (k === "buy_qty") {
    const n = Math.floor(Number(t.trim()));
    if (!Number.isFinite(n) || n < 1 || n > 20)
      return say(chatId, "Please send a number between 1 and 20.");
    await setState(chatId, null);
    return askQty(chatId, String(state?.a || ""), n);
  }

  if (k === "prod_search") {
    await setState(chatId, null);
    return sendProducts(chatId, 0, t);
  }

  if (k === "dep_card") return createCardLink(chatId, t);

  if (k === "dep_hash") {
    const hash = t.trim();
    const uid = await ensureUser(chatId);

    // A plain number is a Binance Pay order id (internal Binance ID transfer).
    if (/^[0-9A-Za-z-]{6,30}$/.test(hash) && !/^(0x)?[0-9a-fA-F]{40,80}$/.test(hash)) {
      try {
        const { binanceConfig, settleBinancePay } = await import("@/lib/binance.server");
        const b = await binanceConfig();
        if (b.apiKey && b.apiSecret && b.payId) {
          const out = await settleBinancePay(uid, hash);
          await setState(chatId, null);
          return say(
            chatId,
            out.ok
              ? out.credited
                ? `✅ <b>Deposit done</b>\n${out.message}\nNew balance: <b>${money(out.balance)}</b>`
                : `ℹ️ ${out.message}`
              : `⚠️ ${out.message}`,
            backHome,
          );
        }
      } catch {
        /* fall through */
      }
      return say(chatId, "Send the full transaction id (TXID), or a Binance Pay order id.", backHome);
    }

    if (!/^(0x)?[0-9a-fA-F]{40,80}$/.test(hash))
      return say(chatId, "Send the full transaction id (TXID).");
    const u = await dbGet<any>(`users/${uid}`);
    const c = await cfg();

    // Binance transfers first: they are confirmed inside the store's account.
    try {
      const { binanceConfig, settleBinanceDeposit } = await import("@/lib/binance.server");
      const b = await binanceConfig();
      if (b.apiKey && b.apiSecret) {
        const out = await settleBinanceDeposit(uid, hash);
        if (out.ok) {
          await setState(chatId, null);
          return say(
            chatId,
            out.credited
              ? `✅ <b>Deposit done</b>\n${out.message}\nNew balance: <b>${money(out.balance)}</b>`
              : `ℹ️ ${out.message}`,
            backHome,
          );
        }
      }
    } catch {
      /* fall back to the public blockchain check */
    }

    if (!/^0x[0-9a-fA-F]{64}$/.test(hash))
      return say(chatId, "Send the full transaction hash, starting with 0x.", backHome);
    const address = c.depositAddress || defaultDepositAddress();
    if (!address)
      return say(
        chatId,
        "No deposit wallet is set up yet. Ask the store owner to add one in the admin panel.",
        backHome,
      );

    const already = await dbGet<any>(`deposits/${hash}`);
    if (already) return say(chatId, "This transaction has already been used.", backHome);

    try {
      const rl = await import("@/lib/rate-limit.server");
      rl.limitBy("bot-deposit", String(chatId), 10, rl.MINUTE);
    } catch (e) {
      return say(chatId, `⏳ ${(e as Error).message}`, backHome);
    }

    await say(chatId, "🔎 Checking the blockchain…");
    let res;
    try {
      res = await verifyDepositAnyChain(hash, address);
    } catch {
      return say(chatId, "Could not read that transaction right now. Try again in a minute.", backHome);
    }
    if (!res.ok) return say(chatId, `❌ ${res.message}`, backHome);

    await setState(chatId, null);
    const base = {
      uid,
      name: u?.name || "",
      email: u?.email || "",
      amount: res.amount,
      symbol: res.symbol,
      chain: res.chain,
      txHash: hash,
      source: "telegram",
      date: new Date().toISOString(),
    };

    if (res.status === "credited") {
      const { claimAndCreditDeposit } = await import("@/lib/wallet.server");
      const balance = await claimAndCreditDeposit(uid, hash, base, res.amount, `${res.symbol} on ${res.chain}`);
      if (balance === null) return say(chatId, "This transaction has already been used.", backHome);
      await say(
        chatId,
        `✅ <b>Deposit done</b>\n${money(res.amount)} ${res.symbol} on ${res.chain} credited.\nNew balance: <b>${money(balance)}</b>`,
        backHome,
      );
      return notifyOwners(
        `💰 <b>Telegram deposit credited</b>\n${await tgTag(chatId)}${u?.email ? ` (${u.email})` : ""}\nAmount: ${money(res.amount)}\nTX: <code>${hash}</code>`,
      );
    }

    await dbPut(`deposits/${hash}`, { ...base, status: "Pending" });
    await dbPush("requests", { ...base, type: "Deposit", utr: hash, status: "Pending" });
    await say(chatId, `⏳ ${res.message}`, backHome);
    return notifyOwners(
      `💰 <b>Telegram deposit for review</b>\n${await tgTag(chatId)}${u?.email ? ` (${u.email})` : ""}\nAmount: ${money(res.amount)}\nAge: ${res.ageMinutes} min\nTX: <code>${hash}</code>`,
    );
  }
  if (k === "wd_amount") {
    const uid = await ensureUser(chatId);
    const wallet = (await dbGet<number>(`users/${uid}/wallet`)) || 0;
    const amt = Number(t);
    if (!amt || amt <= 0) return say(chatId, "Send a valid amount.");
    if (amt > wallet) return say(chatId, `You only have ${money(wallet)}.`);
    await setState(chatId, { k: "wd_addr", a: String(amt) });
    return say(chatId, "Send the wallet address (USDT BEP20 / Polygon) to receive the payout.");
  }
  if (k === "wd_addr") {
    const uid = await ensureUser(chatId);
    const u = await dbGet<any>(`users/${uid}`);
    await dbPush("requests", {
      uid,
      name: u?.name || "",
      email: u?.email || "",
      type: "Withdraw",
      amount: Number(state?.a || 0),
      upi: t,
      status: "Pending",
      source: "telegram",
      date: new Date().toISOString(),
    });
    await setState(chatId, null);
    await say(chatId, "✅ Withdrawal requested. We will process it shortly.", backHome);
    return notifyOwners(
      `🏧 <b>Telegram withdrawal</b>\n${await tgTag(chatId)}${u?.email ? ` (${u.email})` : ""}\nAmount: ${money(Number(state?.a || 0))}\nTo: <code>${t}</code>`,
    );
  }
  if (k === "review") return submitReview(chatId, t);

  if (k === "support") {
    const { handleSupportMessage } = await import("@/lib/bot/support");
    return handleSupportMessage(chatId, t);
  }

  if (state && (await isBotAdmin(chatId))) {
    if (k === "em_to") return emojiToMessage(chatId, state.a!, text, entities, sticker);
    if (k === "em_prod") return emojiProductMessage(chatId, state.a!, text, entities, sticker);
    if (k === "deliver") return adminDeliver(chatId, state.a!, t);
    if (k === "bc") return broadcast(chatId, t, state.a);
    if (k === "cfg") {
      await saveConfig({ [state.a!]: t });
      await setState(chatId, null);
      return say(chatId, "✅ Saved.", adminBack);
    }
    if (k === "p_price") {
      await dbPatch(`products/${state.a}`, { price: Number(t) || 0 });
      invalidateProducts();
      await setState(chatId, null);
      return adminProduct(chatId, state.a!);
    }
    if (k === "p_stock") {
      const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
      const cur = (await dbGet<string[]>(`products/${state.a}/stock`)) || [];
      await dbPut(`products/${state.a}/stock`, [...cur.filter(Boolean), ...lines]);
      invalidateProducts();
      await setState(chatId, null);
      await say(chatId, `✅ Added ${lines.length} stock items.`);
      return adminProduct(chatId, state.a!);
    }
    if (k === "p_new") {
      const [rawTitle = "", rawPrice = "", ...rest] = t.split("|");
      const title = rawTitle.trim();
      const price = Number(String(rawPrice).replace(/[^0-9.]/g, "")) || 0;
      if (!title || !price)
        return say(chatId, "❌ Send it as: <code>Title | price | description</code>");
      const id = `p${Date.now().toString(36)}`;
      await dbPut(`products/${id}`, {
        id,
        title,
        price,
        desc: rest.join("|").trim(),
        delivery: "manual",
        stock: [],
        salesCount: 0,
      });
      invalidateProducts();
      await setState(chatId, null);
      await say(chatId, `✅ Product created: <b>${title}</b> — ${money(price)}`);
      return adminProduct(chatId, id);
    }
    if (k === "p_title") {
      await dbPatch(`products/${state.a}`, { title: t.trim() });
      invalidateProducts();
      await setState(chatId, null);
      return adminProduct(chatId, state.a!);
    }
    if (k === "p_desc") {
      await dbPatch(`products/${state.a}`, { desc: t.trim() });
      invalidateProducts();
      await setState(chatId, null);
      return adminProduct(chatId, state.a!);
    }
    if (k === "u_find") return adminFindUser(chatId, t);
    if (k === "u_wallet") {
      await dbPut(`users/${state.a}/wallet`, Number(t) || 0);
      await setState(chatId, null);
      return adminUser(chatId, state.a!);
    }
  }

  return welcome(chatId);
}
