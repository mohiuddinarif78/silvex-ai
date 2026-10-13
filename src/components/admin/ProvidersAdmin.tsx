import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Plug, RefreshCw } from "lucide-react";
import { ref, remove, update } from "@/lib/fb/database";
import { useStore, type Product } from "@/context/StoreContext";
import { Empty } from "@/components/admin/shared";
import {
  listProviders,
  saveProvider,
  importProviderProducts,
  pruneApiProducts,
} from "@/lib/providers.functions";
import { broadcastProductEvent } from "@/lib/broadcast.functions";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
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

type Row = {
  id: string;
  name: string;
  url: string;
  key: string;
  docs: string;
  markup: number;
  enabled: boolean;
  balance: number | null;
  currency: string;
};

export function ProvidersAdmin({ products }: { products: Product[] }) {
  const { db, notify } = useStore();
  const [rows, setRows] = useState<Row[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, Partial<Row>>>({});
  const [deleteTarget, setDeleteTarget] = useState<Product[] | null>(null);

  async function load() {
    setBusy("load");
    const r = await listProviders();
    setBusy(null);
    if (r.ok) setRows(r.providers as Row[]);
  }

  useEffect(() => {
    load().catch(() => undefined);
  }, []);

  const byProvider = useMemo(() => {
    const map: Record<string, Product[]> = {};
    for (const p of products) {
      if (p.delivery !== "supplier") continue;
      const id = p.provider || "custom";
      (map[id] ||= []).push(p);
    }
    return map;
  }, [products]);

  const value = (r: Row, k: keyof Row) => (draft[r.id]?.[k] ?? r[k]) as string | number;

  async function persist(r: Row) {
    setBusy(r.id);
    const d = draft[r.id] || {};
    const res = await saveProvider({
      data: {
        id: r.id,
        name: String(d.name ?? r.name),
        url: String(d.url ?? r.url),
        key: String(d.key ?? r.key),
        markup: Number(d.markup ?? r.markup) || 130,
      },
    });
    setBusy(null);
    notify(res.ok ? "Provider saved" : res.error || "Could not save");
    await load();
  }

  async function toggleProvider(r: Row) {
    setBusy(r.id);
    await saveProvider({ data: { id: r.id, enabled: !r.enabled } });
    setBusy(null);
    notify(r.enabled ? `${r.name} turned off` : `${r.name} turned on`);
    await load();
  }

  async function importAll(r: Row) {
    setBusy(r.id);
    const res = await importProviderProducts({ data: { id: r.id } });
    setBusy(null);
    notify(
      res.ok
        ? `${r.name}: ${res.added} new, ${res.updated} refreshed (new items start hidden)`
        : res.error || "Import failed",
    );
  }

  async function cleanup() {
    setBusy("prune");
    const res = await pruneApiProducts();
    setBusy(null);
    notify(res.ok ? `Removed ${res.removed} extra items, kept ${res.kept}` : res.error || "Cleanup failed");
  }

  async function toggleHidden(p: Product) {
    if (!db) return;
    const showing = Boolean(p.hidden);
    await update(ref(db, `products/${p.id}`), { hidden: !p.hidden });
    notify(showing ? "Shown to customers" : "Hidden from customers");
    if (showing && !(p as { announced?: boolean }).announced) {
      await update(ref(db, `products/${p.id}`), { announced: true });
      const r = await broadcastProductEvent({ data: { kind: "new", productId: p.id } });
      if (r.ok) notify(`Announced to ${r.sent} bot users`);
    }
  }

  async function setAllHidden(items: Product[], hidden: boolean) {
    if (!db || !items.length) return;
    for (const p of items) await update(ref(db, `products/${p.id}`), { hidden });
    notify(hidden ? "All hidden from customers" : "All shown to customers");
  }

  async function confirmDeleteAll() {
    const items = deleteTarget;
    if (!db || !items?.length) return;
    for (const p of items) {
      await update(ref(db, "site_settings/apiDeleted"), { [p.id]: true });
      await remove(ref(db, `products/${p.id}`));
    }
    notify(`Deleted ${items.length} products`);
    setDeleteTarget(null);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-display text-sm font-semibold">Reseller API delivery products</h2>
          <p className="text-xs text-muted-foreground">
            Import products from each API shop, set the profit %, and show or hide them.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:bg-destructive/10"
            onClick={() => cleanup()}
            disabled={busy === "prune"}
          >
            {busy === "prune" ? "Cleaning…" : "Remove extra items"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => load()}>
            <RefreshCw className="size-4" /> Refresh
          </Button>
        </div>
      </div>

      {rows.length === 0 ? <Empty text="Loading API shops…" /> : null}

      <div className="grid gap-3">
        {rows.map((r) => {
          const items = byProvider[r.id] || [];
          const cheapest = items.length ? Math.min(...items.map((p) => Number(p.supplierPrice ?? 0))) : 0;
          const costliest = items.reduce((m, p) => Math.max(m, Number(p.supplierPrice ?? 0)), 0);
          const low = r.balance != null && items.length > 0 && r.balance < costliest;
          const empty = r.balance != null && items.length > 0 && r.balance < cheapest;
          return (
            <Card key={r.id} className={cn("gap-0 py-0", low && "border-destructive/40 bg-destructive/5")}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 truncate font-display text-sm font-semibold">
                      <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <Plug className="size-4" />
                      </span>
                      {r.name}
                      <Badge variant={r.enabled ? "success" : "muted"}>{r.enabled ? "On" : "Off"}</Badge>
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {items.length} product(s) ·{" "}
                      <span className={low ? "font-semibold text-destructive" : ""}>
                        balance {r.balance == null ? "—" : `${r.balance.toFixed(2)} ${r.currency}`}
                      </span>
                    </p>
                    {low ? (
                      <p className="text-xs font-medium text-destructive">
                        {empty
                          ? "Too low to buy anything here — top up this shop."
                          : `Too low for the costliest item ($${costliest.toFixed(2)}).`}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-2">
                    <Button size="sm" variant="secondary" onClick={() => importAll(r)} disabled={busy === r.id}>
                      Import
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setOpen(open === r.id ? null : r.id)}>
                      {open === r.id ? "Close" : "Open"}
                    </Button>
                  </div>
                </div>

                {open === r.id ? (
                  <div className="mt-4 space-y-2 border-t border-border pt-4">
                    <Input
                      placeholder="Shop name"
                      value={String(value(r, "name"))}
                      onChange={(e) => setDraft({ ...draft, [r.id]: { ...draft[r.id], name: e.target.value } })}
                    />
                    <Input
                      placeholder="API address"
                      value={String(value(r, "url"))}
                      onChange={(e) => setDraft({ ...draft, [r.id]: { ...draft[r.id], url: e.target.value } })}
                    />
                    <Input
                      placeholder="API key"
                      value={String(value(r, "key"))}
                      onChange={(e) => setDraft({ ...draft, [r.id]: { ...draft[r.id], key: e.target.value } })}
                    />
                    <Input
                      placeholder="Default profit % (130 = +30%)"
                      value={String(value(r, "markup"))}
                      onChange={(e) =>
                        setDraft({ ...draft, [r.id]: { ...draft[r.id], markup: Number(e.target.value) } })
                      }
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button onClick={() => persist(r)} disabled={busy === r.id}>
                        Save
                      </Button>
                      <Button variant="outline" onClick={() => toggleProvider(r)}>
                        {r.enabled ? "Turn off" : "Turn on"}
                      </Button>
                      {r.docs ? (
                        <Button variant="outline" asChild>
                          <a href={r.docs} target="_blank" rel="noreferrer">
                            API docs
                          </a>
                        </Button>
                      ) : null}
                    </div>

                    {items.length ? (
                      <div className="flex flex-wrap gap-2 pt-1">
                        <Button size="sm" variant="outline" onClick={() => setAllHidden(items, true)}>
                          Hide all
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-success hover:bg-success/10"
                          onClick={() => setAllHidden(items, false)}
                        >
                          Show all
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:bg-destructive/10"
                          onClick={() => setDeleteTarget(items)}
                        >
                          Delete all
                        </Button>
                      </div>
                    ) : null}

                    <div className="space-y-1.5 pt-2">
                      {items.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          No products imported yet — tap “Import”.
                        </p>
                      ) : (
                        items.map((p) => (
                          <div
                            key={p.id}
                            className="flex items-center justify-between gap-2 rounded-xl bg-muted/50 p-2.5"
                          >
                            <div className="min-w-0">
                              <p className="truncate text-xs font-semibold">{p.title}</p>
                              <p className="text-[11px] text-muted-foreground">
                                cost ${Number(p.supplierPrice ?? 0).toFixed(2)} · sells $
                                {Number(p.price).toFixed(2)} · {p.supplierStock ?? 0} in stock
                              </p>
                            </div>
                            <div className="flex shrink-0 gap-2">
                              <Button
                                size="sm"
                                variant={p.hidden ? "outline" : "ghost"}
                                className={cn("h-8", !p.hidden && "text-success hover:bg-success/10")}
                                onClick={() => toggleHidden(p)}
                              >
                                {p.hidden ? "Hidden" : "Visible"}
                              </Button>
                              <Button size="sm" variant="secondary" className="h-8" asChild>
                                <Link to="/admin/edit/$productId" params={{ productId: p.id }}>
                                  Edit
                                </Link>
                              </Button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete all {deleteTarget?.length} products?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes every imported product from this shop. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmDeleteAll}
            >
              Delete all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
