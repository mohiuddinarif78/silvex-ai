import { createFileRoute } from "@tanstack/react-router";
import { dbGet, dbPatch, dbPush, dbPut, dbTransact, dbCreateIfAbsent, siteUrl, loadBotRuntime } from "@/lib/telegram.server";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-api-key, authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

async function resolveKey(request: Request): Promise<{ uid: string; user: any } | null> {
  const header = request.headers.get("x-api-key") || request.headers.get("authorization") || "";
  const key = header.replace(/^Bearer\s+/i, "").trim();
  if (!key) return null;
  const uid = await dbGet<string>(`apiKeys/${key}`);
  if (!uid) return null;
  const user = (await dbGet<any>(`users/${uid}`)) || {};
  if (user.apiEnabled === false || user.blocked) return null;
  return { uid, user };
}

function unitPrice(p: any) {
  const a = Number(p?.apiPrice);
  return a > 0 ? a : Number(p?.price || 0);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Safe key for a DB path segment (idempotency keys may contain odd chars). */
const encodeKey = (k: string) => k.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);

function publicProduct(id: string, p: any) {
  const stock = Array.isArray(p.stock) ? p.stock.filter(Boolean).length : 0;
  return {
    id,
    title: p.title || "",
    price: unitPrice(p),
    category: p.category || "",
    delivery: p.delivery || "manual",
    inStock: p.soldOut ? false : p.delivery === "manual" || p.delivery === "repeat" ? true : stock > 0,
    stock,
    description: p.desc || "",
  };
}

