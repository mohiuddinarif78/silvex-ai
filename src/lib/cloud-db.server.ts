/**
 * Lovable Cloud data layer with Firebase-style paths.
 *
 * The bot and server code were written against Firebase paths
 * ("users/<uid>/wallet", "products/<id>/stock", ...). This module keeps that
 * interface but stores the data in Lovable Cloud tables:
 *   users/<uid>         -> customers (+ wallet_history, customer_alerts)
 *   products/<id>       -> products (+ product_stock as the "stock" list)
 *   orders/<id>         -> orders
 *   site_settings/<key> -> settings
 *   anything else       -> kv_store, one row per "<top>/<key>"
 * Transactions use compare-and-swap on each row's updated_at, replacing
 * Firebase ETags.
 */

type Json = any;

async function sb(): Promise<any> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as any;
}

const TABLE_TOPS = new Set(["users", "products", "orders", "site_settings"]);

/* ---------------- small helpers ---------------- */

function split(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** Dates go back out as ISO strings, the way the store always saved them. */
function ms(v: unknown): string | undefined {
  if (!v) return undefined;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

function toIso(v: unknown): string | null {
  if (typeof v === "number" && v > 1e11) return new Date(v).toISOString();
  if (typeof v === "string" && v.length >= 10 && Number.isFinite(Date.parse(v))) return new Date(v).toISOString();
  return null;
}

function num(v: unknown, d = 0): number {
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) < 1e9 ? n : d;
}

function numOrNull(v: unknown): number | null {
  return v === undefined || v === null || v === "" ? null : num(v);
}

/** Firebase never stores null, empty objects or empty arrays. */
function prune(v: Json): Json {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) {
    const a = v.map(prune);
    return a.some((x) => x !== undefined) ? a.map((x) => (x === undefined ? null : x)) : undefined;
  }
  if (typeof v === "object") {
    const o: any = {};
    for (const [k, x] of Object.entries(v)) {
      const p = prune(x);
      if (p !== undefined) o[k] = p;
    }
    return Object.keys(o).length ? o : undefined;
  }
  return v;
}

function getAt(obj: Json, parts: string[]): Json {
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return null;
    cur = cur[p];
  }
  return cur === undefined ? null : cur;
}

function setAt(obj: Json, parts: string[], value: Json): Json {
  if (!parts.length) return value;
  const base = obj && typeof obj === "object" ? (Array.isArray(obj) ? { ...obj } : { ...obj }) : {};
  const [head, ...rest] = parts as [string, ...string[]];
  base[head] = setAt(base[head], rest, value);
  return base;
}

let lastPush = 0;
let pushSeq = 0;
/** Chronologically sortable unique key, like Firebase push ids. */
export function pushId(): string {
  const now = Date.now();
  pushSeq = now === lastPush ? pushSeq + 1 : 0;
  lastPush = now;
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, "0");
  return `-${now.toString(36).padStart(9, "0")}${pushSeq.toString(36).padStart(2, "0")}${rand}`;
}

