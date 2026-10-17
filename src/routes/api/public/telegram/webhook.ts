import { createFileRoute } from "@tanstack/react-router";
import {
  dbCreateIfAbsent,
  dbGet,
  dbUidByChatId,
  loadBotRuntime,
  rememberUsername,
  telegramWebhookOk,
  tg,
} from "@/lib/telegram.server";
import { editTarget, loadBotPresentation, rememberName } from "@/lib/bot/core";
import { handleCallback } from "@/lib/bot/route-callback";
import { handleText } from "@/lib/bot/route-text";

/**
 * True when the Telegram account behind this chat has been banned by an admin.
 * The ban is stored on the store user as `blocked` (same flag the website and
 * reseller API already honour). We resolve the chat id to its uid via the
 * indexed lookup, falling back to the deterministic `tg_<chatId>` id used for
 * bot-only accounts. Reads only — never creates a user.
 */
async function isChatBlocked(chatId: number): Promise<boolean> {
  try {
    const uid = (await dbUidByChatId(chatId).catch(() => null)) || `tg_${chatId}`;
    return Boolean(await dbGet<boolean>(`users/${uid}/blocked`));
  } catch {
    return false; // never let a lookup error lock everyone out
  }
}

const chatQueues = new Map<string, Promise<void>>();
const SUPPLIER_SYNC_INTERVAL_MS = 60_000;
let supplierSyncStartedAt = 0;
let supplierSyncing: Promise<unknown> | null = null;

function refreshSuppliersInBackground() {
  const now = Date.now();
  if (supplierSyncing || now - supplierSyncStartedAt < SUPPLIER_SYNC_INTERVAL_MS) return;
  supplierSyncStartedAt = now;
  supplierSyncing = import("@/lib/providers-import.server")
    .then(({ syncAllProviders }) => syncAllProviders(false))
    .catch(() => undefined)
    .finally(() => {
      supplierSyncing = null;
    });
}

// On the always-on Railway server, also check suppliers every 2 minutes so
// API stock announcements go out even when nobody is using the bot.
const g = globalThis as { __supplierTimer?: unknown };
if (!g.__supplierTimer && typeof process !== "undefined" && process.env?.["RAILWAY_ENVIRONMENT"]) {
  g.__supplierTimer = setInterval(refreshSuppliersInBackground, 120_000);
}

// Warm the shared caches before the first customer interaction reaches this worker.
void Promise.all([
  loadBotRuntime().catch(() => undefined),
  loadBotPresentation().catch(() => undefined),
  import("@/lib/bot/core").then(({ allProducts }) => allProducts()).catch(() => undefined),
]);

async function processUpdate(update: any) {
  await loadBotPresentation().catch(() => undefined);

  // Banned accounts get one short notice and nothing else runs — no buying,
  // depositing, support, or browsing. The flag is set by admins from the
  // website (Users tab) or the block-reseller-account script.
  const guardChatId = Number(
    update?.callback_query?.message?.chat?.id ??
      update?.message?.chat?.id ??
      update?.edited_message?.chat?.id ??
      0,
  );
  if (guardChatId && (await isChatBlocked(guardChatId))) {
    if (update?.callback_query?.id) {
      await tg("answerCallbackQuery", {
        callback_query_id: update.callback_query.id,
        text: "Your account has been suspended.",
        show_alert: true,
      }).catch(() => undefined);
    } else {
      await tg("sendMessage", {
        chat_id: guardChatId,
        text: "🚫 Your account has been suspended. Please contact support if you believe this is a mistake.",
      }).catch(() => undefined);
    }
    return;
  }

  if (update?.business_connection) {
    const { handleBusinessConnection } = await import("@/lib/bot/business");
    await handleBusinessConnection(update.business_connection);
  } else if (update?.business_message || update?.edited_business_message) {
    const { handleBusinessMessage } = await import("@/lib/bot/business");
    await handleBusinessMessage(update.business_message ?? update.edited_business_message);
  } else if (update?.callback_query) {
    const cq = update.callback_query;
    void tg("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => undefined);
    const chatId = cq.message?.chat?.id;
    const messageId = cq.message?.message_id;
    if (chatId) {
      rememberName(Number(chatId), cq.from?.first_name || cq.from?.username);
      rememberUsername(Number(chatId), cq.from?.username);
      if (messageId) editTarget.set(Number(chatId), Number(messageId));
      try {
        await handleCallback(Number(chatId), String(cq.data || ""), String(cq.id || ""));
      } finally {
        editTarget.delete(Number(chatId));
      }
    }
  } else {
    const msg = update?.message ?? update?.edited_message;
    const chatId = msg?.chat?.id;
    if (chatId) {
      rememberName(Number(chatId), msg?.from?.first_name || msg?.from?.username);
      rememberUsername(Number(chatId), msg?.from?.username);
      await handleText(
        Number(chatId),
        String(msg.text ?? msg.caption ?? ""),
        msg.entities ?? msg.caption_entities,
        msg.sticker,
        msg.reply_to_message?.message_id,
        msg.from,
      );
    }
  }
  refreshSuppliersInBackground();
}

export const Route = createFileRoute("/api/public/telegram/webhook")({
  server: {
    handlers: {
      // Health view for the store owner: says whether this server can talk to
      // Telegram at all. It never shows any key, only yes/no.
      GET: async () =>
        Response.json({
          ok: true,
          hasBotToken: Boolean(process.env["TELEGRAM_BOT_TOKEN"]),
          hasConnectionKey: Boolean(
            process.env["TELEGRAM_API_KEY_1"] || process.env["TELEGRAM_API_KEY"],
          ),
          hasLovableKey: Boolean(process.env["LOVABLE_API_KEY"]),
        }),
      POST: async ({ request }) => {
        const actual = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
        const [update] = await Promise.all([
          request.json().catch(() => null),
          loadBotRuntime().catch(() => undefined),
        ]);
        if (!telegramWebhookOk(actual)) return new Response("Unauthorized", { status: 401 });

        // Telegram retries a webhook delivery when our reply is slow, and users
        // double-tap buttons; both can deliver the SAME update twice. Claim each
        // update_id atomically and ignore any redelivery, so no action (buy,
        // deposit, …) is ever processed more than once. Always answer ok:true so
        // Telegram stops retrying.
        const updateId = update?.update_id;
        if (typeof updateId === "number") {
          const fresh = await dbCreateIfAbsent(`tgUpdates/${updateId}`, {
            at: new Date().toISOString(),
          }).catch(() => true); // on storage error, fail open (process it)
          if (!fresh) return Response.json({ ok: true });
        }

        // Answer Telegram immediately so it sends the next update without waiting.
        // Work continues in the background, queued per chat to keep order.
        const key = String(
          update?.callback_query?.message?.chat?.id ??
            update?.message?.chat?.id ??
            update?.edited_message?.chat?.id ??
            "misc",
        );
        const prev = chatQueues.get(key) ?? Promise.resolve();
        const next = prev
          .then(() => processUpdate(update))
          .catch((err) => {
            console.error("telegram webhook error", err);
          });
        chatQueues.set(key, next);
        void next.finally(() => {
          if (chatQueues.get(key) === next) chatQueues.delete(key);
        });
        return Response.json({ ok: true });
      },
    },
  },
});
