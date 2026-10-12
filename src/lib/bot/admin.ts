/** Owner panel inside the bot: stats, orders, requests, products, users. */
import { formatDescription } from "@/lib/format-desc";
import { isPermanentOwner } from "@/lib/owners";
import {
  dbGet,
  dbPatch,
  dbPush,
  dbPut,
  money,
  sendDeliveryFiles,
  siteUrl,
  tg,
} from "@/lib/telegram.server";
import {
  adminBack,
  allProducts,
  allUsers,
  cfg,
  invalidateUsers,
  say,
  setState,
  type Product,
} from "./core";

export async function adminHome(chatId: number) {
  const userMap = (await allUsers()) || {};
  const rows = Object.entries(userMap);
  const tgUsers = rows.filter(
    ([id, u]: [string, any]) => id.startsWith("tg_") || !!u?.telegramChatId,
  ).length;
  await say(
    chatId,
    `👑 <b>Owner panel</b>\n\nManage the whole store from here.\n\n👥 Total users: <b>${rows.length}</b>\n🌐 Website: ${rows.length - tgUsers} • 🤖 Telegram: ${tgUsers}`,
    {
    inline_keyboard: [
      [
        { text: "📊 Stats", callback_data: "a:stats" },
        { text: "🧾 Orders", callback_data: "a:orders" },
      ],
      [
        { text: "💰 Requests", callback_data: "a:req" },
        { text: "📦 Products", callback_data: "a:prod" },
      ],
      [
        { text: "👥 Users", callback_data: "a:users" },
      ],
      [
        { text: "📥 Full statement", callback_data: "a:stmt" },
        { text: "📣 Broadcast", callback_data: "a:bc" },
      ],
      [
        { text: "🔒 Force join", callback_data: "a:fj" },
        { text: "⭐ Review channel", callback_data: "a:rc" },
      ],
      [
        { text: "⚙️ Settings", callback_data: "a:set" },
        { text: "😍 Emojis", callback_data: "a:em" },
      ],
      [{ text: "🌐 Website admin", url: `${siteUrl()}/admin` }],
      ],
    },
  );
}

export async function adminStats(chatId: number) {
  const [orderMap, userMap, productMap] = await Promise.all([
    dbGet<Record<string, any>>("orders"),
    allUsers(),
    allProducts(),
  ]);
  const orders = Object.values(orderMap || {});
  const userRows = Object.entries(userMap || {});
  const users = userRows.length;
  const tgUsers = userRows.filter(
    ([id, u]: [string, any]) => id.startsWith("tg_") || !!u?.telegramChatId,
  ).length;
  const products = Object.values(productMap || {});
  const pending = orders.filter((o: any) => o.status === "Pending").length;
  const revenue = orders
    .filter((o: any) => o.status !== "Cancelled")
    .reduce((s: number, o: any) => s + Number(o.total || 0), 0);
  const weekAgo = Date.now() - 7 * 864e5;
  const week = orders
    .filter((o: any) => o.status !== "Cancelled" && new Date(o.date).getTime() > weekAgo)
    .reduce((s: number, o: any) => s + Number(o.total || 0), 0);
  const stock = products.reduce(
    (s: number, p: Product) => s + (Array.isArray(p.stock) ? p.stock.filter(Boolean).length : 0),
    0,
  );
  await say(
    chatId,
    `📊 <b>Stats</b>\n\nOrders: ${orders.length}\nPending: ${pending}\nRevenue: ${money(revenue)}\nThis week: ${money(week)}\nUsers: ${users} (website ${users - tgUsers} • telegram ${tgUsers})\nProducts: ${products.length}\nStock left: ${stock}`,
    adminBack,
  );
}

export async function adminOrders(chatId: number) {
  const all = (await dbGet<Record<string, any>>("orders")) || {};
  const pending = Object.values(all)
    .filter((o: any) => o.status === "Pending")
    .sort((a: any, b: any) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 10);
  if (!pending.length) return say(chatId, "No pending orders 🎉", adminBack);
  await say(chatId, "🧾 <b>Pending orders</b>\nTap one to deliver it.", {
    inline_keyboard: [
      ...pending.map((o: any) => [
        {
          text: `${o.orderId.slice(-6)} • ${money(o.total)} • ${(o.items || [])[0]?.title || ""}`.slice(0, 60),
          callback_data: `a:o:${o.orderId}`,
        },
      ]),
      [{ text: "⬅️ Back to Admin Panel", callback_data: "a:home" }],
    ],
  });
}

