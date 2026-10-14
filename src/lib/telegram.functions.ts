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
    if (!who.staff) {
      const rl = await import("./rate-limit.server");
      rl.limitBy("notify-order", who.uid, 10, rl.MINUTE);
      data = { ...data, uid: who.uid };
    }
    try {
      const { dbGet, money, notifyOwners, tg, siteUrl, loadBotRuntime } = await import("./telegram.server");
      await loadBotRuntime();

      // The notification must describe a REAL order. Load it from the database
      // and send using the stored values — never the caller's numbers. This
      // stops empty/$0 "ghost" orders and amount spoofing: a logged-in user (or
      // a frontend misfire) can no longer post a fabricated order notice.
      const orderId = String(data.orderId || "").trim();
      if (!orderId) return { ok: false as const, error: "missing order id" };
      const order = await dbGet<any>(`orders/${orderId}`);
      if (!order) return { ok: false as const, error: "unknown order" };

      // Customers may only notify about their own order; staff may notify any.
      if (!who.staff && String(order.uid || "") !== who.uid) {
        return { ok: false as const, error: "not your order" };
      }

      // Authoritative values from the stored order.
      const buyerUid = String(order.uid || data.uid || "");
      const email = String(order.email || "");
      const total = Number(order.total || 0);
      const status = String(order.status || "Pending");
      const items = Array.isArray(order.items)
        ? order.items.slice(0, 30).map((i: any) => ({ title: String(i.title || ""), qty: Number(i.qty || 1) }))
        : [];
      const lines = items.map((i: { title: string; qty: number }) => `• ${i.title}\n   🔢 Quantity: ${i.qty}`).join("\n");

      await notifyOwners(
        `🛒 <b>New website order</b>\n${lines}\nBuyer: ${email || "-"}\nTotal: ${money(total)}\nOrder: ${orderId}\nStatus: ${status}`,
      );
      if (buyerUid) {
        const { pushUser } = await import("./push.server");
        void pushUser(buyerUid, {
          title: `🧾 Order ${status}`,
          body: `${items.map((i: { title: string; qty: number }) => `${i.title} x${i.qty}`).join(", ")} — ${money(total)}`,
          url: "/orders",
        });
        const chatId = await dbGet<number>(`users/${buyerUid}/telegramChatId`);
        if (chatId) {
          // Delivered content comes from the stored order (admin delivery writes
          // it there); fall back to the caller's only when staff supplied it.
          const deliveredList = Array.isArray(order.delivered) && order.delivered.length
            ? order.delivered
            : who.staff && Array.isArray(data.delivered)
              ? data.delivered
              : [];
          const delivered = deliveredList.length
            ? `\n\n${deliveredList.map((d: any) => `${String(d.title || "")}\n<code>${String(d.content || "")}</code>`).join("\n\n")}`
            : "";
          await tg("sendMessage", {
            chat_id: chatId,
            text: `🧾 <b>Order ${orderId}</b>\n${lines}\nTotal: ${money(total)}\nStatus: ${status}${delivered}\n\n🌐 Website: ${siteUrl()}`,
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
