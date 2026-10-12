import type { StoreSnapshot } from "./store-snapshot.functions";

const EMPTY: StoreSnapshot = { products: {}, config: {}, banner: {}, flashSale: null, emojis: {}, prodEmojis: {} };

let cache: { at: number; data: StoreSnapshot } | null = null;
const TTL = 20_000;

async function read(path: string) {
  try {
    const { cloudGet } = await import("./cloud-db.server");
    return await cloudGet(path);
  } catch {
    return null;
  }
}

// Secret settings (bot token, payment and supplier keys) never leave the server.
const SECRET_CONFIG = /(secret|token|apikey|password|smtp)/i;
const SECRET_EXTRA = new Set(["supplierApiUrl", "notifyGroup", "telegramOwners"]);
function publicConfig(c: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries((c || {}) as Record<string, any>)) {
    if (SECRET_CONFIG.test(k) || SECRET_EXTRA.has(k)) continue;
    out[k] = v;
  }
  return out;
}

let loading: Promise<StoreSnapshot> | null = null;

/** Public values that may come from env when Settings leaves them empty. */
async function withEnvFallbacks(c: Record<string, any>): Promise<Record<string, any>> {
  if (!c["depositAddress"]) {
    const { defaultDepositAddress } = await import("./deposit.server");
    const addr = defaultDepositAddress();
    if (addr) c["depositAddress"] = addr;
  }
  return c;
}

async function build(): Promise<StoreSnapshot> {
  const [rawProducts, config, banner, flashSale, emojis, prodEmojis] = await Promise.all([
    read("products"),
    read("site_settings/config"),
    read("site_settings/banner"),
    read("site_settings/flash_sale"),
    read("telegramEmoji/slots"),
    read("telegramEmoji/products"),
  ]);

  // Stock lists and delivered-stock records are admin-only and can be large.
  const products: Record<string, any> = {};
  for (const [id, p] of Object.entries((rawProducts || {}) as Record<string, any>)) {
    if (!p || typeof p !== "object") continue;
    const { stock, usedStock, ...rest } = p as Record<string, any>;
    const left = Array.isArray(stock) ? stock.filter(Boolean).length : 0;
    if (typeof rest["logo"] === "string" && (rest["logo"] as string).startsWith("data:")) {
      rest["logo"] = `/api/public/product-img/${id}`;
    }
    products[id] = left ? { ...rest, stock: Array.from({ length: left }, () => "1") } : rest;
  }

  const data: StoreSnapshot = {
    ...EMPTY,
    products,
    config: await withEnvFallbacks(publicConfig(config)),
    banner: banner || {},
    flashSale: flashSale || null,
    emojis: emojis || {},
    prodEmojis: prodEmojis || {},
  };
  // Don't replace good data with an empty result from a failed read.
  if (rawProducts || !cache) cache = { at: Date.now(), data };
  return cache.data;
}

function refresh() {
  loading ||= build().finally(() => {
    loading = null;
  });
  return loading;
}



export async function storeSnapshot(): Promise<StoreSnapshot> {
  // Serve the saved copy instantly and refresh it in the background when old.
  if (cache) {
    if (Date.now() - cache.at >= TTL) void refresh().catch(() => undefined);
    return cache.data;
  }
  return refresh();
}