export async function adminOrder(chatId: number, orderId: string) {
  const o = await dbGet<any>(`orders/${orderId}`);
  if (!o) return say(chatId, "Order not found.", adminBack);
  const items = (o.items || []).map((i: any) => `• ${i.title} x${i.qty || 1}`).join("\n");
  await say(
    chatId,
    `🧾 <b>${o.orderId}</b>\n${items}\nBuyer: ${o.email || o.uid}\nTotal: ${money(o.total)}\nStatus: ${o.status}`,
    {
      inline_keyboard: [
        [{ text: "✅ Complete delivery", callback_data: `a:dl:${orderId}` }],
        [{ text: "❌ Cancel & refund", callback_data: `a:oc:${orderId}` }],
        [{ text: "⬅️ Back to Orders", callback_data: "a:orders" }],
      ],
    },
  );
}

export async function adminAskDelivery(chatId: number, orderId: string) {
  await setState(chatId, { k: "deliver", a: orderId });
  await say(
    chatId,
    "✍️ Send the delivery details for this order (the buyer will see exactly this text). One line per item.",
    { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "a:home" }]] },
  );
}

export async function adminDeliver(chatId: number, orderId: string, text: string) {
  const o = await dbGet<any>(`orders/${orderId}`);
  if (!o) return say(chatId, "Order not found.", adminBack);
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const items = o.items || [];
  const delivered = lines.map((content, idx) => ({
    title: items[idx]?.title || items[0]?.title || "Item",
    content,
  }));
  await dbPatch(`orders/${orderId}`, {
    delivered,
    status: "Completed",
    deliveredAt: new Date().toISOString(),
  });
  await setState(chatId, null);
  await say(chatId, `✅ Order ${orderId} delivered and the buyer was notified.`, adminBack);

  const buyerChat = o.telegramChatId || (o.uid ? await dbGet<number>(`users/${o.uid}/telegramChatId`) : null);
  if (buyerChat) {
    await say(
      Number(buyerChat),
      `✅ <b>Your order is delivered</b>\n\nOrder: <code>${orderId}</code>\n\n${delivered
        .map((d) => `${d.title}\n<code>${d.content}</code>`)
        .join("\n\n")}\n\n🌐 Website: ${siteUrl()}`,
      { inline_keyboard: [[{ text: "🌐 Visit website", url: siteUrl() }]] },
    ).catch(() => undefined);
    await sendDeliveryFiles(Number(buyerChat), orderId, delivered).catch(() => undefined);
  }
}

export async function adminCancelOrder(chatId: number, orderId: string) {
  const { adminCancelAndRefund } = await import("@/lib/wallet.server");
  const res = await adminCancelAndRefund(orderId);
  if (!res.ok) return say(chatId, "Order not found or already cancelled.", adminBack);
  if (res.uid) invalidateUsers();
  await say(chatId, `❌ Order ${orderId} cancelled and refunded.`, adminBack);
}

export async function adminRequests(chatId: number) {
  const all = (await dbGet<Record<string, any>>("requests")) || {};
  const pending = Object.entries(all)
    .filter(([, r]: [string, any]) => r.status === "Pending")
    .slice(0, 10);
  if (!pending.length) return say(chatId, "No pending wallet requests.", adminBack);
  await say(chatId, "💰 <b>Pending wallet requests</b>", {
    inline_keyboard: [
      ...pending.flatMap(([id, r]: [string, any]) => [
        [{ text: `${r.type} ${money(r.amount)} — ${r.email || r.uid}`.slice(0, 60), callback_data: "noop" }],
        [
          { text: "✅ Approve", callback_data: `a:ra:${id}` },
          { text: "❌ Reject", callback_data: `a:rr:${id}` },
        ],
      ]),
      [{ text: "⬅️ Back to Admin Panel", callback_data: "a:home" }],
    ],
  });
}

export async function adminDecideRequest(chatId: number, id: string, approve: boolean) {
  const { decideWalletRequest } = await import("@/lib/wallet.server");
  const res = await decideWalletRequest(id, approve);
  if (!res.ok) return say(chatId, res.error, adminBack);
  const r = res.request;
  if (approve) invalidateUsers();
  const buyerChat = await dbGet<number>(`users/${r.uid}/telegramChatId`);
  if (buyerChat)
    await say(
      Number(buyerChat),
      `${approve ? "✅" : "❌"} Your ${r.type.toLowerCase()} of ${money(r.amount)} was ${approve ? "approved" : "rejected"}.`,
    ).catch(() => undefined);
  await say(chatId, `Request ${approve ? "approved" : "rejected"}.`, adminBack);
}

