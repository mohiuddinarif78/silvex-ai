import { dbGet, dbPatch, dbPut } from "./telegram.server";

/**
 * Reseller API providers (supplier shops we buy from).
 * Every value here is only a fallback — the admin panel can change the name,
 * base URL, key, profit % and whether a provider is on, in site_settings/providers.
 */
export type ProviderId = "qamify" | "safwan" | "mmostore" | "w2premium" | "eklas" | "elite" | "canboso" | "pandora" | "safwantiger" | "cupponhub" | "custom";

/** Shops that were removed — their imported products get cleaned up. */
export const RETIRED_PROVIDERS = ["canboso", "custom", "elite", "w2premium", "safwan", "pandora"];

export type ProviderShape = {
  productsPath: string;
  balancePath: string;
  orderPath: string;
  /** how the order body names its fields */
  qtyField: "qty" | "quantity";
  refField: "idempotency_key" | "client_order_id" | "request_id" | "client_order_reference" | "";
  /** provider requires product_id as a string (no numeric conversion) */
  stringProductId?: boolean;
  /** provider needs the Idempotency-Key header instead of a body field */
  idempotencyHeader?: boolean;
  /** extra fields always sent with an order (e.g. currency) */
  orderExtra?: Record<string, unknown>;
};

export type ProviderDef = {
  id: ProviderId;
  name: string;
  url: string;
  key: string;
  docs: string;
  markup: number;
  shape: ProviderShape;
};

export const PROVIDERS: ProviderDef[] = [
  {
    id: "qamify",
    name: "Qamify",
    url: process.env["PROVIDER_QAMIFY_URL"] || "https://api.qamify.site/v1",
    key: process.env["PROVIDER_QAMIFY_KEY"] || "",
    docs: "https://api.qamify.site/docs",
    markup: 130,
    shape: {
      productsPath: "products",
      balancePath: "balance",
      orderPath: "orders",
      qtyField: "qty",
      refField: "",
      idempotencyHeader: true,
    },
  },
  {
    id: "mmostore",
    name: "MMO Store",
    url: process.env["PROVIDER_MMOSTORE_URL"] || "https://api.mmostore.qzz.io",
    key: process.env["PROVIDER_MMOSTORE_KEY"] || "",
    docs: "https://api.mmostore.qzz.io/apidocumentation",
    markup: 130,
    shape: {
      productsPath: "api/v1/products",
      balancePath: "api/v1/balance",
      orderPath: "api/v1/orders",
      qtyField: "quantity",
      refField: "client_order_id",
    },
  },
  {
    id: "safwantiger",
    name: "Safwan Tiger Shop",
    url: process.env["PROVIDER_SAFWANTIGER_URL"] || "https://safwantigershopbot-production.up.railway.app/api",
    key: process.env["PROVIDER_SAFWANTIGER_KEY"] || "",
    docs: "https://safwantigershopbot-production.up.railway.app/api",
    markup: 130,
    shape: {
      productsPath: "products",
      balancePath: "balance",
      orderPath: "order",
      qtyField: "quantity",
      refField: "",
    },
  },
  {
    id: "cupponhub",
    name: "CupponHub",
    url: process.env["PROVIDER_CUPPONHUB_URL"] || "https://cupponhub.shop/reseller/api",
    key: process.env["PROVIDER_CUPPONHUB_KEY"] || "",
    docs: "https://cupponhub.shop/reseller/api/docs/",
    markup: 130,
    shape: {
      productsPath: "?action=products",
      balancePath: "?action=balance",
      orderPath: "?action=purchase",
      qtyField: "quantity",
      refField: "",
      stringProductId: true,
      idempotencyHeader: true,
    },
  },
  {
    id: "eklas",
    name: "Eklas",
    url: process.env["PROVIDER_EKLAS_URL"] || "https://api.eklas.dev/v1",
    key: process.env["PROVIDER_EKLAS_KEY"] || "",
    docs: "https://docs.eklas.dev",
    markup: 130,
    shape: {
      productsPath: "products",
      balancePath: "balance",
      orderPath: "orders",
      qtyField: "quantity",
      refField: "client_order_id",
    },
  },
];

export function providerDef(id: string): ProviderDef | null {
  return PROVIDERS.find((p) => p.id === id) || null;
}

