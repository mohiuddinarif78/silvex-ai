import { createFileRoute } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { get, onValue, ref } from "@/lib/fb/database";
import { Dashboard } from "@/components/admin/Dashboard";
import { ManagementHub } from "@/components/admin/ManagementHub";
import { OrdersAdmin } from "@/components/admin/OrdersAdmin";
import { Breadcrumbs } from "@/components/admin/Breadcrumbs";
import { Button } from "@/components/ui/button";
import { useStore } from "@/context/StoreContext";
import type { OrderRow } from "@/components/admin/shared";

export const Route = createFileRoute("/admin/")({
  head: () => ({
    meta: [
      { title: "Admin Panel — Silvex AI" },
      { name: "description", content: "Store analysis and management tools for Silvex AI admins." },
      { property: "og:title", content: "Admin Panel — Silvex AI" },
      { property: "og:description", content: "Store analysis and management tools for Silvex AI admins." },
      { property: "og:type", content: "website" },
      { name: "robots", content: "noindex" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  validateSearch: (search: Record<string, unknown>): { view: "analysis" | "orders" | "management" } => ({
    view:
      search["view"] === "management" || search["view"] === "orders"
        ? search["view"]
        : "analysis",
  }),
  component: AdminHome,
});

const TITLES: Record<string, { title: string; desc: string }> = {
  analysis: { title: "Dashboard", desc: "Revenue, orders and store health at a glance." },
  orders: { title: "Orders", desc: "Every order across the store." },
  management: { title: "Management", desc: "Jump into any area of the store." },
};

function AdminHome() {
  const { view } = Route.useSearch();
  const { db, products, config, notify } = useStore();
  const [orders, setOrders] = useState<OrderRow[]>([]);

  useEffect(() => {
    if (!db) return;
    return onValue(ref(db, "orders"), (snapshot) =>
      setOrders(
        (Object.values(snapshot.val() || {}) as OrderRow[]).sort((a, b) => (a.date < b.date ? 1 : -1)),
      ),
    );
  }, [db]);

  async function refresh() {
    if (!db) return;
    const snapshot = await get(ref(db, "orders"));
    setOrders(
      (Object.values(snapshot.val() || {}) as OrderRow[]).sort((a, b) => (a.date < b.date ? 1 : -1)),
    );
    notify("Dashboard refreshed");
  }

  const meta = TITLES[view] ?? TITLES["analysis"]!;

  return (
    <div className="fade-in space-y-5">
      <Breadcrumbs
        items={[{ label: "Admin", to: "/admin", search: { view: "analysis" } }, { label: meta.title }]}
      />
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">{meta.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{meta.desc}</p>
        </div>
        {view === "analysis" ? (
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCw className="size-4" />
            Refresh
          </Button>
        ) : null}
      </header>

      {view === "management" ? (
        <ManagementHub />
      ) : view === "orders" ? (
        <OrdersAdmin orders={orders} />
      ) : (
        <Dashboard orders={orders} products={products} config={config} onRefresh={refresh} />
      )}
    </div>
  );
}
