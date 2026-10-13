import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Eye, EyeOff, Megaphone, PackagePlus, PackageX, Save, Search, Trash2 } from "lucide-react";
import { providerName } from "@/lib/provider-names";
import { get, push, ref, remove, set, update } from "@/lib/fb/database";
import { Link, useNavigate } from "@tanstack/react-router";
import { useStore, type Product } from "@/context/StoreContext";
import { broadcastProductEvent } from "@/lib/broadcast.functions";
import { syncSupplier } from "@/lib/supplier.functions";
import { ImageField, input } from "@/components/admin/shared";
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

type Form = { title: string; group: string; desc: string; type: string; price: string; logo: string; link: string; delivery: "manual" | "auto" | "repeat" | "supplier"; supplierId: string; markup: string; botPrice: string; apiPrice: string };

export function ProductEditor({ product }: { product: Product }) {
  const { db, categories, notify, products } = useStore();
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [bulk, setBulk] = useState("");
  const [jump, setJump] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmClearStock, setConfirmClearStock] = useState(false);
  const jumpList = useMemo(() => {
    const q = jump.trim().toLowerCase();
    if (!q) return [];
    return products.filter((p) => p && p.title && p.id !== product.id && `${p.title} ${providerName((p as { provider?: string }).provider)}`.toLowerCase().includes(q)).slice(0, 20);
  }, [jump, products, product.id]);
  const [usedStock, setUsedStock] = useState<Record<string, { content: string; orderId?: string; email?: string }>>({});
  const [form, setForm] = useState<Form>({ title: product.title, group: product.group ?? "", desc: product.desc ?? "", type: product.type ?? categories[0]?.label ?? "Service", price: String(product.price), logo: product.logo ?? "", link: product.link ?? "", delivery: product.delivery ?? "manual", supplierId: product.supplierId == null ? "" : String(product.supplierId), markup: String(product.markup ?? 130), botPrice: product.botPrice ? String(product.botPrice) : "", apiPrice: (product as any).apiPrice ? String((product as any).apiPrice) : "" });

  useEffect(() => {
    if (!db || product.id === "new") return;
    get(ref(db, `usedStock/${product.id}`)).then((snap) => setUsedStock(snap.val() || {})).catch(() => undefined);
  }, [db, product.id]);

  const folderNames = useMemo(() => [...new Set(products.map((p) => String(p.group || "").trim()).filter(Boolean))].sort(), [products]);
  const available = useMemo(() => {
    const raw = product.stock as unknown;
    const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw as Record<string, unknown>) : [];
    return list.map((s) => String(s ?? "").trim()).filter(Boolean);
  }, [product.stock]);
  const used = useMemo(() => [...Object.values(product.usedStock || {}), ...Object.values(usedStock)], [product.usedStock, usedStock]);
  const sellingPrice = form.delivery === "supplier" && product.supplierPrice != null ? Number(product.supplierPrice) * (Number(form.markup) || 130) / 100 : Number(form.price) || 0;

  async function toggleChannel(key: "hideWeb" | "hideBot") {
    if (!db) return;
    await update(ref(db, `products/${product.id}`), { [key]: !product[key] });
    notify(`${key === "hideWeb" ? "Website" : "Bot"}: ${product[key] ? "visible" : "hidden"}`);
  }

  async function saveProduct() {
    if (!db) return;
    if (!form.title.trim() || !(Number(form.price) > 0)) return notify("Name and a valid price are required");
    if (form.delivery === "supplier" && !form.supplierId.trim()) return notify("Supplier product ID is required");
    setSaving(true);
    const data = {
      title: form.title.trim(), group: form.group.trim() || null, desc: form.desc.trim(), descEdited: true, type: form.type,
      price: form.delivery === "supplier" ? Number(sellingPrice.toFixed(2)) : Number(form.price),
      logo: form.logo, link: form.delivery === "supplier" ? null : form.link.trim(), delivery: form.delivery,
      supplierId: form.delivery === "supplier" ? (/^\d+$/.test(form.supplierId) ? Number(form.supplierId) : form.supplierId.trim()) : null,
      markup: form.delivery === "supplier" ? Number(form.markup) || 130 : null,
      botPrice: Number(form.botPrice) > 0 ? Number(form.botPrice) : null,
      apiPrice: Number(form.apiPrice) > 0 ? Number(form.apiPrice) : null,
    };
    try {
      if (product.id === "new") {
        await push(ref(db, "products"), { ...data, salesCount: 0, announced: true });
        notify("Product added");
      } else {
        await update(ref(db, `products/${product.id}`), data);
        if (form.delivery === "supplier") await syncSupplier().catch(() => undefined);
        notify("Product updated");
      }
      await navigate({ to: "/admin/products" });
    } catch {
      notify("Product could not be saved. Please try again.");
    } finally { setSaving(false); }
  }

  async function importStockFile(file: File) {
    try {
      const name = file.name.toLowerCase();
      let lines: string[] = [];
      if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
        const XLSX = await import("xlsx");
        const wb = XLSX.read(await file.arrayBuffer());
        const sheetName = wb.SheetNames[0];
        const sheet = sheetName ? wb.Sheets[sheetName] : undefined;
        if (!sheet) throw new Error("empty workbook");
        const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false });
        lines = rows.map((r) => (Array.isArray(r) ? r : [r]).map((c) => String(c ?? "").trim()).filter(Boolean).join(" ")).filter(Boolean);
      } else {
        const text = await file.text();
        lines = text.split(/\r?\n/).map((line) => {
          const parts = line.split(/[,;\t]/).map((p) => p.trim()).filter(Boolean);
          return (parts.length > 1 && name.endsWith(".csv") ? parts[0] : line.trim()) ?? "";
        });
      }
      const items = lines.map((l) => l.trim()).filter(Boolean);
      if (!items.length) return notify("No stock items found in that file");
      setBulk((prev) => (prev.trim() ? `${prev.trim()}\n${items.join("\n")}` : items.join("\n")));
      notify(`${items.length} stock item(s) loaded from file — tap Add stock to save`);
    } catch {
      notify("That file could not be read. Use a .txt, .csv or .xlsx file.");
    }
  }

  async function addStock() {
    if (!db || product.id === "new") return notify("Save the product first, then add stock");
    const lines = bulk.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return notify("Paste at least one stock item");
    try {
      // Read the live stock so nothing added elsewhere (bot, other admin) is overwritten.
      const snap = await get(ref(db, `products/${product.id}/stock`));
      const raw = snap.val();
      const current = (Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : [])
        .map((s) => String(s ?? "").trim()).filter(Boolean);
      await update(ref(db, `products/${product.id}`), {
        stock: [...current, ...lines],
        delivery: "auto",
        soldOut: false,
      });
      setBulk(""); notify(`${lines.length} stock item(s) added`);
      void broadcastProductEvent({ data: { kind: "restock", productId: product.id, added: lines.length, left: current.length + lines.length } })
        .then((r) => notify(r.ok ? `📣 "${lines.length} stocks added" sent to ${r.sent} bot users` : r.error || "Announcement failed"))
        .catch(() => undefined);
    } catch {
      notify("Stock could not be added. Please try again.");
    }
  }

  async function deleteProduct() {
    if (!db) return;
    if (product.locked) await update(ref(db, "site_settings/apiDeleted"), { [product.id]: true });
    await remove(ref(db, `products/${product.id}`)); notify("Product deleted");
    await navigate({ to: "/admin/products" });
  }

  async function toggleSoldOut() {
    if (!db) return;
    await update(ref(db, `products/${product.id}`), { soldOut: !product.soldOut });
    notify(product.soldOut ? "Product is buyable again" : "Product marked out of stock");
  }

  async function toggleVisibility() {
    if (!db) return;
    await update(ref(db, `products/${product.id}`), { hidden: !product.hidden });
    notify(product.hidden ? "Product is now visible" : "Product is now hidden");
  }

  async function announce() {
    const result = await broadcastProductEvent({ data: { kind: "new", productId: product.id } }).catch(() => ({ ok: false as const, error: "Announcement could not be sent" }));
    notify(result.ok ? `Announcement sent to ${result.sent} bot users` : result.error || "Announcement failed");
  }

  return <div className="fade-in mx-auto max-w-3xl space-y-5">
    <div className="flex items-center justify-between gap-3"><Link to="/admin/products" className="flex items-center gap-2 text-sm font-bold text-muted-foreground"><ArrowLeft className="h-4 w-4" /> Products</Link><div className="flex items-center gap-2">{product.soldOut ? <span className="rounded-lg bg-destructive/10 px-2.5 py-1 text-[11px] font-bold text-destructive">Out of stock</span> : null}<span className={`rounded-lg px-2.5 py-1 text-[11px] font-bold ${product.hidden ? "bg-muted text-muted-foreground" : "bg-emerald-500/10 text-emerald-600"}`}>{product.hidden ? "Hidden" : "Visible"}</span></div></div>
    <div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><input className={`${input} pl-9`} type="search" placeholder="Search another product to edit" value={jump} onChange={(e) => setJump(e.target.value)} />{jumpList.length ? <div className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-xl border border-border bg-card shadow-lg">{jumpList.map((p) => <Link key={p.id} to="/admin/edit/$productId" params={{ productId: p.id }} onClick={() => setJump("")} className="flex items-center justify-between gap-2 px-3 py-2 text-sm hover:bg-muted"><span className="truncate font-bold">{p.title}</span><span className="shrink-0 text-[10px] font-bold text-primary">{p.delivery === "supplier" ? providerName((p as { provider?: string }).provider) || "API" : ""}</span></Link>)}</div> : null}</div>
    <div><p className="text-xs font-bold text-primary">PRODUCT EDITOR</p><h1 className="break-words text-2xl font-black">{product.id === "new" ? "New product" : product.title}</h1>{product.id === "new" ? null : <p className="mt-1 text-xs text-muted-foreground">ID: {product.id}{product.locked ? " · API product" : ""}</p>}</div>
    <section className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(260px,0.75fr)]">
      <div className="space-y-4">
        <div className="space-y-3 rounded-2xl border border-border bg-card p-4"><h2 className="text-sm font-black">Product details</h2>
          <label className="block text-xs font-bold">Name<input className={`${input} mt-1`} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
          <label className="block text-xs font-bold">Category<select className={`${input} mt-1`} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>{(categories.some((c) => c.label === form.type) ? categories : [{ label: form.type }, ...categories]).map((c) => <option key={c.label}>{c.label}</option>)}</select></label>
          <label className="block text-xs font-bold">Folder (variations)<input className={`${input} mt-1`} list="product-folders" value={form.group} onChange={(e) => setForm({ ...form, group: e.target.value })} placeholder="e.g. LinkedIn" /><datalist id="product-folders">{folderNames.map((g) => <option key={g} value={g} />)}</datalist><span className="mt-1 block text-[11px] font-medium text-muted-foreground">Products with the same folder name show as one item with plan variations.</span></label>
          <label className="block text-xs font-bold">Description<textarea className={`${input} mt-1 min-h-36 resize-y whitespace-pre-wrap`} value={form.desc} onChange={(e) => setForm({ ...form, desc: e.target.value })} placeholder="Write each detail on a separate line" /></label>
          <label className="block text-xs font-bold">Selling price ($)<input type="number" min="0.01" step="0.01" className={`${input} mt-1`} value={form.delivery === "supplier" ? sellingPrice.toFixed(2) : form.price} disabled={form.delivery === "supplier"} onChange={(e) => setForm({ ...form, price: e.target.value })} /></label><label className="block text-xs font-bold">Bot price ($) <span className="font-normal text-muted-foreground">— leave empty to use website price</span><input type="number" min="0" step="0.01" className={`${input} mt-1`} value={form.botPrice} placeholder={sellingPrice.toFixed(2)} onChange={(e) => setForm({ ...form, botPrice: e.target.value })} /></label><label className="block text-xs font-bold">API price ($) <span className="font-normal text-muted-foreground">— for reseller API orders; empty uses website price</span><input type="number" min="0" step="0.01" className={`${input} mt-1`} value={form.apiPrice} placeholder={sellingPrice.toFixed(2)} onChange={(e) => setForm({ ...form, apiPrice: e.target.value })} /></label>
        </div>
        <div className="space-y-3 rounded-2xl border border-border bg-card p-4"><h2 className="text-sm font-black">Delivery</h2>
          <select className={input} value={form.delivery} onChange={(e) => setForm({ ...form, delivery: e.target.value as Form["delivery"] })}><option value="manual">Manual delivery</option><option value="auto">Automatic from stock</option><option value="repeat">Same content for every order</option><option value="supplier">Supplier / API delivery</option></select>
          {form.delivery === "supplier" ? <div className="space-y-3 rounded-xl bg-muted/50 p-3"><div className="grid grid-cols-2 gap-2 text-xs"><div><p className="text-muted-foreground">Supplier cost</p><p className="font-black">${Number(product.supplierPrice ?? 0).toFixed(2)}</p></div><div><p className="text-muted-foreground">Supplier stock</p><p className="font-black">{product.supplierStock ?? 0}</p></div></div><label className="block text-xs font-bold">Supplier product ID<input className={`${input} mt-1`} value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })} /></label><label className="block text-xs font-bold">Price percentage<input type="number" min="100" className={`${input} mt-1`} value={form.markup} onChange={(e) => setForm({ ...form, markup: e.target.value })} /></label><p className="text-xs text-muted-foreground">Calculated selling price: <b className="text-foreground">${sellingPrice.toFixed(2)}</b>{product.provider ? ` · ${product.provider}` : ""}</p></div> : <label className="block text-xs font-bold">{form.delivery === "repeat" ? "Content sent to every buyer" : "Delivery link or instructions"}<textarea className={`${input} mt-1 min-h-24 resize-y`} value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} /></label>}
        </div>
      </div>
      <div className="space-y-4"><div className="rounded-2xl border border-border bg-card p-4"><ImageField label="Product photo" value={form.logo} onChange={(logo) => setForm({ ...form, logo })} productImage /></div>
        {form.delivery === "auto" && product.id !== "new" ? <div className="space-y-3 rounded-2xl border border-border bg-card p-4"><div className="flex justify-between"><h2 className="text-sm font-black">Stock</h2><span className="text-xs font-bold text-primary">{available.length} available</span></div><textarea className={`${input} min-h-28 resize-y font-mono`} value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder="Add stock, one item per line" /><label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl bg-muted py-2.5 text-xs font-bold">📁 Upload stock file (.txt, .csv, .xlsx)<input type="file" accept=".txt,.csv,.xlsx,.xls" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void importStockFile(f); }} /></label><button type="button" onClick={addStock} className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500/10 py-2.5 text-xs font-bold text-emerald-600"><PackagePlus className="h-4 w-4" /> Add stock</button>{available.length ? <button type="button" onClick={() => setConfirmClearStock(true)} className="w-full text-xs font-bold text-destructive">Clear available stock</button> : null}<div className="max-h-48 space-y-1 overflow-auto">{available.map((item, index) => <p key={index} className="break-all rounded-lg bg-muted p-2 font-mono text-[10px]">{item}</p>)}</div><p className="border-t border-border pt-3 text-xs font-black">Used stock ({used.length})</p><div className="max-h-48 space-y-1 overflow-auto">{used.map((item, index) => <div key={index} className="rounded-lg bg-muted p-2"><p className="break-all font-mono text-[10px]">{item.content}</p><p className="text-[9px] text-muted-foreground">{item.email || "—"} · {item.orderId || ""}</p></div>)}</div></div> : null}
        <div className="space-y-2 rounded-2xl border border-border bg-card p-4"><button type="button" onClick={saveProduct} disabled={saving} className="btn-grad flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold disabled:opacity-60"><Save className="h-4 w-4" />{saving ? "Saving…" : product.id === "new" ? "Save product" : "Save changes"}</button>{product.id === "new" ? null : <div><div className="grid grid-cols-2 gap-2"><button type="button" onClick={toggleVisibility} className="flex items-center justify-center gap-2 rounded-xl bg-muted py-2.5 text-xs font-bold">{product.hidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}{product.hidden ? "Show" : "Hide"}</button><button type="button" onClick={announce} className="flex items-center justify-center gap-2 rounded-xl bg-amber-500/10 py-2.5 text-xs font-bold text-amber-600"><Megaphone className="h-4 w-4" /> Announce</button></div><div className="mt-2 grid grid-cols-2 gap-2"><button type="button" onClick={() => toggleChannel("hideWeb")} className={`rounded-xl py-2.5 text-xs font-bold ${product.hideWeb ? "bg-muted text-muted-foreground" : "bg-emerald-500/10 text-emerald-600"}`}>Website: {product.hideWeb ? "Hidden" : "Visible"}</button><button type="button" onClick={() => toggleChannel("hideBot")} className={`rounded-xl py-2.5 text-xs font-bold ${product.hideBot ? "bg-muted text-muted-foreground" : "bg-emerald-500/10 text-emerald-600"}`}>Bot: {product.hideBot ? "Hidden" : "Visible"}</button></div><button type="button" onClick={toggleSoldOut} className={`mt-2 flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-xs font-bold ${product.soldOut ? "bg-emerald-500/10 text-emerald-600" : "bg-destructive/10 text-destructive"}`}><PackageX className="h-4 w-4" /> {product.soldOut ? "Mark back in stock" : "Mark out of stock"}</button><button type="button" onClick={() => setConfirmDelete(true)} className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-destructive/10 py-2.5 text-xs font-bold text-destructive"><Trash2 className="h-4 w-4" /> Delete product</button></div>}</div>
      </div>
    </section>

    <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{product.title}”?</AlertDialogTitle>
          <AlertDialogDescription>This permanently removes the product. This cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={deleteProduct}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog open={confirmClearStock} onOpenChange={setConfirmClearStock}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Clear all available stock?</AlertDialogTitle>
          <AlertDialogDescription>Every unused stock line for this product will be removed. This cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={async () => { if (db) await set(ref(db, `products/${product.id}/stock`), null); }}>Clear stock</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>;
}