export type ProviderSettings = {
  id: ProviderId;
  name: string;
  url: string;
  key: string;
  docs: string;
  markup: number;
  enabled: boolean;
  shape: ProviderShape;
};

/** Admin-saved settings merged over the built-in fallbacks. */
export async function providerConfig(id: string): Promise<ProviderSettings> {
  const def = providerDef(id);
  const saved = (await dbGet<Record<string, any>>(`site_settings/providers/${id}`)) || {};
  if (id === "custom" || !def) {
    const c = (await dbGet<Record<string, string>>("site_settings/config")) || {};
    return {
      id: "custom",
      name: saved["name"] || "Custom supplier",
      url: String(saved["url"] || c["supplierApiUrl"] || process.env["SUPPLIER_API_URL"] || "").replace(/\/+$/, ""),
      key: String(saved["key"] || c["supplierApiKey"] || process.env["SUPPLIER_API_KEY"] || ""),
      docs: String(saved["docs"] || ""),
      markup: Number(saved["markup"]) || 130,
      enabled: saved["enabled"] !== false,
      shape: {
        productsPath: "products",
        balancePath: "balance",
        orderPath: "order",
        qtyField: "quantity",
        refField: "request_id",
      },
    };
  }
  return {
    id: def.id,
    name: String(saved["name"] || def.name),
    url: String(saved["url"] || def.url).replace(/\/+$/, ""),
    key: String(saved["key"] || def.key),
    docs: String(saved["docs"] || def.docs),
    markup: Number(saved["markup"]) || def.markup,
    enabled: saved["enabled"] !== false,
    shape: def.shape,
  };
}

export async function saveProviderConfig(
  id: string,
  patch: { name?: string; url?: string; key?: string; markup?: number; enabled?: boolean },
): Promise<void> {
  const clean: Record<string, unknown> = {};
  if (patch.name !== undefined) clean["name"] = String(patch.name).trim();
  if (patch.url !== undefined) clean["url"] = String(patch.url).trim().replace(/\/+$/, "");
  if (patch.key !== undefined) clean["key"] = String(patch.key).trim();
  if (patch.markup !== undefined) clean["markup"] = Math.max(100, Number(patch.markup) || 130);
  if (patch.enabled !== undefined) clean["enabled"] = Boolean(patch.enabled);
  await dbPatch(`site_settings/providers/${id}`, clean);
}

/**
 * Only these items are kept from each provider's catalogue.
 * Matching is a case-insensitive "name contains keyword" check.
 * Admin can override the list in site_settings/providers/{id}/keep (array of words).
 */
export const PROVIDER_KEEP: Record<string, string[]> = {
  // Qamify: keep the whole catalogue (admin can hide or delete items).
  qamify: [],
  // MMO Store: only Gemini and Outlook accounts.
  mmostore: ["gemini", "outlook"],
};

/** Admin-editable keep list for a provider (empty list = keep everything). */
export async function providerKeepList(id: string): Promise<string[]> {
  const saved = await dbGet<string[] | string>(`site_settings/providers/${id}/keep`).catch(
    () => null,
  );
  const list = Array.isArray(saved)
    ? saved
    : typeof saved === "string"
      ? saved.split(",")
      : PROVIDER_KEEP[id] || [];
  return list.map((s) => String(s).toLowerCase().trim()).filter(Boolean);
}

export function keepByList(name: string, keep: string[]): boolean {
  if (!keep.length) return true;
  const n = String(name || "").toLowerCase();
  return keep.some((k) => n.includes(k));
}

export type ApiProduct = {
  id: string | number;
  name: string;
  price: number;
  stock: number;
  unlimited?: boolean;
  description?: string;
  image?: string;
};

