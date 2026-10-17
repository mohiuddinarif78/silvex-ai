/**
 * Reseller API "NaN order" audit.
 *
 * Before the fix in 802ce9a, the reseller /order endpoint turned a non-numeric
 * or missing `qty` into NaN. Because every comparison with NaN is false, the
 * balance guard was skipped: orders were DELIVERED while the wallet was charged
 * $NaN (i.e. effectively never charged). The Telegram owner feed showed these
 * as "<title> ×NaN — $NaN".
 *
 * This script finds those damaged orders and quantifies the loss. It is
 * strictly READ-ONLY — it prints a report and changes nothing. Reversal /
 * clawback is a deliberate manual step after you review the output.
 *
 * It flags an order as damaged when ANY of these hold:
 *   • it came through the API (source === "api"), and
 *   • its total is non-finite / NaN / <= 0, OR
 *   • any line item has a non-finite / <= 0 qty or price.
 *
 * It separately totals the real upstream cost at risk: damaged orders whose
 * product delivery is "supplier" triggered a genuine supplier purchase that was
 * billed to you even though the customer paid nothing.
 *
 * Optional filter: pass an email or uid to limit the report to one buyer, e.g.
 *   npx tsx scripts/audit-reseller-nan-orders.ts probe.r1017@kigege.me
 *
 * By default it scans the most recent 2000 orders; override with --limit=N.
 * Run with the same server env as the app (Supabase creds / DATA_BACKEND):
 *   npx tsx scripts/audit-reseller-nan-orders.ts
 */
import { dbRecentOrders, dbGet } from "../src/lib/telegram.server";

type Item = { title?: string; qty?: unknown; price?: unknown; delivery?: string; id?: string };
type Order = {
  uid?: string;
  email?: string;
  source?: string;
  status?: string;
  total?: unknown;
  subTotal?: unknown;
  items?: Item[] | Record<string, Item>;
  delivered?: unknown[];
  date?: string;
};

/** True when a value is not a clean, finite, positive number. */
function badNumber(v: unknown): boolean {
  const n = Number(v);
  return !Number.isFinite(n) || n <= 0;
}

function itemsOf(o: Order): Item[] {
  const it = o.items;
  if (Array.isArray(it)) return it;
  if (it && typeof it === "object") return Object.values(it);
  return [];
}

function parseArgs(argv: string[]) {
  let limit = 2000;
  let filter = "";
  for (const a of argv) {
    if (a.startsWith("--limit=")) limit = Math.max(1, Number(a.slice(8)) || 2000);
    else if (!a.startsWith("--")) filter = a.trim().toLowerCase();
  }
  return { limit, filter };
}