async function fetchAll(build: (from: number, to: number) => any): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(`Cloud read failed: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < 1000) return out;
  }
}

/* ---------------- customers ---------------- */

const USER_COLS: Record<string, string> = {
  email: "email", name: "name", phone: "phone", myRefCode: "ref_code", refBy: "ref_by", usedRef: "used_ref",
  refBonusDone: "ref_bonus_done", refEarned: "ref_earned", wallet: "wallet", totalDeposit: "total_deposit",
  telegramChatId: "telegram_chat_id", telegramUsername: "telegram_username", source: "source", apiKey: "api_key",
  apiEnabled: "api_enabled", used_coupons: "used_coupons",
};

function historyEntry(h: any): Json {
  return { ...(h.extra || {}), type: h.type, amount: Number(h.amount), desc: h.description, by: h.by_email, date: ms(h.created_at) };
}

function rowToUser(row: any, history: any[], alerts: any[]): Json {
  const u: any = { ...(row.extra || {}) };
  for (const [k, col] of Object.entries(USER_COLS)) u[k] = row[col];
  u.wallet = Number(row.wallet);
  u.refEarned = Number(row.ref_earned);
  u.totalDeposit = Number(row.total_deposit);
  if (row.telegram_chat_id !== null && row.telegram_chat_id !== undefined) u.telegramChatId = String(row.telegram_chat_id);
  if (!row.ref_bonus_done) delete u.refBonusDone;
  if (!row.api_enabled) delete u.apiEnabled;
  u.joined = ms(row.joined_at);
  u.history = Object.fromEntries(history.map((h) => [h.legacy_id || h.id, historyEntry(h)]));
  u.alerts = Object.fromEntries(alerts.map((a) => [a.id, { msg: a.msg, date: ms(a.created_at) }]));
  return prune(u) ?? null;
}

function userToRow(uid: string, u: any): any {
  const row: any = { legacy_uid: uid };
  const extra: any = {};
  for (const [k, v] of Object.entries(u || {})) {
    if (k === "history" || k === "alerts" || k === "joined") continue;
    if (USER_COLS[k]) continue;
    extra[k] = v;
  }
  row.email = u.email || null;
  row.name = u.name || "User";
  row.phone = u.phone ?? null;
  row.ref_code = u.myRefCode ?? null;
  row.ref_by = u.refBy ?? null;
  row.used_ref = u.usedRef ?? null;
  row.ref_bonus_done = !!u.refBonusDone;
  row.ref_earned = num(u.refEarned);
  // No clamping: a negative balance means a bug, and the database's
  // CHECK (wallet >= 0) must reject it loudly instead of hiding the loss.
  row.wallet = num(u.wallet);
  row.total_deposit = num(u.totalDeposit);
  const chat = parseInt(String(u.telegramChatId ?? "").trim(), 10);
  row.telegram_chat_id = Number.isFinite(chat) ? chat : null;
  row.telegram_username = u.telegramUsername ?? null;
  row.source = u.source ?? null;
  row.api_key = u.apiKey ?? null;
  row.api_enabled = !!u.apiEnabled;
  row.used_coupons = u.used_coupons || {};
  row.extra = extra;
  const j = toIso(u.joined);
  if (j) row.joined_at = j;
  return row;
}

/* ---------------- products ---------------- */

const PRODUCT_COLS: Record<string, string> = {
  title: "title", desc: "description", price: "price", botPrice: "bot_price", apiPrice: "api_price", type: "type",
  delivery: "delivery", link: "link", logo: "logo", hidden: "hidden", hideWeb: "hide_web", hideBot: "hide_bot",
  soldOut: "sold_out", locked: "locked", salesCount: "sales_count", provider: "provider", providerName: "provider_name",
  supplierId: "supplier_id", supplierPrice: "supplier_price", supplierStock: "supplier_stock",
  supplierSyncedAt: "supplier_synced_at", markup: "markup",
};
const NUMERIC = new Set(["price", "bot_price", "api_price", "supplier_price", "markup"]);
const BOOLS = new Set(["hidden", "hide_web", "hide_bot", "sold_out", "locked"]);

function rowToProduct(row: any, stock: string[]): Json {
  const p: any = { ...(row.extra || {}) };
  for (const [k, col] of Object.entries(PRODUCT_COLS)) {
    let v = row[col];
    if (v !== null && NUMERIC.has(col)) v = Number(v);
    if (BOOLS.has(col) && !v) v = undefined;
    p[k] = v;
  }
  p.supplierSyncedAt = ms(row.supplier_synced_at);
  if (stock.length) p.stock = stock;
  return prune(p) ?? null;
}

function productToRow(id: string, p: any): any {
  const row: any = { id };
  const extra: any = {};
  for (const [k, v] of Object.entries(p || {})) if (!PRODUCT_COLS[k] && k !== "stock") extra[k] = v;
  row.title = p.title || "";
  row.description = p.desc ?? null;
  row.price = num(p.price);
  row.bot_price = numOrNull(p.botPrice);
  row.api_price = numOrNull(p.apiPrice);
  row.type = p.type ?? null;
  row.delivery = p.delivery || "manual";
  row.link = p.link ?? null;
  row.logo = p.logo ?? null;
  row.hidden = !!p.hidden;
  row.hide_web = !!p.hideWeb;
  row.hide_bot = !!p.hideBot;
  row.sold_out = !!p.soldOut;
  row.locked = !!p.locked;
  row.sales_count = Math.trunc(num(p.salesCount));
  row.provider = p.provider ?? null;
  row.provider_name = p.providerName ?? null;
  row.supplier_id = p.supplierId === undefined || p.supplierId === null ? null : String(p.supplierId);
  row.supplier_price = numOrNull(p.supplierPrice);
  row.supplier_stock = p.supplierStock === undefined || p.supplierStock === null ? null : Math.trunc(num(p.supplierStock));
  row.supplier_synced_at = toIso(p.supplierSyncedAt);
  row.markup = numOrNull(p.markup);
  row.extra = extra;
  return row;
}

function stockList(v: Json): string[] {
  const list = Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : [];
  return list.filter((x) => x !== null && x !== undefined && x !== "").map(String);
}

/* ---------------- orders ---------------- */

const ORDER_COLS = ["uid", "email", "status", "total", "coupon", "couponDiscount", "source", "items", "delivered", "note", "date"];

function rowToOrder(row: any): Json {
  return prune({
    ...(row.extra || {}),
    uid: row.customers?.legacy_uid, email: row.email, status: row.status, total: Number(row.total),
    coupon: row.coupon, couponDiscount: Number(row.coupon_discount) || undefined, source: row.source,
    items: row.items, delivered: row.delivery, note: row.note, date: ms(row.created_at),
  }) ?? null;
}

async function orderToRow(id: string, o: any): Promise<any> {
  const extra: any = {};
  for (const [k, v] of Object.entries(o || {})) if (!ORDER_COLS.includes(k)) extra[k] = v;
  const items = Array.isArray(o.items) ? o.items : o.items && typeof o.items === "object" ? Object.values(o.items) : [];
  const row: any = {
    id, customer_id: o.uid ? await customerId(String(o.uid)) : null, email: o.email ?? null,
    status: o.status || "Pending", total: num(o.total), coupon: o.coupon ?? null,
    coupon_discount: num(o.couponDiscount), source: o.source ?? null, items, delivery: o.delivered ?? null,
    note: o.note ?? null, extra,
  };
  const d = toIso(o.date);
  if (d) row.created_at = d;
  return row;
}

const customerIds = new Map<string, string>();
async function customerId(uid: string): Promise<string | null> {
  const hit = customerIds.get(uid);
  if (hit) return hit;
  const { data } = await (await sb()).from("customers").select("id").eq("legacy_uid", uid).maybeSingle();
  if (data?.id) customerIds.set(uid, data.id);
  return data?.id ?? null;
}

/* ---------------- settings ---------------- */

const PUBLIC_SETTINGS = new Set(["banner", "flash_sale", "button_colors"]);
function unwrapSetting(v: Json): Json {
  if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && "__v" in v) return v.__v;
  return v;
}
function wrapSetting(v: Json): Json {
  return v && typeof v === "object" ? v : { __v: v };
}

/* ---------------- node read/write ---------------- */

interface Node {
  value: Json;
  stamp: string | null; // updated_at, for compare-and-swap
}

async function readNode(top: string, key: string): Promise<Node> {
  const db = await sb();
  if (top === "users") {
    const { data: row } = await db.from("customers").select("*").eq("legacy_uid", key).maybeSingle();
    if (!row) return { value: null, stamp: null };
    customerIds.set(key, row.id);
    const [h, a] = await Promise.all([
      db.from("wallet_history").select("*").eq("customer_id", row.id).order("created_at"),
      db.from("customer_alerts").select("*").eq("customer_id", row.id).order("created_at"),
    ]);
    return { value: rowToUser(row, h.data || [], a.data || []), stamp: row.updated_at };
  }
  if (top === "products") {
    const { data: row } = await db.from("products").select("*").eq("id", key).maybeSingle();
    if (!row) return { value: null, stamp: null };
    const st = await fetchAll((f, t) => db.from("product_stock").select("content").eq("product_id", key).order("id").range(f, t));
    return { value: rowToProduct(row, st.map((s) => s.content)), stamp: row.updated_at };
  }
  if (top === "orders") {
    const { data: row } = await db.from("orders").select("*, customers(legacy_uid)").eq("id", key).maybeSingle();
    return row ? { value: rowToOrder(row), stamp: row.updated_at } : { value: null, stamp: null };
  }
  if (top === "site_settings") {
    const { data: row } = await db.from("settings").select("*").eq("key", key).maybeSingle();
    return row ? { value: unwrapSetting(row.value), stamp: row.updated_at } : { value: null, stamp: null };
  }
  const { data: row } = await db.from("kv_store").select("*").eq("path", `${top}/${key}`).maybeSingle();
  return row ? { value: row.value, stamp: row.updated_at } : { value: null, stamp: null };
}

/** Writes a whole node. With `expect`, only succeeds if the row is unchanged. */
async function writeNode(top: string, key: string, value: Json, expect?: { stamp: string | null }): Promise<boolean> {
  const db = await sb();
  const now = new Date().toISOString();
  value = prune(value);
  const table = top === "users" ? "customers" : top === "products" ? "products" : top === "orders" ? "orders" : top === "site_settings" ? "settings" : "kv_store";
  const keyCol = top === "users" ? "legacy_uid" : top === "site_settings" ? "key" : table === "kv_store" ? "path" : "id";
  const keyVal = table === "kv_store" ? `${top}/${key}` : key;

  if (value === undefined) {
    let q = db.from(table).delete().eq(keyCol, keyVal);
    if (expect?.stamp) q = q.eq("updated_at", expect.stamp);
    const { error } = await q;
    if (error) throw new Error(`Cloud delete failed: ${error.message}`);
    if (top === "users") customerIds.delete(key);
    return true;
  }

  let row: any;
  if (top === "users") row = userToRow(key, value);
  else if (top === "products") row = productToRow(key, value);
  else if (top === "orders") row = await orderToRow(key, value);
  else if (top === "site_settings") row = { key, value: wrapSetting(value), is_public: PUBLIC_SETTINGS.has(key) };
  else row = { path: keyVal, value };
  row.updated_at = now;

  if (expect) {
    if (expect.stamp === null) {
      const { error } = await db.from(table).insert(row);
      if (error) {
        if (error.code === "23505") return false;
        throw new Error(`Cloud write failed: ${error.message}`);
      }
    } else {
      const { data, error } = await db.from(table).update(row).eq(keyCol, keyVal).eq("updated_at", expect.stamp).select(keyCol);
      if (error) throw new Error(`Cloud write failed: ${error.message}`);
      if (!data?.length) return false;
    }
  } else {
    const { error } = await db.from(table).upsert(row, { onConflict: keyCol });
    if (error) throw new Error(`Cloud write failed: ${error.message}`);
  }

  if (top === "users") await syncUserChildren(key, value);
  if (top === "products") await syncStock(key, stockList(value.stock));
  return true;
}

async function syncUserChildren(uid: string, u: any): Promise<void> {
  const db = await sb();
  const cid = await customerId(uid);
  if (!cid) return;
  const want = u.history && typeof u.history === "object" ? u.history : {};
  const { data: have } = await db.from("wallet_history").select("id, legacy_id").eq("customer_id", cid);
  const haveKeys = new Map<string, string>((have || []).map((h: any) => [h.legacy_id || h.id, h.id]));
  const add = Object.entries(want).filter(([k]) => !haveKeys.has(k));
  const drop = [...haveKeys].filter(([k]) => !(k in want)).map(([, id]) => id);
  if (add.length) await db.from("wallet_history").insert(add.map(([k, e]) => historyRow(cid, k, e)));
  if (drop.length) await db.from("wallet_history").delete().in("id", drop);

  const wantAlerts = u.alerts && typeof u.alerts === "object" ? u.alerts : {};
  const { data: haveA } = await db.from("customer_alerts").select("id").eq("customer_id", cid);
  const haveAlertIds = new Set((haveA || []).map((a: any) => a.id));
  const newAlerts = Object.entries(wantAlerts).filter(([k, a]: any) => !haveAlertIds.has(k) && a?.msg);
  const goneAlerts = [...haveAlertIds].filter((id) => !(String(id) in wantAlerts));
  if (newAlerts.length) await db.from("customer_alerts").insert(newAlerts.map(([, a]: any) => ({ customer_id: cid, msg: a.msg, created_at: toIso(a.date) || new Date().toISOString() })));
  if (goneAlerts.length) await db.from("customer_alerts").delete().in("id", goneAlerts);
}

function historyRow(cid: string, key: string, e: any): any {
  const { type, amount, desc, date, by, ...extra } = e || {};
  return {
    legacy_id: key, customer_id: cid, type: type || "Adjustment", amount: num(amount), description: desc ?? null,
    by_email: by ?? null, extra, created_at: toIso(date) || new Date().toISOString(),
  };
}

async function syncStock(pid: string, want: string[]): Promise<void> {
  const db = await sb();
  const have = await fetchAll((f, t) => db.from("product_stock").select("id, content").eq("product_id", pid).order("id").range(f, t));
  const same = have.length === want.length && have.every((h, i) => h.content === want[i]);
  if (same) return;
  // Keep the longest unchanged prefix so claiming from the front stays cheap.
  let keep = 0;
  // Common case: items removed from the front (delivered) or appended at the end.
  let start = 0;
  while (start < have.length && have.length - start >= 0) {
    const rest = have.slice(start).map((h) => h.content);
    if (rest.every((c, i) => c === want[i])) break;
    start++;
  }
  const remaining = have.slice(start);
  if (remaining.every((h, i) => h.content === want[i])) {
    if (start) await db.from("product_stock").delete().in("id", have.slice(0, start).map((h) => h.id));
    keep = remaining.length;
  } else {
    if (have.length) await db.from("product_stock").delete().eq("product_id", pid);
    keep = 0;
  }
  const add = want.slice(keep);
  for (let i = 0; i < add.length; i += 500) {
    await db.from("product_stock").insert(add.slice(i, i + 500).map((content) => ({ product_id: pid, content })));
  }
}

/* ---------------- whole-collection reads ---------------- */

async function readTop(top: string): Promise<Json> {
  const db = await sb();
  if (top === "users") {
    const [rows, hist, alerts] = await Promise.all([
      fetchAll((f, t) => db.from("customers").select("*").order("legacy_uid").range(f, t)),
      fetchAll((f, t) => db.from("wallet_history").select("*").order("created_at").range(f, t)),
      fetchAll((f, t) => db.from("customer_alerts").select("*").order("created_at").range(f, t)),
    ]);
    const hBy = groupBy(hist, "customer_id");
    const aBy = groupBy(alerts, "customer_id");
    const out: any = {};
    for (const r of rows) {
      const uid = r.legacy_uid || r.id;
      customerIds.set(uid, r.id);
      out[uid] = rowToUser(r, hBy.get(r.id) || [], aBy.get(r.id) || []);
    }
    return prune(out) ?? null;
  }
  if (top === "products") {
    const [rows, stock] = await Promise.all([
      fetchAll((f, t) => db.from("products").select("*").order("id").range(f, t)),
      fetchAll((f, t) => db.from("product_stock").select("product_id, content").order("id").range(f, t)),
    ]);
    const sBy = groupBy(stock, "product_id");
    return prune(Object.fromEntries(rows.map((r) => [r.id, rowToProduct(r, (sBy.get(r.id) || []).map((s) => s.content))]))) ?? null;
  }
  if (top === "orders") {
    const rows = await fetchAll((f, t) => db.from("orders").select("*, customers(legacy_uid)").order("id").range(f, t));
    return prune(Object.fromEntries(rows.map((r) => [r.id, rowToOrder(r)]))) ?? null;
  }
  if (top === "site_settings") {
    const rows = await fetchAll((f, t) => db.from("settings").select("*").order("key").range(f, t));
    return prune(Object.fromEntries(rows.map((r) => [r.key, unwrapSetting(r.value)]))) ?? null;
  }
  const rows = await fetchAll((f, t) =>
    db.from("kv_store").select("path, value").or(`path.eq.${top},path.like.${top}/%`).order("path").range(f, t),
  );
  const whole = rows.find((r) => r.path === top);
  if (whole) return whole.value;
  return prune(Object.fromEntries(rows.map((r) => [r.path.slice(top.length + 1), r.value]))) ?? null;
}

function groupBy(rows: any[], col: string): Map<string, any[]> {
  const m = new Map<string, any[]>();
  for (const r of rows) {
    const k = r[col];
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

/* ---------------- public Firebase-style API ---------------- */

export async function cloudGet<T = any>(path: string): Promise<T | null> {
  const [top, key, ...rest] = split(path);
  if (!top) throw new Error("Reading the whole database is not supported");
  if (!key) return (await readTop(top)) as T | null;
  // Fast path: a single scalar column on a customer, e.g. users/<uid>/wallet
  const node = await readNode(top, key);
  return getAt(node.value, rest) as T | null;
}

async function writeTop(top: string, value: Json): Promise<void> {
  // Replace a whole collection: write every child, delete the rest.
  const current = (await readTop(top)) || {};
  const next = prune(value) || {};
  for (const k of Object.keys(current)) if (!(k in next)) await writeNode(top, k, null);
  for (const [k, v] of Object.entries(next)) await writeNode(top, k, v);
}

export async function cloudPut(path: string, value: unknown): Promise<void> {
  const [top, key, ...rest] = split(path);
  if (!top) throw new Error("Writing the whole database is not supported");
  if (!key) return writeTop(top, value);
  if (!rest.length) {
    await writeNode(top, key, value);
    return;
  }
  await cloudTransact(path, () => (value === null ? null : (value as Json)) as any);
}

export async function cloudPatch(path: string, value: Record<string, unknown>): Promise<void> {
  // Group every patched location by the row it belongs to: one write per row.
  const groups = new Map<string, Array<[string[], Json]>>();
  for (const [k, v] of Object.entries(value || {})) {
    const parts = split(`${path}/${k}`);
    if (parts.length < 2) {
      await cloudPatch(parts[0]!, (v || {}) as Record<string, unknown>);
      continue;
    }
    const id = `${parts[0]}/${parts[1]}`;
    const list = groups.get(id) || [];
    list.push([parts.slice(2), v]);
    groups.set(id, list);
  }
  await Promise.all(
    [...groups].map(([id, sets]) =>
      cloudTransact(id, (cur: Json) => {
        let next = cur;
        for (const [rest, v] of sets) next = setAt(next, rest, v === undefined ? null : v);
        return next;
      }),
    ),
  );
}

export async function cloudPush(path: string, value: unknown): Promise<string> {
  const id = pushId();
  const parts = split(path);
  // Wallet history entries go straight in as one row (no full customer rewrite).
  if (parts.length === 3 && parts[0] === "users" && parts[2] === "history") {
    const cid = await customerId(parts[1]!);
    if (cid) {
      const { error } = await (await sb()).from("wallet_history").insert(historyRow(cid, id, value));
      if (error) throw new Error(`Cloud write failed: ${error.message}`);
      return id;
    }
  }
  if (parts.length === 1 && !TABLE_TOPS.has(parts[0]!)) {
    await writeNode(parts[0]!, id, value);
    return id;
  }
  await cloudPut(`${path}/${id}`, value);
  return id;
}

export async function cloudCreateIfAbsent(path: string, value: unknown): Promise<boolean> {
  let created = false;
  await cloudTransact(path, (cur: Json) => {
    if (cur !== null) return undefined;
    created = true;
    return value as Json;
  });
  return created;
}

export async function cloudTransact<T, R = T>(
  path: string,
  update: (current: T | null) => R | undefined,
  tries = 8,
): Promise<R | undefined> {
  const [top, key, ...rest] = split(path);
  if (!top || !key) throw new Error("Transactions need a record path");
  for (let i = 0; i < tries; i++) {
    const node = await readNode(top, key);
    const cur = getAt(node.value, rest) as T | null;
    const next = update(cur);
    if (next === undefined) return undefined;
    const whole = rest.length ? setAt(node.value, rest, next === null ? null : next) : next;
    if (await writeNode(top, key, whole, { stamp: node.stamp })) return next;
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 120));
  }
  throw new Error("Busy — please try again");
}

/** Which data store the server uses. Flip DATA_BACKEND=cloud at switch-over. */
export function usingCloud(): boolean {
  return true; // Firebase is retired; Lovable Cloud is the only database.
}