function num(v: unknown): number {
  if (typeof v === "number") return v;
  const n = parseFloat(String(v ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function pickPrice(p: any): number {
  // Some shops send price as an object: { amount: 0.34, currency: "USD" }
  if (p?.price && typeof p.price === "object" && num(p.price.amount) > 0) return num(p.price.amount);
  if (p?.price != null && num(p.price) > 0) return num(p.price);
  if (p?.price_usd != null && num(p.price_usd) > 0) return num(p.price_usd);
  if (p?.price_usdt_from != null && num(p.price_usdt_from) > 0) return num(p.price_usdt_from);
  if (p?.price_usdt != null && num(p.price_usdt) > 0) return num(p.price_usdt);
  if (p?.unit_price != null && num(p.unit_price) > 0) return num(p.unit_price);
  if (p?.price_cents != null) return num(p.price_cents) / 100;
  if (p?.unit_price_cents != null) return num(p.unit_price_cents) / 100;
  return 0;
}

function pickStock(p: any): { stock: number; unlimited: boolean } {
  if (p?.availability?.available != null)
    return { stock: Math.max(0, Math.floor(num(p.availability.available))), unlimited: false };
  for (const k of ["stock", "stock_available", "available_stock", "quantity", "stock_count"]) {
    if (p?.[k] != null && p[k] !== "") return { stock: Math.max(0, Math.floor(num(p[k]))), unlimited: false };
  }
  if (p?.unlimited_stock) return { stock: 9999, unlimited: true };
  if (p?.in_stock === true) return { stock: 9999, unlimited: true };
  return { stock: 0, unlimited: false };
}

export function cleanText(s: string): string {
  return String(s || "")
    .replace(/\{\{ce:\d+\|([^}]*)\}\}/g, "$1")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .trim();
}

/** Sell price = supplier price × profit %, rounded up to cents. */
export function sellPrice(supplier: number, markup: number): number {
  const pct = Number(markup) > 0 ? Number(markup) : 130;
  return Math.ceil(Number(supplier || 0) * pct) / 100;
}

async function call(
  cfg: ProviderSettings,
  path: string,
  init?: RequestInit & { idempotency?: string },
): Promise<any> {
  if (!cfg.url || !cfg.key) throw new Error(`${cfg.name}: API address or key is missing`);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.key}`,
    // Only once: sending x-api-key twice makes fetch join them with a comma,
    // which shops read as an invalid key.
    "x-api-key": cfg.key,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (init?.idempotency) headers["Idempotency-Key"] = init.idempotency;
  const res = await fetch(`${cfg.url}/${path.replace(/^\/+/, "")}`, {
    method: init?.method || "GET",
    ...(init?.body ? { body: init.body } : {}),
    headers: { ...headers, ...((init?.headers as Record<string, string>) || {}) },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!res.ok || body?.ok === false || body?.success === false) {
    const msg =
      body?.error?.message || body?.error || body?.message || `${cfg.name} error ${res.status}`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return body;
}

export async function providerProducts(id: string): Promise<ApiProduct[]> {
  const cfg = await providerConfig(id);
  const body = await call(cfg, cfg.shape.productsPath);
  const list = body?.products || body?.data || body?.items || [];
  const origin = (() => {
    try {
      return new URL(cfg.url).origin;
    } catch {
      return "";
    }
  })();
  return (Array.isArray(list) ? list : []).map((p: any) => {
    const s = pickStock(p);
    // Different shops name the product identifier differently. CupponHub uses
    // `key` (e.g. "gemini_link"); others use id / product_id / sku / slug.
    const raw = String(p.id ?? p.productId ?? p.product_id ?? p.key ?? p.sku ?? p.slug ?? "");
    let img = String(p.image_url ?? p.image ?? p.photo ?? "");
    if (img.startsWith("/")) img = origin + img;
    return {
      id: /^\d+$/.test(raw) ? Number(raw) : raw,
      name: String(p.name_en ?? p.name ?? p.title ?? `#${raw}`),
      price: pickPrice(p),
      stock: s.stock,
      unlimited: s.unlimited,
      description: cleanText(String(p.description_en ?? p.description ?? "")),
      image: img,
    };
  });
}

export async function providerBalance(
  id: string,
): Promise<{ balance: number; currency: string }> {
  const cfg = await providerConfig(id);
  const body = await call(cfg, cfg.shape.balancePath);
  const w = body?.wallet || body?.data || body;
  const balance =
    w?.balance != null
      ? num(w.balance)
      : w?.available_balance != null
        ? num(w.available_balance)
        : w?.balance_usdt != null
          ? num(w.balance_usdt)
          : w?.balance_usd != null
            ? num(w.balance_usd)
          : w?.balance_cents != null
            ? num(w.balance_cents) / 100
            : 0;
  return { balance, currency: String(w?.currency || body?.currency || "USD") };
}