async function handle(request: Request, splat: string): Promise<Response> {
  const path = (splat || "").replace(/^\/+|\/+$/g, "");
  await loadBotRuntime().catch(() => undefined);
  const account = await resolveKey(request);
  if (!account) return json({ ok: false, error: "Invalid or missing API key" }, 401);
  const { uid, user } = account;

  if (path === "me") {
    return json({
      ok: true,
      email: user.email || null,
      name: user.name || null,
      balance: Number(user.wallet || 0),
      currency: "USD",
      website: siteUrl(),
    });
  }

  if (path === "balance") {
    return json({ ok: true, balance: Number(user.wallet || 0), currency: "USD" });
  }

  if (path === "products") {
    const all = (await dbGet<Record<string, any>>("products")) || {};
    return json({
      ok: true,
      products: Object.entries(all)
        .filter(([, p]) => p && p.hidden !== true)
        .map(([id, p]) => publicProduct(id, p)),
    });
  }

  if (path.startsWith("orders/")) {
    const orderId = path.slice("orders/".length);
    const order = await dbGet<any>(`orders/${orderId}`);
    if (!order || order.uid !== uid) return json({ ok: false, error: "Order not found" }, 404);
    return json({
      ok: true,
      order: {
        orderId,
        status: order.status,
        total: Number(order.total || 0),
        delivered: order.delivered || [],
        note: order.deliveryNote || null,
        date: order.date,
      },
    });
  }

  if (path === "orders" && request.method === "GET") {
    const all = (await dbGet<Record<string, any>>("orders")) || {};
    return json({
      ok: true,
      orders: Object.entries(all)
        .filter(([, o]) => o?.uid === uid)
        .map(([id, o]) => ({
          orderId: id,
          status: o.status,
          total: Number(o.total || 0),
          date: o.date,
          delivered: o.delivered || [],
        })),
    });
  }

  if (path === "order" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as any;
    const productId = String(body?.productId || "").trim();
    const qty = Math.max(1, Math.min(20, Number(body?.qty || 1)));
    if (!productId) return json({ ok: false, error: "productId is required" }, 400);

    const p = await dbGet<any>(`products/${productId}`);
    if (!p) return json({ ok: false, error: "Product not found" }, 404);
    if (p.soldOut) return json({ ok: false, error: "Product is out of stock" }, 409);

    const price = round2(unitPrice(p) * qty);

    // Idempotency: a client may send a stable key to make retries safe. We claim
    // it once; a duplicate is rejected instead of charging again.
    const idemKey = String(body?.idempotencyKey || body?.orderId || "").trim().slice(0, 80);
    const orderId = "API" + Date.now();
    if (idemKey) {
      const claimed = await dbCreateIfAbsent(`apiIdempotency/${encodeKey(idemKey)}`, {
        orderId,
        uid,
        date: new Date().toISOString(),
      });
      if (!claimed) {
        return json(
          { ok: false, error: "Duplicate request (idempotencyKey already used)" },
          409,
        );
      }
    }

    // Take the money FIRST, atomically. The guard runs inside the transaction so
    // concurrent requests cannot both pass an insufficient-funds check and
    // overspend (fixes the previous read-check-write race).
    const paid = await dbTransact<number>(`users/${uid}/wallet`, (w) => {
      const cur = Number(w) || 0;
      if (cur < price) return undefined; // abort: not enough balance
      return round2(cur - price);
    });
    if (paid === undefined) {
      // Release the idempotency claim so the caller can retry after topping up.
      if (idemKey) await dbPut(`apiIdempotency/${encodeKey(idemKey)}`, null).catch(() => undefined);
      return json(
        { ok: false, error: "Insufficient balance", balance: Number(user.wallet || 0), required: price },
        402,
      );
    }

    const delivered: { title: string; content: string }[] = [];
    let complete = false;
    try {
      if (p.delivery === "supplier") {
        const { supplierBuy } = await import("@/lib/supplier.server");
        const items = await supplierBuy(
          p.supplierId ?? "",
          qty,
          `api-${uid}-${Date.now()}`,
          String(p.provider || "custom"),
        );
        for (const content of items) {
          await dbPush(`usedStock/${productId}`, {
            content,
            orderId,
            email: user.email || `api:${uid}`,
            date: new Date().toISOString(),
          });
          delivered.push({ title: p.title || "Item", content });
        }
        complete = delivered.length >= qty;
      } else if (p.delivery === "repeat" && p.link) {
        for (let i = 0; i < qty; i++) delivered.push({ title: p.title || "Item", content: p.link });
        complete = true;
      } else if (p.delivery === "auto") {
        // Atomically claim stock so two orders can never take the same items.
        let taken: string[] = [];
        await dbTransact<string[]>(`products/${productId}/stock`, (cur) => {
          const list = Array.isArray(cur) ? cur.filter(Boolean) : [];
          if (list.length < qty) return undefined; // abort: not enough stock
          taken = list.slice(0, qty);
          return list.slice(qty);
        });
        if (taken.length === qty) {
          for (const content of taken) {
            await dbPush(`usedStock/${productId}`, {
              content,
              orderId,
              email: user.email || `api:${uid}`,
              date: new Date().toISOString(),
            });
            delivered.push({ title: p.title || "Item", content });
          }
          complete = true;
        }
      }
    } catch {
      complete = false;
    }

    // If nothing was delivered, refund the full charge atomically and stop.
    if (!delivered.length) {
      await dbTransact<number>(`users/${uid}/wallet`, (w) => round2((Number(w) || 0) + price));
      if (idemKey) await dbPut(`apiIdempotency/${encodeKey(idemKey)}`, null).catch(() => undefined);
      return json(
        { ok: false, error: "Delivery failed, you were not charged", refunded: price },
        502,
      );
    }

    const balance = paid; // balance after the atomic debit, for the messages below
    await dbPut(`orders/${orderId}`, {
      orderId,
      uid,
      email: user.email || "",
      items: [{ ...p, id: productId, qty, price: unitPrice(p) }],
      subTotal: price,
      couponDiscount: 0,
      total: price,
      note: "Placed through reseller API",
      source: "api",
      delivered,
      status: complete ? "Completed" : "Pending",
      date: new Date().toISOString(),
    });
    await dbPush(`users/${uid}/history`, {
      type: "Purchase",
      amount: price,
      desc: `API order ${orderId.slice(-4)}`,
      date: new Date().toISOString(),
    });
    await dbPatch(`products/${productId}`, { salesCount: Number(p.salesCount || 0) + qty });

    // Tell the key owner about the order on their own account (bell + Telegram),
    // and let the shop owners know too.
    const title = String(p.title || "Item");
    const alert =
      `API order ${orderId} • ${title} ×${qty} • $${price.toFixed(2)} • ` +
      (complete ? "Delivered" : "Pending");
    await dbPush(`users/${uid}/alerts`, {
      msg: alert,
      date: new Date().toISOString(),
      orderId,
      source: "api",
    }).catch(() => undefined);

    const chatId = Number(user.telegramChatId || 0);
    if (chatId) {
      const { tg } = await import("@/lib/telegram.server");
      await tg("sendMessage", {
        chat_id: chatId,
        text:
          `🔑 <b>New API order</b>\n` +
          `${title} ×${qty}\n` +
          `Charged: $${price.toFixed(2)}\n` +
          `Balance: $${balance.toFixed(2)}\n` +
          `Status: ${complete ? "Delivered ✅" : "Pending ⏳"}\n` +
          `Order: <code>${orderId}</code>`,
        parse_mode: "HTML",
      }).catch(() => undefined);
    }

    const { notifyOwners } = await import("@/lib/telegram.server");
    await notifyOwners(
      `🔑 API order <code>${orderId}</code>\n${title} ×${qty} — $${price.toFixed(2)}\n` +
        `Buyer: ${user.email || uid}\nStatus: ${complete ? "Delivered" : "Pending"}`,
    ).catch(() => undefined);

    return json({
      ok: true,
      orderId,
      status: complete ? "Completed" : "Pending",
      charged: price,
      balance: balance,
      delivered,
    });
  }

  return json({ ok: false, error: "Unknown endpoint" }, 404);
}

export const Route = createFileRoute("/api/public/reseller/$")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: cors }),
      GET: async ({ request, params }) => handle(request, String((params as any)._splat || "")),
      POST: async ({ request, params }) => handle(request, String((params as any)._splat || "")),
    },
  },
});
