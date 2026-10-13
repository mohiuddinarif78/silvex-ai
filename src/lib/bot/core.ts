/** Shared pieces of the Telegram bot: settings, state, sending, users. */
import {
  dbGet,
  dbPatch,
  dbPut,
  dbUidByChatId,
  tg,
  ownerIds,
  applyBotConfig,
} from "@/lib/telegram.server";
import { be, e as em, loadEmojis, setButtonColors, setButtonNames, setProductButtons } from "@/lib/emoji.server";
import { applyReferralConfig } from "@/lib/referral";
import type { ButtonColorMap, ButtonNameMap, ProductButtonMap } from "@/lib/button-colors";

export type Product = {
  id?: string;
  title?: string;
  desc?: string;
  price?: number;
  logo?: string;
  link?: string;
  delivery?: "auto" | "repeat" | "manual" | "supplier";
  supplierId?: string | number;
  supplierStock?: number;
  provider?: string;
  hidden?: boolean;
  locked?: boolean;
  stock?: string[];
  salesCount?: number;
};

export type Cfg = {
  siteName?: string;
  supportLink?: string;
  supportTelegram?: string;
  depositAddress?: string;
  forceJoin?: string;
  reviewChannel?: string;
  razorpayKeyId?: string;
  inrPerDollar?: number | string;
  telegramOwners?: string | number[];
  notifyGroup?: string | number;
  messageEffect?: string;
  maintenanceMode?: boolean;
  maintenanceText?: string;
};

export const CFG = "site_settings/config";
export const BOT_CACHE_MS = 30_000;
const LIST_CACHE_MS = 15_000;

let cachedCfg: Cfg | null = null;
let cfgLoadedAt = 0;
let cfgRefreshing: Promise<void> | null = null;
let cachedButtonColors: ButtonColorMap | null = null;
let cachedButtonNames: ButtonNameMap | null = null;
let cachedProductButtons: ProductButtonMap | null = null;
let colorsLoadedAt = 0;
let colorsRefreshing: Promise<void> | null = null;

function refreshCfg(): Promise<void> {
  cfgRefreshing ||= dbGet<Cfg>(CFG)
    .then((c) => {
      cachedCfg = c || {};
      cfgLoadedAt = Date.now();
      applyBotConfig(cachedCfg as any);
      applyReferralConfig(cachedCfg as any);
    })
    .catch(() => undefined)
    .finally(() => {
      cfgRefreshing = null;
    });
  return cfgRefreshing;
}

/** Settings are served from memory and refreshed in the background (never blocks a tap). */
export async function cfg(): Promise<Cfg> {
  if (cachedCfg) {
    if (Date.now() - cfgLoadedAt >= BOT_CACHE_MS) void refreshCfg();
    return cachedCfg;
  }
  await refreshCfg();
  return cachedCfg || {};
}

export async function saveConfig(patch: Record<string, unknown>) {
  await dbPatch(CFG, patch);
  cachedCfg = null;
  cfgLoadedAt = 0;
}

/**
 * Maintenance mode: when on, only bot admins can use the bot; everyone else
 * gets a short "back soon" note. Returns true when the message was handled.
 */
export async function maintenanceGate(chatId: number): Promise<boolean> {
  const c = await cfg();
  if (!c.maintenanceMode) return false;
  if (await isBotAdmin(chatId)) return false;
  const text =
    c.maintenanceText ||
    "🛠 We are doing a quick maintenance. The shop will be back very soon — please try again in a little while.";
  await say(chatId, text).catch(() => undefined);
  return true;
}

export async function siteName(): Promise<string> {
  return (await cfg()).siteName || "Silvex AI";
}

function refreshButtons(): Promise<void> {
  colorsRefreshing ||= Promise.all([
    dbGet<ButtonColorMap>("site_settings/button_colors"),
    dbGet<ButtonNameMap>("site_settings/button_names"),
    dbGet<ProductButtonMap>("site_settings/product_buttons"),
  ])
    .then(([colors, names, products]) => {
      cachedButtonColors = colors || {};
      cachedButtonNames = names || {};
      cachedProductButtons = products || {};
      colorsLoadedAt = Date.now();
    })
    .catch(() => undefined)
    .finally(() => {
      colorsRefreshing = null;
    });
  return colorsRefreshing;
}

let emojisLoadedAt = 0;
export async function loadBotPresentation(): Promise<void> {
  if (cachedButtonColors && cachedButtonNames && cachedProductButtons && emojisLoadedAt) {
    // Serve from memory; refresh in the background so taps never wait on the database.
    if (Date.now() - colorsLoadedAt >= BOT_CACHE_MS) void refreshButtons();
    if (Date.now() - emojisLoadedAt >= 5_000) {
      emojisLoadedAt = Date.now();
      void loadEmojis(true).catch(() => undefined);
    }
  } else {
    await Promise.all([loadEmojis(true).catch(() => undefined), refreshButtons()]);
    emojisLoadedAt = Date.now();
  }
  setButtonColors(cachedButtonColors);
  setButtonNames(cachedButtonNames);
  setProductButtons(cachedProductButtons);
}

