import { cloudCreateIfAbsent, cloudGet, cloudPatch, cloudPush, cloudPut, cloudTransact } from "./cloud-db.server";
/** Server-only helpers for the Telegram bot + database access (Supabase via cloud-db.server). */
import { createHash, timingSafeEqual } from "crypto";

import { hasPremiumEmoji, htmlToEntities, stripPremiumEmojiTags, type TgEntity } from "./telegram-entities";

/**
 * Store-specific values. Settings (site_settings/config) always win; these env
 * variables are only the fallback, and nothing is hardcoded:
 *   SITE_URL               website address
 *   TELEGRAM_OWNER_IDS     comma-separated Telegram chat ids of the bot owners
 *   TELEGRAM_NOTIFY_GROUP  group/channel id that mirrors bot notifications
 */
function envList(name: string): string {
  const env = (globalThis as any)?.process?.env;
  const v = env ? env[name] : undefined;
  return typeof v === "string" ? v.trim() : "";
}
function parseIds(raw: unknown): number[] {
  return (Array.isArray(raw) ? raw : String(raw ?? "").split(/[,\s]+/))
    .map((v) => Number(String(v).trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

let runtimeSiteUrl = "";
let runtimeOwnerIds: number[] = [];
let runtimeGroupId = "";

let runtimeBotToken = "";

export function applyBotConfig(
  c?: {
    siteUrl?: string;
    telegramOwners?: string | number[];
    botToken?: string;
    notifyGroup?: string | number;
  } | null,
) {
  if (!c) return;
  if (c.botToken !== undefined) runtimeBotToken = String(c.botToken ?? "").trim();
  if (c.siteUrl) runtimeSiteUrl = String(c.siteUrl).trim().replace(/\/+$/, "");
  if (c.notifyGroup !== undefined) runtimeGroupId = normalizeGroupId(c.notifyGroup);
  const ids = parseIds(c.telegramOwners);
  if (ids.length) runtimeOwnerIds = ids;
}

export const siteUrl = () =>
  runtimeSiteUrl || envList("SITE_URL").replace(/\/+$/, "");
export const ownerIds = () =>
  runtimeOwnerIds.length ? runtimeOwnerIds : parseIds(envList("TELEGRAM_OWNER_IDS"));

/**
 * Telegram supergroup ids are negative (-100…). The admin may paste the plain
 * digits (1234567890, shown by some clients) or an invite link; normalize to
 * the numeric chat id (-1001234567890).
 */
function normalizeGroupId(raw: string | number): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const digits = s.replace(/[^\d-]/g, "");
  if (!digits || digits === "-") return "";
  if (digits.startsWith("-")) return digits;
  return digits.length >= 10 ? `-100${digits}` : digits;
}

export const groupId = () => runtimeGroupId || normalizeGroupId(envList("TELEGRAM_NOTIFY_GROUP"));



const GATEWAY = "https://connector-gateway.lovable.dev/telegram";

/**
 * Read a setting from the hosting environment at the moment it is needed.
 * Going through globalThis keeps the value out of the build, so changing it on
 * the host takes effect on the next restart without rebuilding the site.
 */
function envVar(name: string): string {
  const env = (globalThis as any)?.process?.env;
  const v = env ? env[name] : undefined;
  return typeof v === "string" ? v.trim() : "";
}

/** Bot token set in the admin panel (preferred) or in the project secrets. */
export function botToken(): string {
  return runtimeBotToken || envVar("TELEGRAM_BOT_TOKEN");
}

/** Where to send Bot API calls: the admin token first, the linked bot otherwise. */
export function tgApi(method: string): { url: string; headers: Record<string, string> } | null {
  const token = botToken();
  if (token) return { url: `https://api.telegram.org/bot${token}/${method}`, headers: {} };
  const lovableKey = envVar("LOVABLE_API_KEY");
  const connKey = telegramConnectionKey();
  if (!lovableKey || !connKey) return null;
  return {
    url: `${GATEWAY}/${method}`,
    headers: { Authorization: `Bearer ${lovableKey}`, "X-Connection-Api-Key": connKey },
  };
}

/** Download URL for a Telegram file path. */
export function tgFileUrl(path: string): { url: string; headers: Record<string, string> } | null {
  const token = botToken();
  if (token) return { url: `https://api.telegram.org/file/bot${token}/${path}`, headers: {} };
  const api = tgApi(`file/${path}`);
  return api;
}

/** Latest linked Telegram connection key (newest slot wins). */
export function telegramConnectionKey(): string | undefined {
  return envVar("TELEGRAM_API_KEY_1") || envVar("TELEGRAM_API_KEY") || undefined;
}



/* ---------------- inline button styling ---------------- */

/**
 * Bot API 10.3 gives inline buttons a `style` ("primary" | "success" | "danger")
 * and an `icon_custom_emoji_id` (premium emoji icon). The emoji registry plugs a
 * decorator in here so every keyboard we send gets coloured automatically.
 */
type KeyboardDecorator = (markup: any) => any;
let keyboardDecorator: KeyboardDecorator = (m) => m;

export function setKeyboardDecorator(fn: KeyboardDecorator): void {
  keyboardDecorator = fn;
}

export function decorateMarkup(markup: any): any {
  if (!markup || !Array.isArray(markup.inline_keyboard)) return markup;
  try {
    return keyboardDecorator(markup);
  } catch {
    return markup;
  }
}

/**
 * Emoji chosen by the admin must apply everywhere the same emoji appears, not
 * only on the one button it was picked for. The emoji registry plugs a text
 * decorator in here so every outgoing message/caption is upgraded.
 */
type TextDecorator = (text: string) => string;
let textDecorator: TextDecorator = (t) => t;

export function setTextDecorator(fn: TextDecorator): void {
  textDecorator = fn;
}

export function decorateText(text: unknown): unknown {
  if (typeof text !== "string" || !text) return text;
  try {
    return textDecorator(text);
  } catch {
    return text;
  }
}

/** Prepare message text or a caption for both JSON and multipart Telegram calls. */
export function prepareTelegramText(text: string): {
  text: string;
  entities?: TgEntity[];
} {
  const decorated = String(decorateText(text));
  if (!hasPremiumEmoji(decorated)) return { text: decorated };
  const parsed = htmlToEntities(decorated);
  return parsed || { text: stripPremiumEmojiTags(decorated) };
}


/** Drop premium icons if Telegram refuses them for this bot. */
function stripIcons(markup: any): any {
  if (!markup || !Array.isArray(markup.inline_keyboard)) return markup;
  return {
    ...markup,
    inline_keyboard: markup.inline_keyboard.map((row: any[]) =>
      row.map(({ icon_custom_emoji_id, ...rest }: any) => rest),
    ),
  };
}

function stripUnsupportedButtonDecorations(markup: any): any {
  const plain = stripIcons(markup);
  if (!plain || !Array.isArray(plain.inline_keyboard)) return plain;
  return {
    ...plain,
    inline_keyboard: plain.inline_keyboard.map((row: any[]) =>
      row.map(({ style, ...button }: any) => button),
    ),
  };
}

/* ---- customer-first sending: broadcasts yield to live bot replies ---- */
const interactiveCalls: number[] = [];
let broadcastPause = 0;
/** How many customer-facing Telegram calls happened in the last second. */
export function interactiveLoad(): number {
  const cut = Date.now() - 1000;
  while (interactiveCalls.length && interactiveCalls[0]! < cut) interactiveCalls.shift();
  return interactiveCalls.length;
}
/** Broadcasts wait until this time after Telegram asked us to slow down. */
export function broadcastPausedUntil(): number {
  return broadcastPause;
}

export async function tg(method: string, body: Record<string, unknown>): Promise<any> {
  const api = tgApi(method);
  if (!api) throw new Error("Telegram bot is not configured. Add the bot token in the admin panel.");
  const payload: Record<string, unknown> = { ...body };
  const isBroadcast = payload["_broadcast"] === true;
  delete payload["_broadcast"];
  if (!isBroadcast) {
    interactiveCalls.push(Date.now());
    if (interactiveCalls.length > 500) interactiveCalls.splice(0, 250);
  }
  if (payload["reply_markup"]) payload["reply_markup"] = decorateMarkup(payload["reply_markup"]);
  if (payload["text"]) payload["text"] = decorateText(payload["text"]);
  if (payload["caption"]) payload["caption"] = decorateText(payload["caption"]);

  // Telegram's HTML mode does not render <tg-emoji> on every client, so any
  // message holding a premium emoji is converted to text + entities instead.
  for (const field of ["text", "caption"] as const) {
    const value = payload[field];
    if (!hasPremiumEmoji(value)) continue;
    const parsed = htmlToEntities(String(value));
    if (!parsed) continue;
    payload[field] = parsed.text;
    payload[field === "text" ? "entities" : "caption_entities"] = parsed.entities;
    delete payload["parse_mode"];
  }


  const call = async (data: Record<string, unknown>) => {
    const res = await fetch(api.url, {
      method: "POST",
      headers: { ...api.headers, "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Telegram ${method} failed [${res.status}]: ${text}`);
    const json = JSON.parse(text);
    if (json?.ok === false) throw new Error(`Telegram ${method} error: ${json.description}`);
    return json;
  };

  try {
    try {
      return await call(payload);
    } catch (err) {
      const m = String((err as Error)?.message || "");
      const ra = /\[429\][\s\S]*"retry_after"\s*:\s*(\d+)/.exec(m);
      if (!ra) throw err;
      const wait = Number(ra[1]) * 1000 + 250;
      // Telegram said "slow down": pause broadcasts so customers come first.
      broadcastPause = Math.max(broadcastPause, Date.now() + wait);
      if (isBroadcast || wait > 6000) throw err;
      await new Promise((r) => setTimeout(r, wait));
      return await call(payload);
    }
  } catch (err) {
    const msg = String((err as Error)?.message || "");
    // Bots without a Fragment username / premium owner can't use premium icons,
    // and older clients may reject the style field — retry plain instead of failing.
    if (/custom_emoji|CUSTOM_EMOJI|icon|style|entit/i.test(msg)) {
      // Premium emoji in message text also needs a Fragment-linked bot — fall
      // back to the plain emoji characters rather than dropping the message.
      const plainText = (v: unknown) => (typeof v === "string" ? stripPremiumEmojiTags(v) : v);
      const retry: Record<string, unknown> = { ...payload };
      if (retry["text"]) retry["text"] = plainText(retry["text"]);
      if (retry["caption"]) retry["caption"] = plainText(retry["caption"]);
      // Custom-emoji entities are what the server refused — drop them as well.
      delete retry["entities"];
      delete retry["caption_entities"];
      // Retry from the original keyboard so its ordinary emoji remains visible
      // when Telegram refuses custom button icons.
      if (body["reply_markup"])
        retry["reply_markup"] = stripUnsupportedButtonDecorations(body["reply_markup"]);
      return await call(retry);
    }
    throw err;

  }
}


function secretFor(key: string): string {
  return createHash("sha256").update(`telegram-webhook:${key}`).digest("base64url");
}

/** Secret we register with Telegram for the bot currently in use. */
export function telegramWebhookSecret(): string {
  return secretFor(botToken() || telegramConnectionKey() || "");
}

/** Accept the secret of either the admin token or the linked bot connection. */
export function telegramWebhookOk(actual: string): boolean {
  const keys = [botToken(), telegramConnectionKey() || ""].filter(Boolean);
  return keys.some((k) => safeEqual(actual, secretFor(k)));
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/* ---------------- Database (Firebase-style paths over Supabase) ---------------- */

export async function dbGet<T = any>(path: string): Promise<T | null> {
  return cloudGet<T>(path);
}

let runtimeLoadedAt = 0;
let runtimeLoading: Promise<void> | null = null;

function pullBotRuntime(): Promise<void> {
  runtimeLoading ||= dbGet<any>("site_settings/config")
    .catch(() => null)
    .then(async (c) => {
      runtimeLoadedAt = Date.now();
      applyBotConfig(c);
      const { applyReferralConfig } = await import("./referral");
      applyReferralConfig(c);
    })
    .catch(() => undefined)
    .finally(() => {
      runtimeLoading = null;
    });
  return runtimeLoading;
}

/** Pull the admin-managed settings (site link, owners, referral) into this worker.
 *  Once loaded, later refreshes happen in the background so no message waits. */
export async function loadBotRuntime(force = false): Promise<void> {
  if (force) return pullBotRuntime();
  if (!runtimeLoadedAt) return pullBotRuntime();
  if (Date.now() - runtimeLoadedAt >= 30_000) void pullBotRuntime();
}



export async function dbPut(path: string, value: unknown): Promise<void> {
  return cloudPut(path, value);
}

/**
 * Atomically creates a database value only when that path is still empty, so
 * webhooks and button taps arriving at the same moment can claim it only once.
 */
export async function dbCreateIfAbsent(path: string, value: unknown): Promise<boolean> {
  return cloudCreateIfAbsent(path, value);
}

/**
 * Read-modify-write that is safe across parallel requests (compare-and-swap).
 * `update` returns the new value, or `undefined` to abort without writing.
 * Returns the written value, or `undefined` when aborted.
 */
export async function dbTransact<T, R = T>(
  path: string,
  update: (current: T | null) => R | undefined,
  tries = 8,
): Promise<R | undefined> {
  return cloudTransact<T, R>(path, update, tries);
}



export async function dbPatch(path: string, value: Record<string, unknown>): Promise<void> {
  return cloudPatch(path, value);
}

export async function dbPush(path: string, value: unknown): Promise<void> {
  // Every wallet change writes a history entry — tell the bot admins about it.
  const hm = /^users\/([^/]+)\/history$/.exec(path);
  if (hm && value && typeof value === "object") void notifyBalanceChange(hm[1]!, value as any).catch(() => undefined);
  await cloudPush(path, value);
}

export function money(n: number): string {
  return `$${Number(n || 0).toFixed(2)}`;
}

/* ---------------- who the log is about ---------------- */

const usernameCache = new Map<number, string>();

/** Keep the Telegram @username of anyone who writes to the bot, for the logs. */
export function rememberUsername(chatId: number, username?: string): void {
  const id = Number(chatId);
  if (!id || !username) return;
  if (usernameCache.get(id) === username) return;
  usernameCache.set(id, username);
  void dbPut(`telegramUsernames/${id}`, username).catch(() => undefined);
}

/** "@name" when we know it, otherwise "user <id>". */
export async function tgTag(chatId: number | string): Promise<string> {
  const id = Number(chatId);
  if (!id) return `user <code>${String(chatId)}</code>`;
  let u = usernameCache.get(id);
  if (!u) {
    u = (await dbGet<string>(`telegramUsernames/${id}`).catch(() => undefined)) || undefined;
    if (u) usernameCache.set(id, u);
  }
  return u ? `@${u}` : `user <code>${id}</code>`;
}

function escHtml(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Owner alert for any balance change, with the reason from the history entry. */
export async function notifyBalanceChange(
  uid: string,
  entry: { type?: string; amount?: number | string; desc?: string; by?: string },
): Promise<void> {
  const amount = Number(entry.amount) || 0;
  if (!amount) return;
  await new Promise((r) => setTimeout(r, 400)); // let the new balance land first
  const user = (await dbGet<any>(`users/${uid}`).catch(() => null)) || {};
  const who = user.email
    ? escHtml(user.email)
    : user.telegramChatId
      ? await tgTag(user.telegramChatId)
      : `<code>${escHtml(uid)}</code>`;
  const sign = amount > 0 ? "+" : "−";
  await notifyOwners(
    `💰 <b>Balance changed</b>\n\n👤 ${who}\n${amount > 0 ? "🟢" : "🔴"} ${sign}${money(Math.abs(amount))} (${escHtml(entry.type || "Change")})\n📝 Reason: ${escHtml(entry.desc || "—")}${entry.by ? `\n🛠 By: ${escHtml(entry.by)}` : ""}\n💼 New balance: <b>${money(Number(user.wallet) || 0)}</b>`,
  );
}

/** Mirror a notification into the activity group (silently skipped when unset). */
export async function notifyGroup(text: string): Promise<void> {
  const gid = groupId();
  if (!gid) return;
  await tg("sendMessage", { chat_id: gid, text, parse_mode: "HTML" }).catch(() => undefined);
}

/** Every notification goes to the owners privately AND to the activity group. */
export async function notifyOwners(text: string): Promise<void> {
  await Promise.all([
    ...ownerIds().map((id) =>
      tg("sendMessage", { chat_id: id, text, parse_mode: "HTML" }).catch(() => undefined),
    ),
    notifyGroup(text),
    import("./push.server")
      .then(({ pushAdmins, plain }) => {
        const t = plain(text);
        const [title, ...rest] = t.split("\n");
        return pushAdmins({ title: title || "Store alert", body: rest.join("\n") || t, url: "/admin" });
      })
      .catch(() => undefined),
  ]);
}


import { plainEmojiText } from "@/lib/bot/delivery-files.server";
export {
  plainEmojiText,
  buildDeliveryPdf,
  buildDeliverySvg,
  tgSendDocument,
  sendDeliveryFiles,
} from "@/lib/bot/delivery-files.server";

/* ---------------- photos ---------------- */

/**
 * Telegram re-hosts every photo we upload. Re-uploading the same product image
 * on each view is what makes photos slow, so the returned file_id is cached
 * (memory + database) and reused — later sends are a tiny JSON call.
 */
const photoIdMemo = new Map<string, string>();

function photoKey(photo: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < photo.length; i++) {
    h1 = ((h1 ^ photo.charCodeAt(i)) * 16777619) >>> 0;
    h2 = ((h2 + photo.charCodeAt(i) * (i + 1)) * 2654435761) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}${photo.length.toString(36)}`;
}

async function cachedPhotoId(key: string): Promise<string | null> {
  const local = photoIdMemo.get(key);
  if (local) return local;
  const stored = await dbGet<string>(`tg_photo_cache/${key}`).catch(() => null);
  if (stored && typeof stored === "string") {
    photoIdMemo.set(key, stored);
    return stored;
  }
  return null;
}

function rememberPhotoId(key: string, fileId: string) {
  photoIdMemo.set(key, fileId);
  void dbPut(`tg_photo_cache/${key}`, fileId).catch(() => {});
}

function extractFileId(result: any): string | null {
  const photos = result?.result?.photo;
  if (!Array.isArray(photos) || !photos.length) return null;
  const biggest = photos[photos.length - 1];
  return typeof biggest?.file_id === "string" ? biggest.file_id : null;
}

/** Send a product photo. Accepts an http(s) URL, a data: URL, or a Telegram file_id. */
export async function tgSendPhoto(
  chatId: number,
  photo: string,
  caption?: string,
  keyboard?: unknown,
): Promise<boolean> {
  try {
    const src = photo.trim();
    const key = photoKey(src);
    const cached = await cachedPhotoId(key);
    if (cached) {
      try {
        await tg("sendPhoto", {
          chat_id: chatId,
          photo: cached,
          ...(caption ? { caption: String(decorateText(caption)), parse_mode: "HTML" } : {}),
          ...(keyboard ? { reply_markup: decorateMarkup(keyboard) } : {}),
        });
        return true;
      } catch {
        // Cached id expired or was rejected — fall through and upload again.
        photoIdMemo.delete(key);
        void dbPut(`tg_photo_cache/${key}`, null).catch(() => {});
      }
    }

    const m = /^data:([^;,]+);base64,(.*)$/i.exec(src);
    if (m) {
      const api = tgApi("sendPhoto");
      if (!api) return false;
      const bytes = Buffer.from(m[2]!, "base64");
      const form = new FormData();
      form.append("chat_id", String(chatId));
      if (caption) {
        const prepared = prepareTelegramText(caption);
        form.append("caption", prepared.text);
        if (prepared.entities) form.append("caption_entities", JSON.stringify(prepared.entities));
        else form.append("parse_mode", "HTML");
      }
      if (keyboard) form.append("reply_markup", JSON.stringify(decorateMarkup(keyboard)));
      const ext = (m[1] || "image/jpeg").split("/")[1]?.split("+")[0] || "jpg";
      form.append("photo", new Blob([bytes as unknown as BlobPart], { type: m[1] || "image/jpeg" }), `photo.${ext}`);
      const res = await fetch(api.url, { method: "POST", headers: api.headers, body: form });
      if (!res.ok) {
        const detail = await res.text();
        console.error(`Telegram sendPhoto failed [${res.status}]: ${detail}`);
        // Retry without unsupported premium entities, icons, or button styles so
        // the photo still reaches the buyer on bots/accounts lacking support.
        if (/emoji|entit|icon|style|button_type_invalid/i.test(detail)) {
          if (caption) form.set("caption", plainEmojiText(String(decorateText(caption))));
          form.delete("caption_entities");
          if (caption) form.set("parse_mode", "HTML");
          if (keyboard)
            form.set(
              "reply_markup",
              JSON.stringify(stripUnsupportedButtonDecorations(decorateMarkup(keyboard))),
            );
          const retry = await fetch(api.url, { method: "POST", headers: api.headers, body: form });
          if (retry.ok) {
            const id = extractFileId(await retry.json().catch(() => null));
            if (id) rememberPhotoId(key, id);
            return true;
          }
        }
        return false;
      }
      const id = extractFileId(await res.json().catch(() => null));
      if (id) rememberPhotoId(key, id);
      return true;
    }
    if (!/^https?:\/\//i.test(src)) return false;
    const sent = await tg("sendPhoto", {
      chat_id: chatId,
      photo: src,
      ...(caption ? { caption: String(decorateText(caption)), parse_mode: "HTML" } : {}),
      ...(keyboard ? { reply_markup: decorateMarkup(keyboard) } : {}),
    });
    const id = extractFileId(sent);
    if (id) rememberPhotoId(key, id);
    return true;
  } catch (e) {
    console.error("sendPhoto error", e);
    return false;
  }
}

/* ---------------- file download ---------------- */

/** Download a Telegram file (by file_id) and return it as a data: URL. */
export async function tgFileDataUrl(fileId: string, maxBytes = 1_500_000): Promise<string | null> {
  try {
    const info = await tg("getFile", { file_id: fileId });
    const path = info?.result?.file_path;
    if (!path) return null;
    const file = tgFileUrl(String(path));
    if (!file) return null;
    const res = await fetch(file.url, { headers: file.headers });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > maxBytes) return null;
    const ext = String(path).split(".").pop()?.toLowerCase() || "webp";
    const mime =
      ext === "png"
        ? "image/png"
        : ext === "jpg" || ext === "jpeg"
          ? "image/jpeg"
          : ext === "webm"
            ? "video/webm"
            : ext === "tgs"
              ? "application/x-tgsticker"
              : "image/webp";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/** Telegram file id for a photo already uploaded once (null if not yet cached). */
export async function telegramPhotoId(photo: string): Promise<string | null> {
  return cachedPhotoId(photoKey(photo.trim()));
}