function collectItems(body: any): string[] {
  const out: string[] = [];
  const seen = new Set<any>();
  const keys = /^(items|credentials|codes|keys|delivered|deliveries|content|contents|accounts|lines)$/i;
  const walk = (node: any, keyed: boolean) => {
    if (node == null || out.length > 200) return;
    if (typeof node === "string") {
      if (keyed && node.trim()) out.push(node.trim());
      return;
    }
    if (Array.isArray(node)) {
      for (const it of node) {
        if (typeof it === "string") {
          if (keyed && it.trim()) out.push(it.trim());
        } else if (it && typeof it === "object") {
          const v =
            it.content ?? it.credential ?? it.code ?? it.key ?? it.data ?? it.item ?? it.value ?? it.text;
          if (typeof v === "string" && v.trim()) out.push(v.trim());
          else walk(it, keyed);
        }
      }
      return;
    }
    if (typeof node === "object") {
      if (seen.has(node)) return;
      seen.add(node);
      for (const [k, v] of Object.entries(node)) walk(v, keyed || keys.test(k));
    }
  };
  walk(body, false);
  return [...new Set(out)];
}

/** Buy from a provider and return the delivered lines. */
export async function providerBuy(
  id: string,
  productId: string | number,
  qty: number,
  reference: string,
): Promise<string[]> {
  const cfg = await providerConfig(id);
  if (!cfg.enabled) throw new Error(`${cfg.name} is turned off`);
  const raw = String(productId);
  const pid =
    cfg.shape.stringProductId || !/^\d+$/.test(raw) ? raw : Number(raw);
  const amount = Math.max(1, Number(qty) || 1);
  const body: Record<string, unknown> = {
    product_id: pid,
    // some shops name it productId or product — harmless extra fields for the others
    productId: pid,
    product: pid,
    // Shops differ on "qty" vs "quantity" — send both so bulk orders are never
    // silently treated as a single item.
    qty: amount,
    quantity: amount,
    ...(cfg.shape.orderExtra || {}),
  };
  if (cfg.shape.refField) body[cfg.shape.refField] = reference;
  const res = await call(cfg, cfg.shape.orderPath, {
    method: "POST",
    body: JSON.stringify(body),
    ...(cfg.shape.idempotencyHeader ? { idempotency: reference } : {}),
  });
  const lines = collectItems(res);
  if (!lines.length) throw new Error(`${cfg.name} did not return any item`);
  return lines;
}

/**
 * Work out which shop a linked product really belongs to.
 * Older products were saved without a shop name (or with the removed "custom"
 * one), which made both the stock refresh and the automatic delivery fail.
 * We look the supplier item up in every switched-on shop and use that one.
 */
export async function resolveProviderFor(
  supplierId: string | number,
  current?: string,
): Promise<string> {
  const cur = String(current || "").trim();
  if (cur && providerDef(cur) && !RETIRED_PROVIDERS.includes(cur)) return cur;
  const sid = String(supplierId).trim();
  if (!sid) return cur || "custom";
  for (const def of PROVIDERS) {
    try {
      const cfg = await providerConfig(def.id);
      if (!cfg.enabled) continue;
      const items = await providerProducts(def.id);
      if (items.some((i) => String(i.id) === sid)) return def.id;
    } catch {
      /* shop down — try the next one */
    }
  }
  return cur || "custom";
}

/** Firebase-safe product key for an imported provider item. */
export function apiProductKey(provider: string, id: string | number): string {
  return `api_${provider}_${String(id).replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** Category (folder) the imported API products live in, created if missing. */
export async function apiCategoryName(): Promise<string> {
  const c = (await dbGet<Record<string, any>>("site_settings/config")) || {};
  const label = String(c["apiCategory"] || "Reseller API");
  const cats = Array.isArray(c["categories"]) ? c["categories"] : [];
  if (!cats.some((x: any) => String(x?.label || "") === label)) {
    await dbPatch("site_settings/config", {
      categories: [...cats, { label, icon: "🔑" }],
    });
  }
  return label;
}
export {
  importProvider,
  pruneImportedProducts,
  syncAllProviders,
} from "./providers-import.server";