/* ---------------- shared lists (short cache keeps taps fast) ---------------- */

type ProductCache = { at: number; v: Record<string, Product> } | null;
type UserCache = { at: number; v: Record<string, any> } | null;
let productCache: ProductCache = null;
let userCache: UserCache = null;

let productLoading: Promise<void> | null = null;
let userLoading: Promise<void> | null = null;

function pullProducts(): Promise<void> {
  productLoading ||= Promise.all([
    dbGet<Record<string, Product>>("products"),
    dbGet<{ pid?: string; price?: number; endTime?: number }>("site_settings/flash_sale").catch(() => null),
  ])
    .then(([v, fs]) => {
      const flashOn = !!fs?.pid && Number(fs.endTime) > Date.now() && Number(fs.price) > 0;
      const out: Record<string, Product> = {};
      for (const [id, raw] of Object.entries(v || {})) {
        const p = raw as any;
        if (!p) continue;
        // Skip "ghost" rows left behind by a delete that raced a supplier sync
        // (price/stock but no title) — they must never appear as "Item" buttons
        // anywhere in the bot. Real products always have a title.
        if (String(p.title || "").trim() === "") continue;
        const bp = Number(p.botPrice);
        const base = bp > 0 ? bp : p.price;
        out[id] = { ...p, price: flashOn && fs!.pid === id ? Number(fs!.price) : base, hidden: p.hidden === true || p.hideBot === true };
      }
      productCache = { at: Date.now(), v: out };
    })
    .catch(() => undefined)
    .finally(() => {
      productLoading = null;
    });
  return productLoading;
}

export async function allProducts(): Promise<Record<string, Product>> {
  if (productCache) {
    if (Date.now() - productCache.at >= LIST_CACHE_MS) void pullProducts();
    return productCache.v;
  }
  await pullProducts();
  const loaded = productCache as ProductCache;
  return loaded?.v || {};
}

/** Fast product lookup for browsing screens; the short-lived catalogue cache
 * keeps consecutive taps from making the same database request repeatedly. */
export async function productById(id: string): Promise<Product | null> {
  const products = await allProducts();
  return products[id] || null;
}
export function invalidateProducts() {
  // Keep serving the current list while a fresh copy loads in the background,
  // so no customer tap has to wait for the database.
  if (productCache) {
    productCache.at = 0;
    void pullProducts();
  }
}

function pullUsers(): Promise<void> {
  userLoading ||= dbGet<Record<string, any>>("users")
    .then((v) => {
      userCache = { at: Date.now(), v: v || {} };
    })
    .catch(() => undefined)
    .finally(() => {
      userLoading = null;
    });
  return userLoading;
}

export async function allUsers(): Promise<Record<string, any>> {
  if (userCache) {
    if (Date.now() - userCache.at >= LIST_CACHE_MS) void pullUsers();
    return userCache.v;
  }
  await pullUsers();
  const loaded = userCache as UserCache;
  return loaded?.v || {};
}
export function invalidateUsers() {
  userCache = null;
}

/* ---------------- state ---------------- */

export type State = { k: string; a?: string; b?: string } | null;

/** The bot's own memory of what each chat is doing — saves a database read per tap. */
const stateCache = new Map<number, State>();

export async function getState(chatId: number): Promise<State> {
  if (stateCache.has(chatId)) return stateCache.get(chatId) ?? null;
  const raw = await dbGet<any>(`telegramState/${chatId}`);
  const v: State = !raw ? null : typeof raw === "string" ? { k: raw } : (raw as State);
  stateCache.set(chatId, v);
  return v;
}
export async function setState(chatId: number, s: State) {
  stateCache.set(chatId, s);
  // Webhook requests can land on different server instances. Persist the step
  // before replying so the next message never loses an emoji/setup selection.
  try {
    await dbPut(`telegramState/${chatId}`, s);
  } catch (error) {
    stateCache.delete(chatId);
    throw error;
  }
}

/** Remember who is an admin for a short while so every tap isn't a fresh lookup. */
const adminCache = new Map<number, { v: boolean; at: number }>();

