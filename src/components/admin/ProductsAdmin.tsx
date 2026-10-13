import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { get, onValue, push, ref, remove, set, update } from "@/lib/fb/database";
import { useStore, isOwnerEmail, type Product, type Category } from "@/context/StoreContext";
import { fileToCompressedDataUrl } from "@/lib/image-upload";
import { exportOrdersCsv, exportOrdersPdf, type ExportRow } from "@/lib/export-orders";
import { sendSmtpMail } from "@/lib/mail.functions";
import { deliveryBlock, emailShell, sendMail } from "@/lib/mailer";
import { notifyTelegramOrder } from "@/lib/telegram.functions";


import { input, Stat, Empty, ImageField, emptyProduct, type OrderRow } from "@/components/admin/shared";
import { fetchSupplierCatalogue, fetchSupplierBalance, syncSupplier } from "@/lib/supplier.functions";
import { broadcastProductEvent } from "@/lib/broadcast.functions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type SupItem = { id: string | number; name: string; price: number; stock: number; unlimited_stock?: boolean; description?: string };

export function ProductsAdmin({ products }: { products: Product[] }) {
  const { db, notify, categories, config } = useStore();
  const [form, setForm] = useState(emptyProduct);
  const [bulk, setBulk] = useState("");
  const [search, setSearch] = useState("");
  const [viewing, setViewing] = useState<string | null>(null);
  const [confirmClearStock, setConfirmClearStock] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);
  const [supplier, setSupplier] = useState<SupItem[]>([]);
  const [supBusy, setSupBusy] = useState(false);
  const [supBal, setSupBal] = useState<{ balance: number; currency: string } | null>(null);
  const markupRef = useRef<Record<string, string>>({});
  const [usedMap, setUsedMap] = useState<
    Record<string, Record<string, { content: string; orderId?: string; email?: string; date?: string }>>
  >({});


  const editing = products.find((p) => p.id === form.id);
  const stockCount = Array.isArray(editing?.stock) ? editing.stock.filter(Boolean).length : 0;

  const threshold = Number((config as { lowStockAlert?: number }).lowStockAlert ?? 5);
  const lowStock = products.filter(
    (p) => p.delivery === "auto" && (p.stock || []).filter(Boolean).length <= threshold,
  );

  const linkedProducts = products.filter((p) => p.delivery === "supplier");
  const costliest = linkedProducts.reduce((m, p) => Math.max(m, Number(p.supplierPrice ?? 0)), 0);
  const cheapest = linkedProducts.length
    ? Math.min(...linkedProducts.map((p) => Number(p.supplierPrice ?? 0)))
    : 0;
  const balance = Number(supBal?.balance ?? 0);
  const balanceLow = supBal != null && linkedProducts.length > 0 && balance < costliest;
  const balanceEmpty = supBal != null && linkedProducts.length > 0 && balance < cheapest;

  async function loadBalance() {
    try {
      const r = await fetchSupplierBalance();
      if (r.ok) setSupBal({ balance: Number(r.balance || 0), currency: r.currency || "USDT" });
      else notify(r.error || "Supplier balance is unavailable");
    } catch {
      notify("Supplier balance is unavailable");
    }
  }

  useEffect(() => {
    loadBalance().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (lowStock.length)
      notify(
        `Low stock: ${lowStock
          .slice(0, 3)
          .map((p) => p.title)
          .join(", ")}${lowStock.length > 3 ? ` +${lowStock.length - 3} more` : ""}`,
      );
    // only alert once per visit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lowStock.length]);


  async function save() {
    if (!db || !form.title || !form.price) return notify("Title and price are required");
    const { id, supplierId, markup, ...rest } = form;
    const linked = rest.delivery === "supplier";
    if (linked && !supplierId) return notify("Choose the supplier product first");
    const data = {
      ...rest,
      price: Number(form.price),
      supplierId: linked
        ? /^\d+$/.test(String(supplierId))
          ? Number(supplierId)
          : String(supplierId)
        : null,
      markup: linked ? Number(markup) || 130 : null,
    };
    if (id) {
      await update(ref(db, `products/${id}`), data);
      notify("Product updated");
    } else {
      const created = await push(ref(db, "products"), { ...data, salesCount: 0, announced: true });
      notify("Product added");
      if (created.key) await announce("new", created.key);
    }
    // Refresh supplier prices/stock in the background — a full catalogue sync
    // can take a minute, and the product's own fields are already saved above.
    if (linked) void runSync();
    setForm(emptyProduct);
    setBulk("");
  }

  async function loadSupplier() {
    setSupBusy(true);
    try {
      const r = await fetchSupplierCatalogue();
      if (!r.ok) return notify(r.error || "Supplier not reachable");
      setSupplier(r.products);
      if (r.balance)
        setSupBal({ balance: Number(r.balance.balance || 0), currency: r.balance.currency || "USDT" });
    } catch {
      notify("Supplier not reachable");
    } finally {
      setSupBusy(false);
    }
  }

  async function runSync() {
    setSupBusy(true);
    try {
      const r = await syncSupplier();
      notify(r.ok ? `Supplier synced (${r.updated.length} product(s))` : r.error || "Sync failed");
    } catch {
      notify("Sync failed");
    } finally {
      setSupBusy(false);
    }
  }


  async function saveMarkup(id: string, pct: number) {
    if (!db) return;
    if (!pct || pct < 100) return notify("Use 100 or more (130 = +30% profit)");
    await update(ref(db, `products/${id}`), { markup: pct });
    notify("Profit updated — syncing price…");
    await runSync();
  }

  async function addStock() {
    if (!db || !form.id) return notify("Save the product first, then add stock");
    const lines = bulk
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) return notify("Paste at least one line");
    const current = Array.isArray(editing?.stock) ? editing.stock.filter(Boolean) : [];
    await set(ref(db, `products/${form.id}/stock`), [...current, ...lines]);
    setBulk("");
    notify(`${lines.length} stock added`);
    await announce("restock", form.id, { left: current.length + lines.length });
  }

  /** Push a store announcement with buttons to every bot user. */
  async function announce(
    kind: "new" | "restock" | "low",
    productId: string,
    extra: { left?: number } = {},
  ) {
    const r = await broadcastProductEvent({ data: { kind, productId, ...extra } });
    notify(r.ok ? `📣 Sent to ${r.sent}/${r.total} bot users` : r.error || "Broadcast failed");
  }

  return (
    <div className="space-y-4">
      {linkedProducts.length ? (
        <div
          className={`flex items-center justify-between gap-3 rounded-2xl border p-4 ${
            balanceLow
              ? "border-destructive/40 bg-destructive/10"
              : "border-border bg-card"
          }`}
        >
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
              Supplier balance
            </p>
            <p
              className={`text-lg font-black ${balanceLow ? "text-destructive" : "text-foreground"}`}
            >
              {supBal ? `${balance.toFixed(2)} ${supBal.currency}` : "…"}
            </p>
            {balanceLow ? (
              <p className="text-[11px] font-bold text-destructive">
                {balanceEmpty
                  ? "Too low to buy any product — top up the supplier wallet now."
                  : `Too low for your costliest item ($${costliest.toFixed(2)}) — top up soon.`}
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Enough for every linked product (costliest ${costliest.toFixed(2)}).
              </p>
            )}
          </div>
          <button
            onClick={() => loadBalance()}
            className="rounded-lg bg-primary/10 px-3 py-1.5 text-xs font-bold text-primary"
          >
            Refresh
          </button>
        </div>
      ) : null}
      {lowStock.length ? (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4">
          <h2 className="text-sm font-black text-destructive">
            Low stock alert ({lowStock.length})
          </h2>
          <p className="mb-2 text-xs text-muted-foreground">
            {threshold} or fewer left — add more stock soon.
          </p>
          <div className="space-y-1">
            {lowStock.map((p) => (
              <div
                key={p.id}
                className="flex w-full items-center gap-2 rounded-lg bg-card px-3 py-2 text-xs font-bold"
              >
                <button onClick={() => setViewing(p.id)} className="min-w-0 flex-1 truncate text-left">
                  {p.title}
                </button>
                <span className="text-destructive">
                  {(p.stock || []).filter(Boolean).length} left
                </span>
                <button
                  onClick={() =>
                    announce("low", p.id, { left: (p.stock || []).filter(Boolean).length })
                  }
                  className="rounded-lg bg-destructive/10 px-2 py-1 text-[11px] font-bold text-destructive"
                >
                  📣 Announce
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div className="space-y-2 rounded-2xl border border-border bg-card p-4">

        <h2 className="text-sm font-black">{form.id ? "Edit product" : "Add product"}</h2>
        <select
          className={input}
          value={form.type}
          onChange={(e) => setForm({ ...form, type: e.target.value })}
        >
          {categories.map((c) => (
            <option key={c.label}>{c.label}</option>
          ))}
        </select>
        <input
          className={input}
          placeholder="Title"
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
        />
        <input
          className={input}
          placeholder="Description"
          value={form.desc}
          onChange={(e) => setForm({ ...form, desc: e.target.value })}
        />
        <input
          className={input}
          placeholder="Price"
          value={form.price}
          onChange={(e) => setForm({ ...form, price: e.target.value })}
        />
        <ImageField
          label="Product photo"
          value={form.logo}
          onChange={(logo) => setForm({ ...form, logo })}
          productImage
        />
        <select
          className={input}
          value={form.delivery}
          onChange={(e) =>
            setForm({ ...form, delivery: e.target.value as typeof form.delivery })
          }
        >
          <option value="manual">Manual delivery (admin sends it)</option>
          <option value="auto">Auto delivery from stock (1 line = 1 stock)</option>
          <option value="repeat">Repeated delivery (same link every order)</option>
          <option value="supplier">Supplier shop (auto buy + auto price/stock)</option>
        </select>
        {form.delivery === "supplier" ? (
          <div className="space-y-2 rounded-xl bg-muted/50 p-3">
            <div className="flex gap-2">
              <button
                onClick={loadSupplier}
                disabled={supBusy}
                className="rounded-lg bg-primary/10 px-3 py-1.5 text-xs font-bold text-primary disabled:opacity-60"
              >
                Load supplier products
              </button>
              <button
                onClick={runSync}
                disabled={supBusy}
                className="rounded-lg bg-emerald-500/10 px-3 py-1.5 text-xs font-bold text-emerald-600 disabled:opacity-60"
              >
                Sync prices & stock
              </button>
            </div>
            {supplier.length ? (
              <select
                className={input}
                value={form.supplierId}
                onChange={(e) => {
                  const sid = e.target.value;
                  const sp = supplier.find((s) => String(s.id) === sid);
                  setForm({
                    ...form,
                    supplierId: sid,
                    ...(sp
                      ? {
                          title: form.title || sp.name,
                          desc: form.desc || sp.description || "",
                          price: String(Math.ceil(sp.price * (Number(form.markup) || 130)) / 100),
                        }
                      : {}),
                  });
                }}
              >
                <option value="">Choose supplier product…</option>
                {supplier.map((s) => (
                  <option key={s.id} value={s.id}>
                    #{s.id} · {s.name} · ${s.price} · {s.unlimited_stock ? "∞" : s.stock} in stock
                  </option>
                ))}
              </select>
            ) : (
              <input
                className={input}
                placeholder="Supplier product ID"
                value={form.supplierId}
                onChange={(e) => setForm({ ...form, supplierId: e.target.value })}
              />
            )}
            <input
              className={input}
              placeholder="Price percent (130 = supplier price +30%)"
              value={form.markup}
              onChange={(e) => setForm({ ...form, markup: e.target.value })}
            />
            <p className="text-[11px] text-muted-foreground">
              Price and stock follow the supplier automatically. Orders are bought and delivered
              instantly from the supplier.
            </p>
          </div>
        ) : (
          <input
            className={input}
            placeholder={
              form.delivery === "repeat" ? "Link sent to every buyer" : "Delivery link / content"
            }
            value={form.link}
            onChange={(e) => setForm({ ...form, link: e.target.value })}
          />
        )}

        {form.delivery === "auto" ? (
          <div className="space-y-2 rounded-xl bg-muted/50 p-3">
            <p className="text-xs font-bold">
              Stock available: {stockCount}
              {form.id ? "" : " — save the product first to add stock"}
            </p>
            <textarea
              className={`${input} min-h-24`}
              placeholder={"Paste stock, one per line\nline1\nline2"}
              value={bulk}
              onChange={(e) => setBulk(e.target.value)}
            />
            <div className="flex gap-2">
              <button
                onClick={addStock}
                className="rounded-lg bg-emerald-500/10 px-3 py-1.5 text-xs font-bold text-emerald-600"
              >
                Add stock
              </button>
              {stockCount ? (
                <button
                  onClick={() => setConfirmClearStock(true)}
                  className="rounded-lg bg-destructive/10 px-3 py-1.5 text-xs font-bold text-destructive"
                >
                  Clear stock
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        <div className="flex gap-2">
          <button onClick={save} className="btn-grad flex-1 rounded-xl py-2.5 text-sm font-bold">
            {form.id ? "Save changes" : "Save product"}
          </button>
          {form.id ? (
            <button
              onClick={() => setForm(emptyProduct)}
              className="rounded-xl bg-muted px-4 text-sm font-bold"
            >
              Cancel
            </button>
          ) : null}
        </div>
      </div>

      <div className="space-y-2">
        <input
          className={input}
          type="search"
          placeholder="Search products"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {products.filter((product) => `${product.title} ${product.type || ""}`.toLowerCase().includes(search.trim().toLowerCase())).map((p) => {
          const available = (p.stock || []).filter(Boolean);
          const used = [
            ...Object.values(p.usedStock || {}),
            ...Object.values(usedMap[p.id] || {}),
          ];
          const isLow = p.delivery === "auto" && available.length <= threshold;
          return (
            <div key={p.id} className="rounded-xl border border-border bg-card p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  {p.logo ? (
                    <img src={p.logo} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold">{p.title}</p>
                    <p className="break-words text-xs text-muted-foreground">
                      ${p.price} · {p.type} · {p.salesCount ?? 0} sold ·{" "}
                      {p.delivery === "auto" ? (
                        <span className={isLow ? "font-bold text-destructive" : ""}>
                          {available.length} in stock
                        </span>
                      ) : p.delivery === "repeat" ? (
                        "repeated"
                      ) : p.delivery === "supplier" ? (
                        `supplier #${p.supplierId} · ${p.supplierStock ?? 0} in stock · cost $${p.supplierPrice ?? 0} · ${p.markup ?? 130}%`
                      ) : (
                        "manual"
                      )}

                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 sm:shrink-0 sm:justify-end">
                  <button
                    onClick={() => announce("new", p.id)}
                    className="rounded-lg bg-amber-500/10 px-3 py-1.5 text-xs font-bold text-amber-600"
                  >
                    📣 Announce
                  </button>
                  <button
                    onClick={async () => {
                      if (db) await update(ref(db, `products/${p.id}`), { hidden: !p.hidden });
                    }}
                    className={`rounded-lg px-3 py-1.5 text-xs font-bold ${
                      p.hidden
                        ? "bg-muted text-muted-foreground"
                        : "bg-emerald-500/10 text-emerald-600"
                    }`}
                  >
                    {p.hidden ? "Hidden" : "Visible"}
                  </button>
                  <Link
                    to="/admin/edit/$productId"
                    params={{ productId: p.id }}
                    className="rounded-lg bg-primary/10 px-3 py-1.5 text-xs font-bold text-primary"
                  >
                    Edit
                  </Link>
                  {p.locked ? (
                    <span className="rounded-lg bg-muted px-3 py-1.5 text-xs font-bold text-muted-foreground">
                      API item
                    </span>
                  ) : null}
                  <button
                    onClick={() => setDeleteTarget(p)}
                    className="rounded-lg bg-destructive/10 px-3 py-1.5 text-xs font-bold text-destructive"
                  >
                    Delete
                  </button>
                </div>
              </div>

              {p.delivery === "supplier" ? (
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 p-2">
                  <span className="text-[11px] font-bold text-muted-foreground">Profit %</span>
                  <input
                    type="number"
                    defaultValue={String(p.markup ?? 130)}
                    onChange={(e) => (markupRef.current[p.id] = e.target.value)}
                    className="w-20 rounded-lg border border-border bg-card px-2 py-1 text-xs font-bold"
                  />
                  <span className="text-[11px] text-muted-foreground">
                    → ${((Number(p.supplierPrice ?? 0) * (Number(markupRef.current[p.id] ?? p.markup ?? 130) || 130)) / 100).toFixed(2)}
                  </span>
                  <button
                    onClick={() =>
                      saveMarkup(p.id, Number(markupRef.current[p.id] ?? p.markup ?? 130))
                    }
                    disabled={supBusy}
                    className="ml-auto rounded-lg bg-emerald-500/10 px-3 py-1 text-xs font-bold text-emerald-600 disabled:opacity-60"
                  >
                    Save
                  </button>
                </div>
              ) : null}

              <button
                onClick={async () => {
                  const next = viewing === p.id ? null : p.id;
                  setViewing(next);
                  if (next && db && !usedMap[next]) {
                    const snap = await get(ref(db, `usedStock/${next}`)).catch(() => null);
                    setUsedMap((m) => ({ ...m, [next]: snap?.val() || {} }));
                  }
                }}
                className="mt-2 w-full rounded-lg bg-muted px-3 py-1.5 text-xs font-bold"
              >
                {viewing === p.id ? "Hide stocks" : "View stocks"} ({available.length} available ·{" "}
                {used.length} used)
              </button>

              {viewing === p.id ? (
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <div className="rounded-lg bg-emerald-500/5 p-2">
                    <p className="mb-1 text-xs font-black text-emerald-600">
                      Available ({available.length})
                    </p>
                    <div className="max-h-48 space-y-1 overflow-auto">
                      {available.length ? (
                        available.map((s, i) => (
                          <p key={i} className="break-all rounded bg-card p-1.5 font-mono text-[11px]">
                            {s}
                          </p>
                        ))
                      ) : (
                        <p className="text-xs text-muted-foreground">No stock left</p>
                      )}
                    </div>
                  </div>
                  <div className="rounded-lg bg-muted/60 p-2">
                    <p className="mb-1 text-xs font-black">Used ({used.length})</p>
                    <div className="max-h-48 space-y-1 overflow-auto">
                      {used.length ? (
                        used
                          .slice()
                          .reverse()
                          .map((u, i) => (
                            <div key={i} className="rounded bg-card p-1.5">
                              <p className="break-all font-mono text-[11px]">{u.content}</p>
                              <p className="text-[10px] text-muted-foreground">
                                {u.email || "—"} · {u.orderId || ""} ·{" "}
                                {u.date ? new Date(u.date).toLocaleString() : ""}
                              </p>
                            </div>
                          ))
                      ) : (
                        <p className="text-xs text-muted-foreground">Nothing used yet</p>
                      )}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <AlertDialog open={confirmClearStock} onOpenChange={setConfirmClearStock}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear all stock?</AlertDialogTitle>
            <AlertDialogDescription>Every available stock line for this product will be removed. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={async () => { if (db && form.id) await set(ref(db, `products/${form.id}/stock`), null); }}>Clear stock</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.locked ? "this API product" : "this product"}?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.locked
                ? "It will not come back on the next import. This cannot be undone."
                : "This permanently removes the product. This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                const p = deleteTarget;
                if (!db || !p) return;
                if (p.locked) await update(ref(db, "site_settings/apiDeleted"), { [p.id]: true });
                await remove(ref(db, `products/${p.id}`));
                notify("Product deleted");
                setDeleteTarget(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