export async function adminProducts(chatId: number) {
  const all = await allProducts();
  const list = Object.entries(all).slice(0, 30);
  const newBtn = [{ text: "➕ New product", callback_data: "a:pnew" }];
  if (!list.length)
    return say(chatId, "📦 No products yet. Add your first one.", {
      inline_keyboard: [newBtn, [{ text: "⬅️ Back to Admin Panel", callback_data: "a:home" }]],
    });
  await say(chatId, "📦 <b>Products</b>\nTap one to manage.", {
    inline_keyboard: [
      ...list.map(([id, p]) => [
        {
          text: `${p.title || "Item"} • ${money(p.price || 0)} • stock ${Array.isArray(p.stock) ? p.stock.filter(Boolean).length : 0}`.slice(0, 60),
          callback_data: `a:p:${id}`,
        },
      ]),
      newBtn,
      [{ text: "⬅️ Back to Admin Panel", callback_data: "a:home" }],
    ],
  });
}

export async function adminProduct(chatId: number, id: string) {
  const p = await dbGet<Product>(`products/${id}`);
  if (!p) return say(chatId, "Product not found.", adminBack);
  const stock = Array.isArray(p.stock) ? p.stock.filter(Boolean).length : 0;
  await say(
    chatId,
    `📦 <b>${p.title}</b>\n${p.desc ? `${formatDescription(p.desc)}\n` : ""}Price: ${money(p.price || 0)}\nDelivery: ${p.delivery || "manual"}\nStock: ${stock}\nSales: ${p.salesCount || 0}`,
    {
      inline_keyboard: [
        [
          { text: "💵 Change price", callback_data: `a:pp:${id}` },
          { text: "➕ Add stock", callback_data: `a:ps:${id}` },
        ],
        [
          { text: "✏️ Title", callback_data: `a:pt:${id}` },
          { text: "📝 Description", callback_data: `a:pdsc:${id}` },
        ],
        [
          { text: "⚡ Auto", callback_data: `a:pd:${id}:auto` },
          { text: "🔁 Repeat", callback_data: `a:pd:${id}:repeat` },
          { text: "🕐 Manual", callback_data: `a:pd:${id}:manual` },
        ],
        [
          { text: "🧹 Clear stock", callback_data: `a:psc:${id}` },
          { text: "🗑 Delete", callback_data: `a:pdel:${id}` },
        ],
        [{ text: "⬅️ Back to Products", callback_data: "a:prod" }],
      ],
    },
  );
}

export async function adminUsers(chatId: number) {
  await setState(chatId, { k: "u_find" });
  await say(chatId, "👥 Send an email (or part of it) to find a user.", {
    inline_keyboard: [[{ text: "❌ Cancel", callback_data: "a:home" }]],
  });
}

export async function adminFindUser(chatId: number, q: string) {
  const users = await allUsers();
  const hits = Object.entries(users)
    .filter(([, u]: [string, any]) => String(u?.email || "").toLowerCase().includes(q.toLowerCase()))
    .slice(0, 8);
  await setState(chatId, null);
  if (!hits.length) return say(chatId, "No user found.", adminBack);
  await say(chatId, "👥 <b>Results</b>", {
    inline_keyboard: [
      ...hits.map(([uid, u]: [string, any]) => [
        { text: `${u.email} • ${money(u.wallet || 0)}`.slice(0, 60), callback_data: `a:u:${uid}` },
      ]),
      [{ text: "⬅️ Back to Admin Panel", callback_data: "a:home" }],
    ],
  });
}

export async function adminUser(chatId: number, uid: string) {
  const u = (await dbGet<any>(`users/${uid}`)) || {};
  const permanent = isPermanentOwner(u.email);
  const adminRow = permanent
    ? [{ text: "👑 Permanent owner", callback_data: "noop" }]
    : u.isAdmin
      ? [{ text: "🚫 Remove admin", callback_data: `a:ua:${uid}` }]
      : null;
  await say(
    chatId,
    `👤 <b>${u.email || uid}</b>\nName: ${u.name || "-"}\nWallet: ${money(u.wallet || 0)}\nAdmin: ${u.isAdmin || permanent ? "yes" : "no"}`,
    {
      inline_keyboard: [
        [{ text: "💵 Set wallet balance", callback_data: `a:uw:${uid}` }],
        ...(adminRow ? [adminRow] : []),
        [{ text: "📥 User statement", callback_data: `a:ust:${uid}` }],
        [{ text: "⬅️ Back to Admin Panel", callback_data: "a:home" }],
      ],
    },
  );
}

