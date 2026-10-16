/** Handles every button tap in the bot. */

import { dbGet, dbPatch, dbPut } from "@/lib/telegram.server";
import { isPermanentOwner } from "@/lib/owners";
import { resetAllEmojis, syncEmojiImages } from "@/lib/emoji.server";
import { adminBack, askEmail, cfg, invalidateProducts, isBotAdmin, maintenanceGate, say, saveConfig, setState, startJoinPrompt, welcome } from "@/lib/bot/core";
import { askPayMethod, askProductSearch, askQty, buy, checkCardPayment, payProductByCard, confirmWalletPay, sendApiDocsFile, sendApiKey, sendOrders, sendProduct, sendProducts, sendProfile, sendRefer, sendReviews, sendSupport, sendWallet, startCardDeposit, startCryptoDeposit, startDeposit, startWithdraw, walletHistory } from "@/lib/bot/shop";
import { adminAskDelivery, adminCancelOrder, adminDecideRequest, adminHome, adminOrder, adminOrders, adminProduct, adminProducts, adminRequests, adminSettings, adminStats, adminUser, adminUsers, broadcast, broadcastMenu, broadcastTemplate, broadcastTemplates } from "@/lib/bot/admin";
import { clearProductEmoji, emojiGroup, emojiHome, emojiList, emojiProducts, emojiSlotPick, emojiSlotReset, emojiToggle } from "@/lib/bot/emoji-ui";

