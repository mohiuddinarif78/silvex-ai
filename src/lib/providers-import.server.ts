/** Importing, pruning and syncing supplier shop products. */
import { dbGet, dbPatch, dbPut } from "./telegram.server";
import {
  PROVIDERS,
  RETIRED_PROVIDERS,
  apiCategoryName,
  apiProductKey,
  cleanText,
  keepByList,
  providerConfig,
  providerKeepList,
  providerProducts,
  sellPrice,
  type ApiProduct,
} from "./providers.server";

type Announcement = { kind: "new" | "restock"; id: string; left: number; added?: number };

/** A stock jump this big (or more) at the supplier is announced as new stock. */
const MIN_STOCK_JUMP = 5;

/**
 * Bot announcements for supplier changes run one after another in the
 * background, so the sync itself never waits on a long broadcast.
 */
let announceChain: Promise<void> = Promise.resolve();
function queueAnnouncements(list: Announcement[]) {
  if (!list.length) return;
  announceChain = announceChain.then(async () => {
    const { announce, announceDigest } = await import("./broadcast.server");
    // Many changes from one sync go out as ONE combined message, so users are
    // not flooded and the bot is never stuck in back-to-back broadcasts.
    if (list.length > 1) {
      await announceDigest(list).catch((e) => console.error("supplier digest failed", e));
      return;
    }
    const a = list[0]!;
    await announce(a.kind, a.id, { left: a.left, ...(a.added ? { added: a.added } : {}) }).catch((e) =>
      console.error("supplier announce failed", a.id, e),
    );
  });
}

/** Stock top-ups of the same product are announced at most once per this window. */
const TOPUP_COOLDOWN_MS = 3 * 60 * 60 * 1000;
function recentlyAnnounced(p: any): boolean {
  const ts = Number(String(p?.lastBroadcast || "").split(":")[1] || 0);
  return ts > 0 && Date.now() - ts < TOPUP_COOLDOWN_MS;
}

/** Decide whether a supplier stock change should be told to bot users. */
function stockAnnouncement(id: string, p: any, before: number, after: number): Announcement | null {
  if (!p || p.hidden || p.botHidden || after <= 0 || after >= 9999) {
    // Unlimited items: only announce when they come back from sold out.
    if (p && !p.hidden && !p.botHidden && after >= 9999 && before <= 0) return { kind: "restock", id, left: after };
    return null;
  }
  if (before <= 0) return { kind: "restock", id, left: after };
  if (after - before >= MIN_STOCK_JUMP && !recentlyAnnounced(p)) return { kind: "restock", id, left: after, added: after - before };
  return null;
}

/**
 * Import every product of a provider into the shop.
 * Existing items are refreshed (price/stock/description) and keep their
 * profit % and hidden flag. Imported products are locked (cannot be deleted).
 */