export async function isBotAdmin(chatId: number): Promise<boolean> {
  if (ownerIds().includes(chatId)) return true;
  const hit = adminCache.get(chatId);
  if (hit && Date.now() - hit.at < BOT_CACHE_MS) return hit.v;
  if (await dbGet<boolean>(`telegramAdmins/${chatId}`)) {
    adminCache.set(chatId, { v: true, at: Date.now() });
    return true;
  }
  adminCache.set(chatId, { v: false, at: Date.now() });
  // Owners come only from Settings → Telegram owner IDs or TELEGRAM_OWNER_IDS.
  // (The old "first person who opens the bot becomes owner" rule was removed:
  // a stranger could message a fresh bot first and take admin.)
  return false;
}

/* ---------------- sending ---------------- */

/** Message ids we should edit instead of sending a new message (per chat). */
export const editTarget = new Map<number, number>();

/** Telegram's animated message effects (private chats only). */
export const EFFECTS: Record<string, string> = {
  fire: "5104841245755180586",
  like: "5107584321108051014",
  heart: "5159385139981059251",
  party: "5046509860389126442",
};

const EFFECT_IDS = Object.values(EFFECTS);
let lastEffect = "";

/** A different effect each time (unless the admin pinned one). */
function randomEffect(): string {
  const pool = EFFECT_IDS.filter((id) => id !== lastEffect);
  const pick = pool[Math.floor(Math.random() * pool.length)] || EFFECT_IDS[0] || "";
  lastEffect = pick;
  return pick;
}

/** Which effect to play on new bot messages — random by default, admin can pin one. */
export async function effectId(): Promise<string> {
  const c = await cfg();
  const raw = String(c.messageEffect ?? "random").trim().toLowerCase();
  if (!raw || raw === "none" || raw === "off") return "";
  if (raw === "random" || raw === "mix" || raw === "auto") return randomEffect();
  return EFFECTS[raw] || (/^\d{6,}$/.test(raw) ? raw : randomEffect());
}

export async function say(chatId: number, text: string, keyboard?: any) {
  const messageId = editTarget.get(chatId);
  if (messageId) {
    editTarget.delete(chatId);
    try {
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: keyboard ?? { inline_keyboard: [] },
      });
      return;
    } catch {
      /* message too old / identical — fall back to a new message */
    }
  }
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: keyboard } : {}),
  };
  const effect = await effectId().catch(() => "");
  if (effect) {
    try {
      await tg("sendMessage", { ...body, message_effect_id: effect });
      return;
    } catch {
      /* group chat or effect refused — send it plain */
    }
  }
  await tg("sendMessage", body);
}

export const backHome = { inline_keyboard: [[{ text: "⬅️ Back to Shop", callback_data: "home" }]] };
export const adminBack = { inline_keyboard: [[{ text: "⬅️ Back to Admin Panel", callback_data: "a:home" }]] };

/* ---------------- force join ---------------- */

export function channelLink(handle: string) {
  const h = handle.trim();
  if (h.startsWith("http")) return h;
  return `https://t.me/${h.replace(/^@/, "")}`;
}

/** Accepts "@name", "name" or a full https://t.me/name link. */
export function channelHandle(raw: string): string {
  const h = raw.trim().replace(/\/+$/, "");
  const m = h.match(/t\.me\/(?:s\/)?([A-Za-z0-9_]{4,})$/i);
  const name = m ? m[1] : h.replace(/^@/, "");
  if (!name || /^\+/.test(name) || /joinchat/i.test(h)) return "";
  return `@${name}`;
}

/** Members are remembered for a few minutes so repeated /start calls stay fast. */
const joinedCache = new Map<number, number>();
const JOIN_CACHE_MS = 10 * 60_000;

/** Show an optional channel prompt on /start only. Returns true when the prompt was shown. */
export async function startJoinPrompt(chatId: number): Promise<boolean> {
  const c = await cfg();
  const ch = (c.forceJoin || "@SilentstoreOfficial").trim();
  const handle = ch ? channelHandle(ch) : "";
  if (!ch || !handle) return false;
  const ok = joinedCache.get(chatId);
  if (ok && Date.now() - ok < JOIN_CACHE_MS) return false;
  try {
    const res = await tg("getChatMember", { chat_id: handle, user_id: chatId });
    const status = res?.result?.status;
    if (["creator", "administrator", "member"].includes(status)) {
      joinedCache.set(chatId, Date.now());
      return false;
    }
  } catch {
    return false;
  }

  await say(
    chatId,
    "📢 <b>Join our official channel</b>\n\nJoin for product updates, new stock and special offers.",
    {
      inline_keyboard: [
        [{ text: "📢 Join channel", url: channelLink(ch) }],
        [
          { text: "✅ I joined", callback_data: "joincheck" },
          { text: "⏭ Skip", callback_data: "joinskip" },
        ],
      ],
    },
  );
  return true;
}

/* ---------------- menus ---------------- */