const seenUsers = new Set<number>();
export async function handleCallback(chatId: number, data: string, callbackId?: string) {
  if (data === "noop") return;
  if (!seenUsers.has(chatId)) { seenUsers.add(chatId); void dbPut(`telegramUsers/${chatId}`, true).catch(() => undefined); }
  if (data === "joinskip") {
    await setState(chatId, null);
    return welcome(chatId);
  }
  if (data === "joincheck") {
    if (await startJoinPrompt(chatId)) return;
    return welcome(chatId);
  }
  if (data === "home") {
    await setState(chatId, null);
    return welcome(chatId);
  }

  if (data.startsWith("a:")) {
    if (!(await isBotAdmin(chatId))) return;
    const [, key, arg, arg2] = data.split(":");
    if (key === "home") return adminHome(chatId);
    if (key === "stats") return adminStats(chatId);
    if (key === "orders") return adminOrders(chatId);
    if (key === "o") return adminOrder(chatId, arg!);
    if (key === "dl") return adminAskDelivery(chatId, arg!);
    if (key === "oc") return adminCancelOrder(chatId, arg!);
    if (key === "req") return adminRequests(chatId);
    if (key === "ra") return adminDecideRequest(chatId, arg!, true);
    if (key === "rr") return adminDecideRequest(chatId, arg!, false);
    if (key === "prod") return adminProducts(chatId);
    if (key === "p") return adminProduct(chatId, arg!);
    if (key === "pp") {
      await setState(chatId, { k: "p_price", a: arg! });
      return say(chatId, "Send the new price in dollars (e.g. 9.99).");
    }
    if (key === "ps") {
      await setState(chatId, { k: "p_stock", a: arg! });
      return say(chatId, "Send the stock lines — one line = one stock item.");
    }
    if (key === "pd") {
      await dbPatch(`products/${arg}`, { delivery: arg2 });
      invalidateProducts();
      return adminProduct(chatId, arg!);
    }
    if (key === "pnew") {
      await setState(chatId, { k: "p_new" });
      return say(
        chatId,
        "🆕 <b>New product</b>\n\nSend it as:\n<code>Title | price | description</code>\n\nExample:\n<code>Netflix 1 Month | 3.5 | Private profile, 30 days warranty</code>",
        { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "a:prod" }]] },
      );
    }
    if (key === "pt") {
      await setState(chatId, { k: "p_title", a: arg! });
      return say(chatId, "Send the new product title.");
    }
    if (key === "pdsc") {
      await setState(chatId, { k: "p_desc", a: arg! });
      return say(chatId, "Send the new product description.");
    }
    if (key === "psc") {
      await dbPut(`products/${arg}/stock`, []);
      invalidateProducts();
      return adminProduct(chatId, arg!);
    }
    if (key === "pdel") {
      await dbPut(`products/${arg}`, null);
      invalidateProducts();
      await say(chatId, "🗑 Product deleted.");
      return adminProducts(chatId);
    }
    if (key === "users") return adminUsers(chatId);
    if (key === "stmt" || key === "ust") {
      const { sendStatement } = await import("@/lib/bot/wallet");
      return sendStatement(chatId, key === "ust" ? arg : undefined);
    }
    if (key === "u") return adminUser(chatId, arg!);
    if (key === "uw") {
      await setState(chatId, { k: "u_wallet", a: arg! });
      return say(chatId, "Send the new wallet balance in dollars.");
    }
    if (key === "ua") {
      // Only permanent owners keep admin; granting admin to others is blocked.
      const target = await dbGet<any>(`users/${arg}`);
      if (!target || isPermanentOwner(target.email)) return adminUser(chatId, arg!);
      if (target.isAdmin) {
        await dbPatch(`users/${arg}`, { isAdmin: false, isOwner: false, ownerRevoked: true });
      }
      return adminUser(chatId, arg!);
    }
    if (key === "bc") return broadcastMenu(chatId);
    if (key === "bcpg") return broadcastMenu(chatId, Number(arg) || 0);
    if (key === "bcp") return broadcastTemplates(chatId, arg!);
    if (key === "bct") return broadcastTemplate(chatId, arg!, arg2!);
    if (key === "bcc") {
      await setState(chatId, { k: "bc" });
      return say(chatId, "📣 Send the message to broadcast to every bot user.", {
        inline_keyboard: [[{ text: "❌ Cancel", callback_data: "a:home" }]],
      });
    }
    if (key === "fj") {
      const c = await cfg();
      return say(chatId, `🔒 <b>Force join</b>\n\nCurrent: ${c.forceJoin || "off"}`, {
        inline_keyboard: [
          [{ text: "✏️ Set channel", callback_data: "a:s:forceJoin" }],
          [{ text: "🚫 Turn off", callback_data: "a:fjoff" }],
          [{ text: "⬅️ Back to Admin Panel", callback_data: "a:home" }],
        ],
      });
    }
    if (key === "fjoff") {
      await saveConfig({ forceJoin: "" });
      return say(chatId, "Force join turned off.", adminBack);
    }
    if (key === "rc") {
      const c = await cfg();
      return say(chatId, `⭐ <b>Review channel</b>\n\nCurrent: ${c.reviewChannel || "not set"}`, {
        inline_keyboard: [
          [{ text: "✏️ Set channel", callback_data: "a:s:reviewChannel" }],
          [{ text: "⬅️ Back to Admin Panel", callback_data: "a:home" }],
        ],
      });
    }
    if (key === "set") return adminSettings(chatId);
    if (key === "maint") {
      const c = await cfg();
      await saveConfig({ maintenanceMode: !c.maintenanceMode });
      await say(
        chatId,
        c.maintenanceMode
          ? "✅ Maintenance mode is off — the shop is open for everyone again."
          : "🛠 Maintenance mode is on — only owners can use the bot now.",
      );
      return adminSettings(chatId);
    }
    if (key === "em") {
      if (arg === "list") return emojiList(chatId);
      if (arg === "tog") return emojiToggle(chatId);
      if (arg === "prod") return emojiProducts(chatId);
      if (arg === "sync") {
        const fixed = await syncEmojiImages().catch(() => 0);
        return emojiHome(chatId, `🔄 ${fixed} emoji picture(s) synced for the website.`);
      }
      if (arg === "rst")
        return say(chatId, "♻️ Remove every emoji you set (bot + website + products)?", {
          inline_keyboard: [
            [{ text: "✅ Yes, reset all", callback_data: "a:em:rst2" }],
            [{ text: "❌ Cancel", callback_data: "a:em" }],
          ],
        });
      if (arg === "rst2") {
        await resetAllEmojis();
        return emojiHome(chatId, "♻️ All emojis are back to the defaults.");
      }
      return emojiHome(chatId);
    }
    if (key === "emL") return emojiList(chatId, Number(arg) || 0);
    if (key === "emP") return emojiProducts(chatId, Number(arg) || 0);
    if (key === "emg") return emojiGroup(chatId, String(arg), Number(arg2) || 0);
    if (key === "emk") return emojiSlotPick(chatId, data.slice("a:emk:".length));
    if (key === "emd") return emojiSlotReset(chatId, data.slice("a:emd:".length));
    if (key === "emp") {
      const id = data.slice("a:emp:".length);
      if (!id) return emojiProducts(chatId);
      await setState(chatId, { k: "em_prod", a: id });
      return say(chatId, "Send the emoji for this product (premium emoji supported).", {
        inline_keyboard: [
          [{ text: "♻️ Use default 🛍", callback_data: `a:emx:${id}` }],
          [{ text: "❌ Cancel", callback_data: "a:em:prod" }],
        ],
      });
    }
    if (key === "emx") {
      const id = data.slice("a:emx:".length);
      await setState(chatId, null);
      await clearProductEmoji(id);
      await say(chatId, "♻️ Product emoji reset to the default.");
      return emojiProducts(chatId);
    }

    if (key === "s") {
      await setState(chatId, { k: "cfg", a: arg! });
      return say(chatId, `Send the new value for <b>${arg}</b>.`, {
        inline_keyboard: [[{ text: "❌ Cancel", callback_data: "a:home" }]],
      });
    }
    return;
  }

  if (await maintenanceGate(chatId)) return;

  if (data === "products") return sendProducts(chatId);
  if (data === "psearch") return askProductSearch(chatId);
  if (data.startsWith("pg:")) return sendProducts(chatId, Number(data.slice(3)) || 0);
  if (data.startsWith("sq:")) {
    const rest = data.slice(3);
    const cut = rest.indexOf(":");
    return sendProducts(chatId, Number(rest.slice(0, cut)) || 0, rest.slice(cut + 1));
  }
  if (data === "wallet") return sendWallet(chatId);
  if (data === "whist") return walletHistory(chatId);
  if (data === "stmt") {
    const { sendMyStatement } = await import("@/lib/bot/wallet");
    return sendMyStatement(chatId);
  }
  if (data === "dep") return startDeposit(chatId);
  if (data === "depcrypto") return startCryptoDeposit(chatId);
  if (data === "depcard") return startCardDeposit(chatId);
  if (data === "wd") return startWithdraw(chatId);
  if (data === "profile") return sendProfile(chatId);
  if (data === "apikey") return sendApiKey(chatId, false);
  if (data === "apikey_new") return sendApiKey(chatId, true);
  if (data === "apikey_docs") return sendApiDocsFile(chatId);
  if (data === "orders") return sendOrders(chatId);
  if (data === "reviews") return sendReviews(chatId);
  if (data === "rev_new") {
    await setState(chatId, { k: "review" });
    return say(chatId, "✍️ Send your review (start with a number 1-5 for the rating, e.g. “5 great service”).");
  }
  if (data === "refer") return sendRefer(chatId);
  if (data === "support") return sendSupport(chatId);
  if (data === "sup") {
    const { startSupportChat } = await import("@/lib/bot/support");
    return startSupportChat(chatId);
  }
  if (data === "link" || data === "setmail") return askEmail(chatId);
  if (data.startsWith("p:")) return sendProduct(chatId, data.slice(2));
  if (data.startsWith("bqc:")) {
    const pid = data.slice(4);
    await setState(chatId, { k: "buy_qty", a: pid });
    return say(chatId, "✏️ Send the number of items you want (1–20).", {
      inline_keyboard: [[{ text: "⬅️ Back to Product", callback_data: `b:${pid}` }]],
    });
  }
  if (data.startsWith("bq:")) {
    const [, pid, n] = data.split(":");
    return askQty(chatId, String(pid), Number(n) || 1);
  }
  if (data.startsWith("bpm:")) {
    const [, pid, n] = data.split(":");
    return askPayMethod(chatId, String(pid), Number(n) || 1);
  }
  if (data.startsWith("bcf:")) {
    const [, pid, n] = data.split(":");
    return confirmWalletPay(chatId, String(pid), Number(n) || 1);
  }
  if (data.startsWith("bgo:")) {
    const [, pid, n] = data.split(":");
    return buy(chatId, String(pid), Number(n) || 1, callbackId);
  }
  if (data.startsWith("pbc:")) {
    const [, pid, n] = data.split(":");
    return payProductByCard(chatId, String(pid), Number(n) || 1);
  }
  if (data.startsWith("pchk:")) return checkCardPayment(chatId, data.slice(5));
  if (data.startsWith("b:")) return askQty(chatId, data.slice(2));
}