export async function importProvider(
  id: string,
): Promise<{ added: number; updated: number; removed: number }> {
  const cfg = await providerConfig(id);
  const [all, existing, category, keep, deleted] = await Promise.all([
    providerProducts(id),
    dbGet<Record<string, any>>("products"),
    apiCategoryName(),
    providerKeepList(id),
    dbGet<Record<string, boolean>>("site_settings/apiDeleted").catch(() => null),
  ]);
  // Items the admin deleted by hand never come back on the next import.
  const list = all.filter(
    (p) => keepByList(p.name, keep) && !(deleted || {})[apiProductKey(cfg.id, p.id)],
  );
  const wanted = new Set(list.map((p) => apiProductKey(cfg.id, p.id)));
  let added = 0;
  let updated = 0;
  let removed = 0;

  // Ghost rows (a product deleted while a supplier sync patch was mid-flight:
  // price/stock only, no title) are cleaned up here too, not just in
  // syncAllProviders — otherwise they linger as blank "Item" buttons / empty
  // cards. A title-less row reads back as delivery "manual", so match on the
  // missing title alone (real products always have a title).
  for (const [key, p] of Object.entries(existing || {})) {
    if (p && String(p.title || "").trim() === "") {
      await dbPut(`products/${key}`, null);
      delete (existing as any)[key];
      removed++;
    }
  }

  // Drop anything from this provider that is no longer on the keep list.
  for (const [key, p] of Object.entries(existing || {})) {
    if (!p || p.delivery !== "supplier") continue;
    if (String(p.provider || "custom") !== cfg.id) continue;
    if (wanted.has(key)) continue;
    await dbPut(`products/${key}`, null);
    removed++;
  }

  const news: Announcement[] = [];
  for (const sp of list) {
    const key = apiProductKey(cfg.id, sp.id);
    const cur = (existing || {})[key];
    const markup = Number(cur?.markup) || cfg.markup;
    const base = {
      delivery: "supplier" as const,
      provider: cfg.id,
      providerName: cfg.name,
      supplierId: sp.id,
      markup,
      price: sellPrice(sp.price, markup),
      supplierPrice: sp.price,
      supplierStock: sp.unlimited ? 9999 : sp.stock,
      supplierSyncedAt: new Date().toISOString(),
      locked: true,
    };
    if (cur) {
      // Keep whatever the admin renamed / re-categorised / re-imaged.
      await dbPatch(`products/${key}`, {
        ...base,
        ...(cur.title ? {} : { title: sp.name }),
        ...(cur.desc ? {} : { desc: sp.description || "" }),
        ...(cur.type ? {} : { type: category }),
        ...(cur.logo || !sp.image ? {} : { logo: sp.image }),
      });
      updated++;
      const a = stockAnnouncement(key, cur, Number(cur.supplierStock ?? 0), Number(base.supplierStock || 0));
      if (a) news.push(a);
    } else {
      await dbPut(`products/${key}`, {
        ...base,
        title: sp.name,
        desc: sp.description || "",
        type: category,
        ...(sp.image ? { logo: sp.image } : {}),
        // New LinkedIn plans join the shared LinkedIn folder automatically.
        ...(/linked\s*in/i.test(sp.name || "") ? { group: "LinkedIn" } : {}),
        hidden: false,
        salesCount: 0,
      });
      added++;
      if (Number(base.supplierStock || 0) > 0)
        news.push({ kind: "new", id: key, left: Number(base.supplierStock) });
    }
  }

  await dbPatch(`site_settings/providers/${cfg.id}`, {
    imported_at: new Date().toISOString(),
    imported_count: list.length,
  });
  queueAnnouncements(news);
  return { added, updated, removed };
}

/** Delete every imported API product that is not on its provider's keep list. */
export async function pruneImportedProducts(): Promise<{
  removed: number;
  kept: number;
  titles: string[];
}> {
  const products = (await dbGet<Record<string, any>>("products")) || {};
  const keeps = new Map<string, string[]>();
  let removed = 0;
  let kept = 0;
  const titles: string[] = [];
  for (const [key, p] of Object.entries(products)) {
    if (!p || p.delivery !== "supplier") continue;
    const pid = String(p.provider || "custom");
    if (RETIRED_PROVIDERS.includes(pid)) {
      await dbPut(`products/${key}`, null);
      titles.push(String(p.title || key));
      removed++;
      continue;
    }
    if (!keeps.has(pid)) keeps.set(pid, await providerKeepList(pid));
    const name = `${p.title || ""} ${p.desc || ""}`;
    if (keepByList(name, keeps.get(pid) || [])) {
      kept++;
      continue;
    }
    await dbPut(`products/${key}`, null);
    titles.push(String(p.title || key));
    removed++;
  }
  return { removed, kept, titles };
}