async function main() {
  const { limit, filter } = parseArgs(process.argv.slice(2));

  const orders = (await dbRecentOrders(limit)) as Record<string, Order> | null;
  const entries = Object.entries(orders || {});

  // Cache product delivery types so we can tell which damaged orders cost real
  // money upstream (supplier) vs. gave away our own stock (auto/repeat/manual).
  const deliveryCache = new Map<string, string>();
  async function deliveryOf(item: Item): Promise<string> {
    if (item.delivery) return item.delivery;
    const id = item.id ? String(item.id) : "";
    if (!id) return "";
    if (deliveryCache.has(id)) return deliveryCache.get(id)!;
    const p = await dbGet<any>(`products/${id}`);
    const d = String(p?.delivery || "");
    deliveryCache.set(id, d);
    return d;
  }

  type Finding = {
    orderId: string;
    uid: string;
    email: string;
    status: string;
    date: string;
    reasons: string[];
    deliveredCount: number;
    supplier: boolean;
    titles: string[];
  };

  const findings: Finding[] = [];

  for (const [orderId, o] of entries) {
    if (!o || typeof o !== "object") continue;
    if (o.source !== "api") continue;

    const email = String(o.email || "").toLowerCase();
    const uid = String(o.uid || "");
    if (filter && email !== filter && uid.toLowerCase() !== filter) continue;

    const reasons: string[] = [];
    if (badNumber(o.total)) reasons.push(`total=${String(o.total)}`);
    if (o.subTotal !== undefined && badNumber(o.subTotal)) reasons.push(`subTotal=${String(o.subTotal)}`);

    const items = itemsOf(o);
    let supplier = false;
    const titles: string[] = [];
    for (const it of items) {
      titles.push(String(it.title || "Item"));
      if (badNumber(it.qty)) reasons.push(`qty=${String(it.qty)}`);
      if (badNumber(it.price)) reasons.push(`price=${String(it.price)}`);
      if ((await deliveryOf(it)) === "supplier") supplier = true;
    }

    if (!reasons.length) continue;

    const deliveredCount = Array.isArray(o.delivered) ? o.delivered.length : 0;
    findings.push({
      orderId,
      uid,
      email: String(o.email || ""),
      status: String(o.status || ""),
      date: String(o.date || ""),
      reasons: [...new Set(reasons)],
      deliveredCount,
      supplier,
      titles: [...new Set(titles)],
    });
  }

  // ---- Report ----
  console.log(`\nReseller API NaN/corrupt-order audit`);
  console.log(`Scanned ${entries.length} recent order(s)${filter ? ` filtered to "${filter}"` : ""}.`);
  console.log(`Found ${findings.length} damaged API order(s).\n`);

  if (!findings.length) {
    console.log("No damaged reseller API orders found. ✅");
    return;
  }

  findings.sort((a, b) => (a.date < b.date ? 1 : -1));

  let delivered = 0;
  let supplierDelivered = 0;
  const byUser = new Map<string, { count: number; delivered: number; supplier: number; emails: Set<string> }>();

  for (const f of findings) {
    if (f.deliveredCount > 0) delivered++;
    if (f.supplier && f.deliveredCount > 0) supplierDelivered++;
    const key = f.uid || f.email || "(unknown)";
    const agg = byUser.get(key) || { count: 0, delivered: 0, supplier: 0, emails: new Set<string>() };
    agg.count++;
    if (f.deliveredCount > 0) agg.delivered++;
    if (f.supplier && f.deliveredCount > 0) agg.supplier++;
    if (f.email) agg.emails.add(f.email);
    byUser.set(key, agg);

    console.log(
      [
        `• ${f.date || "(no date)"}  order=${f.orderId}  status=${f.status}`,
        `  buyer=${f.email || "(no email)"}  uid=${f.uid || "(none)"}`,
        `  items=${f.titles.join(", ")}`,
        `  corrupt: ${f.reasons.join(", ")}`,
        `  delivered=${f.deliveredCount} item(s)${f.supplier ? "  ⚠ SUPPLIER (real upstream cost)" : ""}`,
      ].join("\n"),
    );
  }

  console.log(`\n── Summary ──`);
  console.log(`Damaged API orders:              ${findings.length}`);
  console.log(`…that actually delivered goods:  ${delivered}  (customer got items, charged $NaN)`);
  console.log(`…of those, supplier-fulfilled:   ${supplierDelivered}  (you were billed upstream for these)`);

  console.log(`\nPer buyer:`);
  for (const [key, agg] of [...byUser.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const emails = [...agg.emails].join(", ") || "(no email)";
    console.log(
      `  ${key}  ${emails}\n    orders=${agg.count}  delivered=${agg.delivered}  supplier-delivered=${agg.supplier}`,
    );
  }

  console.log(
    `\nNote: these orders recorded total=$NaN, so an exact dollar loss can't be read\n` +
      `from the order itself. The real loss is (a) your own stock given away on the\n` +
      `${delivered} delivered orders, plus (b) the supplier invoices for the ${supplierDelivered}\n` +
      `supplier-fulfilled ones. Cross-check the supplier dashboards for those order ids.\n`,
  );
  console.log(`This was READ-ONLY. Nothing was changed.`);
}

main().catch((e) => {
  console.error("Audit failed:", e);
  process.exitCode = 1;
});
