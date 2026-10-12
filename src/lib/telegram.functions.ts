import { createServerFn } from "@tanstack/react-start";

type OrderNotice = {
  orderId: string;
  email?: string | undefined;
  total: number;
  status: string;
  items: { title: string; qty: number }[];
  delivered?: { title: string; content: string }[] | undefined;
  uid?: string | undefined;
};

function validate(input: OrderNotice): OrderNotice {
  return {
    orderId: String(input?.orderId || ""),
    email: input?.email ? String(input.email) : undefined,
    total: Number(input?.total || 0),
    status: String(input?.status || "Pending"),
    items: Array.isArray(input?.items)
      ? input.items.slice(0, 30).map((i) => ({ title: String(i.title || ""), qty: Number(i.qty || 1) }))
      : [],
    delivered: Array.isArray(input?.delivered)
      ? input.delivered.map((d) => ({ title: String(d.title || ""), content: String(d.content || "") }))
      : undefined,
    uid: input?.uid ? String(input.uid) : undefined,
  };
}

/** Sends the order to the Telegram owners, and to the buyer when their account is linked. */
export const notifyTelegramOrder = createServerFn({ method: "POST" })
  .inputValidator(validate)
  .handler(async ({ data }) => {
    // Signed-in only. Customers may only message their own linked chat; staff
    // (admin delivery) may notify the buyer of any order.
    const { requireCaller } = await import("./auth-guard.server");
    const who = await requireCaller();
    if (!who.staff) data = { ...data, uid: who.uid };
    try {
      const { dbGet, money, notifyOwners, tg, siteUrl, loadBotRuntime } = await import("./telegram.server");
      await loadBotRuntime();
      const lines = data.items.map((i) => `• ${i.title}\n   🔢 Quantity: ${i.qty}`).join("\n");
      await notifyOwners(
        `🛒 <b>New website order</b>\n${lines}\nBuyer: ${data.email || "-"}\nTotal: ${money(data.total)}\nOrder: ${data.orderId}\nStatus: ${data.status}`,
      );
      if (data.uid) {
        const { pushUser } = await import("./push.server");
        void pushUser(data.uid, {
          title: `🧾 Order ${data.status}`,
          body: `${data.items.map((i) => `${i.title} x${i.qty}`).join(", ")} — ${money(data.total)}`,
          url: "/orders",
        });
        const chatId = await dbGet<number>(`users/${data.uid}/telegramChatId`);
        if (chatId) {
          const delivered = data.delivered?.length
            ? `\n\n${data.delivered.map((d) => `${d.title}\n<code>${d.content}</code>`).join("\n\n")}`
            : "";
          await tg("sendMessage", {
            chat_id: chatId,
            text: `🧾 <b>Order ${data.orderId}</b>\n${lines}\nTotal: ${money(data.total)}\nStatus: ${data.status}${delivered}\n\n🌐 Website: ${siteUrl()}`,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "🌐 Visit website", url: siteUrl() }]] },
          }).catch(() => undefined);
        }
      }
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "notify failed" };
    }
  });