/** Refresh price and stock of every linked product, per provider. */
export async function syncAllProviders(force = true): Promise<{
  updated: { id: string; title: string; price: number; stock: number }[];
}> {
  if (!force) {
    const last = await dbGet<string>("site_settings/supplier_synced_at");
    if (last && Date.now() - new Date(last).getTime() < 60 * 1000) return { updated: [] };
  }
  await dbPatch("site_settings", { supplier_synced_at: new Date().toISOString() });

  const products = (await dbGet<Record<string, any>>("products")) || {};
  const deleted = (await dbGet<Record<string, boolean>>("site_settings/apiDeleted").catch(() => null)) || {};
  // Ghost rows (deleted mid-sync: price only, no title) are cleaned up, never
  // refreshed. A title-less row reads back as delivery "manual", so match on
  // the missing title alone — real products always have a title.
  for (const [id, p] of Object.entries(products)) {
    if (p && String(p.title || "").trim() === "") {
      await dbPut(`products/${id}`, null);
      delete (products as any)[id];
    }
  }
  // Products from removed shops are deleted, not just left stale.
  for (const [id, p] of Object.entries(products)) {
    if (p && p.delivery === "supplier" && RETIRED_PROVIDERS.includes(String(p.provider || ""))) {
      await dbPut(`products/${id}`, null);
      delete (products as any)[id];
    }
  }
  const linked = Object.entries(products).filter(
    ([id, p]) =>
      p &&
      p.delivery === "supplier" &&
      String(p.supplierId ?? "").trim() !== "" &&
      !deleted[id],
  );
  // Load every switched-on shop, so products saved without a shop name
  // (older items, or the removed "custom" one) are still refreshed.
  const providers = new Set(
    linked
      .map(([, p]) => String(p.provider || ""))
      .filter((pid) => pid && !RETIRED_PROVIDERS.includes(pid)),
  );
  for (const def of PROVIDERS) {
    const cfg = await providerConfig(def.id).catch(() => null);
    if (cfg && cfg.enabled) providers.add(def.id);
  }
  const catalogues = new Map<string, Map<string, ApiProduct>>();
  await Promise.all(
    [...providers].map(async (pid) => {
      try {
        const items = await providerProducts(pid);
        catalogues.set(pid, new Map(items.map((i) => [String(i.id), i])));
      } catch {
        /* provider down — keep old values */
      }
    }),
  );

  const updated: { id: string; title: string; price: number; stock: number }[] = [];
  const news: Announcement[] = [];
  for (const [id, p] of linked) {
    const sid = String(p.supplierId);
    // The product key (api_<shop>_<id>) is the truth for which shop it belongs to.
    const keyShop = PROVIDERS.find((d) => id.startsWith(`api_${d.id}_`))?.id;
    let pid = keyShop || String(p.provider || "");
    if (keyShop && p.provider !== keyShop) await dbPatch(`products/${id}`, { provider: keyShop });
    let sp = catalogues.get(pid)?.get(sid);
    // Only guess another shop when this item has no valid shop at all —
    // shops reuse the same item numbers, so guessing would swap products.
    const known = PROVIDERS.some((d) => d.id === pid);
    if (!sp && !known) {
      // Find the shop this item actually comes from and remember it.
      for (const [otherId, cat] of catalogues) {
        const hit = cat.get(sid);
        if (hit) {
          sp = hit;
          pid = otherId;
          await dbPatch(`products/${id}`, { provider: otherId });
          break;
        }
      }
    }
    if (!sp) {
      // Shop answered but no longer sells this item: show it as out of stock
      // instead of keeping old stock that can never be delivered.
      if (catalogues.has(pid) && (Number(p.supplierStock ?? 0) > 0 || !p.soldOut)) {
        await dbPatch(`products/${id}`, {
          supplierStock: 0,
          soldOut: true,
          supplierSyncedAt: new Date().toISOString(),
        });
        updated.push({ id, title: String(p.title || sid), price: Number(p.price) || 0, stock: 0 });
      }
      continue;
    }
    const price = sellPrice(sp.price, Number(p.markup) || 130);
    const stock = sp.unlimited ? 9999 : Math.max(0, sp.stock);
    const desc = String(sp.description || "").trim();
    await dbPatch(`products/${id}`, {
      price,
      supplierPrice: sp.price,
      supplierStock: stock,
      // Sold-out badge follows the shop's real stock.
      soldOut: stock <= 0,
      supplierSyncedAt: new Date().toISOString(),
      // Keep the shop description in step with the supplier's own text,
      // unless the admin wrote their own (descEdited).
      ...(desc && !p.descEdited ? { desc } : {}),
    });
    // Back in stock, or a fresh batch added at the provider: tell every bot user.
    const a = stockAnnouncement(id, p, Number(p.supplierStock ?? 0), stock);
    if (a) news.push(a);
    updated.push({ id, title: String(p.title || sp.name), price, stock });
  }
  queueAnnouncements(news);
  return { updated };
}
