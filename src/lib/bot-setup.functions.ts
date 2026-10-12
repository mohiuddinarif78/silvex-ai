import { createServerFn } from "@tanstack/react-start";

/**
 * Connect the Telegram bot with the token saved in the admin panel:
 * checks the token and registers this website's webhook with Telegram.
 */
export const connectTelegramBot = createServerFn({ method: "POST" })
  .inputValidator((input: { token?: string; siteUrl?: string }) => input ?? {})
  .handler(async ({ data }) => {
    const { requireStaff } = await import("./auth-guard.server");
    await requireStaff();
    const { applyBotConfig, loadBotRuntime, telegramWebhookSecret, siteUrl, tg } = await import(
      "./telegram.server"
    );
    await loadBotRuntime(true).catch(() => undefined);
    applyBotConfig({ botToken: data.token ?? "", siteUrl: data.siteUrl ?? "" });

    try {
      const me = await tg("getMe", {});
      const base = (data.siteUrl || siteUrl()).replace(/\/+$/, "");
      const url = `${base}/api/public/telegram/webhook`;
      await tg("setWebhook", {
        url,
        secret_token: telegramWebhookSecret(),
        allowed_updates: [
          "message",
          "edited_message",
          "callback_query",
          "my_chat_member",
          "business_connection",
          "business_message",
          "edited_business_message",
        ],
        drop_pending_updates: false,
      });
      const { registerBotCommands } = await import("./bot/commands");
      await registerBotCommands(true).catch(() => undefined);
      return {
        ok: true as const,
        username: String(me?.result?.username ?? ""),
        url,
      };
    } catch (err) {
      return { ok: false as const, error: (err as Error)?.message || "Could not connect the bot" };
    }
  });