/**
 * Telegram does not let bots pick button colours, so buttons are colour-coded
 * with coloured markers + the admin's chosen emoji for each slot.
 */
export const DOT = {
  green: "🟢",
  blue: "🔵",
  violet: "🟣",
  orange: "🟠",
  red: "🔴",
  yellow: "🟡",
} as const;

export function cbtn(dot: string, key: string, label: string, data: string) {
  return { text: `${dot} ${be(key)} ${label}`, callback_data: data };
}

export function mainKeyboard() {
  return {
    inline_keyboard: [
      [cbtn(DOT.green, "btn.products", "View Products", "products")],
      [
        cbtn(DOT.blue, "btn.wallet", "Wallet", "wallet"),
        cbtn(DOT.violet, "btn.profile", "Profile", "profile"),
      ],
      [
        cbtn(DOT.yellow, "btn.reviews", "Reviews", "reviews"),
        cbtn(DOT.orange, "btn.refer", "Refer & Earn", "refer"),
      ],
      [
        cbtn(DOT.red, "btn.support", "Support", "support"),
        cbtn(DOT.blue, "btn.orders", "Orders", "orders"),
      ],
      [cbtn(DOT.violet, "btn.apikey", "Reseller API key", "apikey")],
    ],
  };
}

/** Names Telegram sends with each update, used to greet people personally. */
const chatNames = new Map<number, string>();
export function rememberName(chatId: number, name?: string) {
  const n = String(name || "").trim();
  if (n) chatNames.set(chatId, n);
}

export async function welcome(chatId: number) {
  const name = await siteName();
  const who = chatNames.get(chatId) || "there";
  await say(
    chatId,
    `Hey <b>${who}</b> ${em("norm.ok")} <b>Welcome to ${name} !</b>`,
    mainKeyboard(),
  );
  await ensureUser(chatId);
}

/* ---------------- users ---------------- */

const linkCache = new Map<number, string>();
export async function linkedUid(chatId: number): Promise<string | null> {
  const hit = linkCache.get(chatId);
  if (hit) return hit;
  // Prefer the indexed customers.telegram_chat_id lookup (O(1)); fall back to
  // the legacy telegramLinks kv row for any link not yet mirrored on the column.
  let v = await dbUidByChatId(chatId);
  if (!v) v = await dbGet<string>(`telegramLinks/${chatId}`);
  if (v) linkCache.set(chatId, v);
  return v;
}
export function forgetLink(chatId: number) {
  linkCache.delete(chatId);
}

/** Every Telegram user gets a store account keyed by their numeric Telegram id. */
export async function ensureUser(chatId: number): Promise<string> {
  const existing = await linkedUid(chatId);
  if (existing) return existing;
  const uid = `tg_${chatId}`;
  const current = await dbGet<any>(`users/${uid}`);
  if (!current) {
    await dbPut(`users/${uid}`, {
      name: `Telegram ${chatId}`,
      email: "",
      wallet: 0,
      telegramChatId: chatId,
      myRefCode: `TG${String(chatId).slice(-6)}`,
      source: "telegram",
      joined: new Date().toISOString(),
    });
  } else {
    await dbPatch(`users/${uid}`, { telegramChatId: chatId });
  }
  await dbPut(`telegramLinks/${chatId}`, uid);
  invalidateUsers();
  return uid;
}

/** Ask for an email so delivery + order mails can be sent. */
export async function askEmail(chatId: number, why?: string) {
  await setState(chatId, { k: "await_email" });
  await say(
    chatId,
    `📧 <b>Add your email</b>\n\n${why || "Send your email address so we can mail your order and delivery details."}`,
    { inline_keyboard: [[{ text: "⏭ Skip for now", callback_data: "home" }]] },
  );
}

export async function saveEmail(chatId: number, email: string) {
  const uid = await ensureUser(chatId);
  const users = await allUsers();
  const hit = Object.entries(users).find(
    ([id, u]: [string, any]) =>
      id !== uid && String(u?.email || "").toLowerCase() === email.toLowerCase(),
  );
  if (hit && !hit[1]?.telegramChatId) {
    // Same email already used on the website — join the two accounts.
    const [target] = hit;
    await dbPut(`telegramLinks/${chatId}`, target);
    linkCache.set(chatId, target);
    await dbPatch(`users/${target}`, { telegramChatId: chatId });
    await setState(chatId, null);
    invalidateUsers();
    return say(chatId, "✅ Email saved and your existing store account is now connected here.", mainKeyboard());
  }
  await dbPatch(`users/${uid}`, { email });
  invalidateUsers();
  await setState(chatId, null);
  await say(chatId, `✅ Email saved: <code>${email}</code>\nOrder and delivery mails will go there.`, mainKeyboard());
}