export async function adminSettings(chatId: number) {
  const c = await cfg();
  await say(
    chatId,
    `⚙️ <b>Settings</b>\n\nSite name: ${c.siteName || "-"}\nSupport: ${c.supportLink || "-"}\nDeposit address: <code>${c.depositAddress || "-"}</code>\nMaintenance mode: ${c.maintenanceMode ? "🛠 ON (users paused)" : "off"}`,
    {
      inline_keyboard: [
        [{ text: "✏️ Site name", callback_data: "a:s:siteName" }],
        [{ text: "✏️ Support link", callback_data: "a:s:supportLink" }],
        [{ text: "✏️ Deposit address", callback_data: "a:s:depositAddress" }],
        [
          {
            text: c.maintenanceMode ? "✅ Turn maintenance off" : "🛠 Turn maintenance on",
            callback_data: "a:maint",
          },
        ],
        [{ text: "⬅️ Back to Admin Panel", callback_data: "a:home" }],
      ],
    },
  );
}

/** Step 1 of /broadcast: pick a product (10 per page) or send plain custom text. */
export async function broadcastMenu(chatId: number, page = 0) {
  await setState(chatId, null);
  const list = Object.entries(await allProducts()).filter(([, p]) => p?.title && !p.hidden);
  const per = 10;
  const pages = Math.max(1, Math.ceil(list.length / per));
  const pg = Math.min(Math.max(0, page), pages - 1);
  const slice = list.slice(pg * per, pg * per + per);
  const nav: any[] = [];
  if (pg > 0) nav.push({ text: "Previous Page", callback_data: `a:bcpg:${pg - 1}` });
  if (pg < pages - 1) nav.push({ text: "Next Page", callback_data: `a:bcpg:${pg + 1}` });
  await say(chatId, `📣 <b>Broadcast</b>\n\nPick a product to announce, or send custom text only.\nPage ${pg + 1}/${pages}`, {
    inline_keyboard: [
      [{ text: "✍️ Custom text only", callback_data: "a:bcc" }],
      ...slice.map(([id, p]) => [{ text: String(p.title).slice(0, 60), callback_data: `a:bcp:${id}` }]),
      ...(nav.length ? [nav] : []),
      [{ text: "⬅️ Back to Admin Panel", callback_data: "a:home" }],
    ],
  });
}

/** Step 2: template buttons for the chosen product. */
export async function broadcastTemplates(chatId: number, id: string) {
  const p = await dbGet<Product>(`products/${id}`);
  if (!p) return say(chatId, "Product not found.", adminBack);
  await say(chatId, `📣 <b>${p.title}</b>\n\nChoose a message template:`, {
    inline_keyboard: [
      [
        { text: "📦 New stock", callback_data: `a:bct:restock:${id}` },
        { text: "⚠️ Low stock", callback_data: `a:bct:low:${id}` },
      ],
      [
        { text: "🆕 New product", callback_data: `a:bct:new:${id}` },
        { text: "✍️ Custom text", callback_data: `a:bct:custom:${id}` },
      ],
      [{ text: "⬅️ Back to Products", callback_data: "a:bc" }],
    ],
  });
}

export async function broadcastTemplate(chatId: number, kind: string, id: string) {
  if (kind === "custom") {
    await setState(chatId, { k: "bc", a: id });
    return say(chatId, "✍️ Send the custom text. A Buy button for this product will be added below it.", {
      inline_keyboard: [[{ text: "❌ Cancel", callback_data: "a:bc" }]],
    });
  }
  await say(chatId, "📣 Starting broadcast… live progress will appear below.", adminBack);
  void import("@/lib/broadcast.server")
    .then(({ announce }) => announce(kind as any, id, {}, chatId))
    .then((r) => (r.ok ? undefined : say(chatId, `⚠️ Not sent: ${r.error}`, adminBack)))
    .catch(() => undefined);
}

export async function broadcast(chatId: number, text: string, productId?: string) {
  await setState(chatId, null);
  await say(chatId, "📣 Starting broadcast… live progress will appear below.", adminBack);
  const markup = productId
    ? {
        inline_keyboard: [
          [{ text: "🛒 Buy now", callback_data: `p:${productId}` }],
          [{ text: "🏬 Browse shop", callback_data: "products" }],
        ],
      }
    : undefined;
  void import("@/lib/broadcast-runner.server")
    .then(({ runBroadcast }) =>
      runBroadcast({
        label: "Custom message",
        adminChatId: chatId,
        send: async (id, extra) => {
          await tg("sendMessage", { chat_id: id, text, parse_mode: "HTML", ...extra, ...(markup ? { reply_markup: markup } : {}) });
        },
      }),
    )
    .catch(() => undefined);
  void import("@/lib/push.server")
    .then(({ pushEveryone }) => pushEveryone({ title: "📣 Silvex AI", body: text }))
    .catch(() => undefined);
}
