import { createFileRoute } from "@tanstack/react-router";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  Boxes,
  DollarSign,
  PackageX,
  ShoppingBag,
  Users as UsersIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { get, onValue, push, ref, remove, set, update } from "@/lib/fb/database";
import { useStore, isOwnerEmail, type Product, type Category } from "@/context/StoreContext";
import { fileToCompressedDataUrl } from "@/lib/image-upload";
import { exportOrdersCsv, exportOrdersPdf, type ExportRow } from "@/lib/export-orders";
import { sendSmtpMail } from "@/lib/mail.functions";
import { deliveryBlock, emailShell, sendMail } from "@/lib/mailer";
import { notifyTelegramOrder } from "@/lib/telegram.functions";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { input, Stat, Empty, ImageField, type OrderRow } from "@/components/admin/shared";

export function Dashboard({
  orders,
  products,
  config,
  onRefresh,
}: {
  orders: OrderRow[];
  products: Product[];
  config: { lowStockAlert?: number };
  onRefresh: () => void | Promise<void>;
}) {
  const threshold = Number(config.lowStockAlert ?? 5);
  const autoProducts = products.filter((p) => p.delivery === "auto");
  const totalStock = autoProducts.reduce((s, p) => s + (p.stock || []).filter(Boolean).length, 0);
  const { db } = useStore();
  const [usedStock, setUsedStock] = useState(0);
  const [users, setUsers] = useState({ total: 0, telegram: 0, web: 0, joins: [] as number[] });
  const [topups, setTopups] = useState<{ amount: number; date: number }[]>([]);
  const [range, setRange] = useState<7 | 30 | 0>(7);
  useEffect(() => {
    if (!db) return;
    get(ref(db, "usedStock"))
      .then((snap) => {
        const val = (snap.val() || {}) as Record<string, Record<string, unknown>>;
        setUsedStock(Object.values(val).reduce((n, m) => n + Object.keys(m || {}).length, 0));
      })
      .catch(() => undefined);
    const unsubUsers = onValue(ref(db, "users"), (snap) => {
      const val = (snap.val() || {}) as Record<string, { telegramChatId?: number; joined?: string }>;
      const rows = Object.entries(val);
      const telegram = rows.filter(([id, u]) => id.startsWith("tg_") || !!u?.telegramChatId).length;
      const joins = rows
        .map(([, u]) => new Date(u?.joined || "").getTime())
        .filter((t) => Number.isFinite(t) && t > 0);
      setUsers({ total: rows.length, telegram, web: rows.length - telegram, joins });
    });
    let creditedDeposits: { amount: number; date: number }[] = [];
    let depositHashes = new Set<string>();
    let approvedRequests: { amount: number; date: number; utr?: string | undefined }[] = [];
    const publishTopups = () => {
      const fromRequests = approvedRequests.filter((r) => !r.utr || !depositHashes.has(r.utr));
      setTopups([...creditedDeposits, ...fromRequests.map(({ amount, date }) => ({ amount, date }))]);
    };
    const unsubDeposits = onValue(ref(db, "deposits"), (snap) => {
      const val = (snap.val() || {}) as Record<string, { amount?: number; date?: string; status?: string }>;
      depositHashes = new Set(Object.keys(val));
      creditedDeposits = Object.values(val)
        .filter((d) => d.status === "Credited")
        .map((d) => ({ amount: Number(d.amount) || 0, date: new Date(d.date || "").getTime() }))
        .filter((d) => Number.isFinite(d.date));
      publishTopups();
    });
    const unsubRequests = onValue(ref(db, "requests"), (snap) => {
      const val = (snap.val() || {}) as Record<string, { type?: string; status?: string; amount?: number; date?: string; utr?: string }>;
      approvedRequests = Object.values(val)
        .filter((r) => r.type === "Deposit" && r.status === "Approved")
        .map((r) => ({ amount: Number(r.amount) || 0, date: new Date(r.date || "").getTime(), utr: r.utr }))
        .filter((r) => Number.isFinite(r.date));
      publishTopups();
    });
    return () => { unsubUsers(); unsubDeposits(); unsubRequests(); };
  }, [db]);
  const lowStock = autoProducts.filter(
    (p) => (p.stock || []).filter(Boolean).length <= threshold,
  );

  const valid = orders.filter((o) => o.status !== "Cancelled");
  const now = Date.now();
  const since = (days: number) => now - days * 86400000;
  const sum = (list: OrderRow[]) => list.reduce((s, o) => s + (Number(o.total) || 0), 0);
  const inRange = (from: number, to = now) =>
    valid.filter((o) => {
      const t = new Date(o.date).getTime();
      return t >= from && t < to;
    });

  const thisWeek = inRange(since(7));
  const lastWeek = inRange(since(14), since(7));
  const today = inRange(since(1));
  const pending = orders.filter((o) => o.status === "Pending").length;

  // Chart buckets: daily for 7/30 days, monthly for all time.
  const firstEvent = Math.min(
    ...[...valid.map((o) => new Date(o.date).getTime()), ...users.joins, ...topups.map((t) => t.date)].filter((t) =>
      Number.isFinite(t),
    ),
    now,
  );
  const monthly = range === 0;
  const buckets: { label: string; from: number; to: number }[] = [];
  if (monthly) {
    const start = new Date(firstEvent);
    start.setHours(0, 0, 0, 0);
    start.setDate(1);
    const cursor = new Date(start);
    while (cursor.getTime() <= now) {
      const from = cursor.getTime();
      const next = new Date(cursor);
      next.setMonth(next.getMonth() + 1);
      buckets.push({
        label: cursor.toLocaleDateString(undefined, { month: "short", year: "2-digit" }),
        from,
        to: next.getTime(),
      });
      cursor.setMonth(cursor.getMonth() + 1);
    }
  } else {
    for (let i = range - 1; i >= 0; i--) {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - i);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      buckets.push({
        label: start.toLocaleDateString(undefined, { day: "numeric", month: "short" }),
        from: start.getTime(),
        to: end.getTime(),
      });
    }
  }

  const chartData = buckets.map((b) => {
    const list = inRange(b.from, b.to);
    return {
      label: b.label,
      earning: Number(sum(list).toFixed(2)),
      sales: list.length,
      newUsers: users.joins.filter((t) => t >= b.from && t < b.to).length,
      topup: Number(topups.filter((t) => t.date >= b.from && t.date < b.to).reduce((s, t) => s + t.amount, 0).toFixed(2)),
    };
  });

  const rangeTotals = chartData.reduce(
    (a, d) => ({
      earning: a.earning + d.earning,
      sales: a.sales + d.sales,
      newUsers: a.newUsers + d.newUsers,
      topup: a.topup + d.topup,
    }),
    { earning: 0, sales: 0, newUsers: 0, topup: 0 },
  );

  // Cumulative user growth for the small users graph.
  let running = users.total - users.joins.filter((t) => t >= buckets[0]!.from).length;
  const userGrowth = chartData.map((d) => {
    running += d.newUsers;
    return { label: d.label, users: running };
  });

  const weekDelta = sum(lastWeek) > 0 ? ((sum(thisWeek) - sum(lastWeek)) / sum(lastWeek)) * 100 : undefined;

  return (
    <div className="space-y-5">
      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Revenue (all time)"
          value={`$${sum(valid)}`}
          sub={`${valid.length} orders`}
          icon={DollarSign}
        />
        <Stat
          label="This week"
          value={`$${sum(thisWeek)}`}
          sub={`${thisWeek.length} orders`}
          icon={ShoppingBag}
          {...(weekDelta !== undefined ? { delta: weekDelta } : {})}
        />
        <Stat
          label="Today"
          value={`$${sum(today)}`}
          sub={`${today.length} orders`}
          icon={ShoppingBag}
        />
        <Stat label="Pending orders" value={String(pending)} icon={AlertTriangle} />
        <Stat label="Available stock" value={String(totalStock)} icon={Boxes} />
        <Stat label="Used stock" value={String(usedStock)} icon={Boxes} />
        <Stat
          label="Total users"
          value={String(users.total)}
          sub={`${users.web} web · ${users.telegram} tg`}
          icon={UsersIcon}
        />
        <Stat label="Low stock items" value={String(lowStock.length)} icon={PackageX} />
      </div>

      {/* Trends chart */}
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-sm">Earnings · Sales · Users · Top-ups</CardTitle>
          <div className="flex gap-1 rounded-lg bg-muted p-1">
            {([7, 30, 0] as const).map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  range === r ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
                )}
              >
                {r === 0 ? "All" : `${r}d`}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: "Earning", value: `$${rangeTotals.earning.toFixed(2)}` },
              { label: "Sales", value: String(rangeTotals.sales) },
              { label: "New users", value: String(rangeTotals.newUsers) },
              { label: "Top-ups", value: `$${rangeTotals.topup.toFixed(2)}` },
            ].map((s) => (
              <div key={s.label} className="rounded-xl bg-muted/50 px-3 py-2 text-center">
                <p className="text-[11px] text-muted-foreground">{s.label}</p>
                <p className="font-display text-base font-bold tabular-nums">{s.value}</p>
              </div>
            ))}
          </div>

          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={16} />
                <YAxis yAxisId="left" tick={{ fontSize: 10 }} />
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10 }} width={26} />
                <Tooltip
                  contentStyle={{
                    borderRadius: 12,
                    fontSize: 12,
                    background: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line yAxisId="left" type="monotone" dataKey="earning" name="Earning ($)" stroke="hsl(var(--success))" strokeWidth={2} dot={false} />
                <Line yAxisId="left" type="monotone" dataKey="topup" name="Top-up ($)" stroke="hsl(var(--chart-5))" strokeWidth={2} dot={false} />
                <Line yAxisId="right" type="monotone" dataKey="sales" name="Sales" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                <Line yAxisId="right" type="monotone" dataKey="newUsers" name="New users" stroke="hsl(var(--accent))" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* User growth */}
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-sm">User growth</CardTitle>
          <span className="text-xs font-medium text-muted-foreground">{users.total} total</span>
        </CardHeader>
        <CardContent>
          <div className="h-32 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={userGrowth} margin={{ top: 4, right: 4, left: -22, bottom: 0 }}>
                <defs>
                  <linearGradient id="userFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="label" tick={{ fontSize: 9 }} minTickGap={20} />
                <YAxis tick={{ fontSize: 9 }} width={28} />
                <Tooltip
                  contentStyle={{
                    borderRadius: 12,
                    fontSize: 12,
                    background: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                  }}
                />
                <Area type="monotone" dataKey="users" name="Users" stroke="hsl(var(--primary))" fill="url(#userFill)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Low stock */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            Low stock products{" "}
            <span className="text-xs font-normal text-muted-foreground">({threshold} or fewer left)</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {lowStock.length ? (
            <div className="space-y-1.5">
              {lowStock.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2 text-sm"
                >
                  <span className="truncate font-medium">{p.title}</span>
                  <span className="shrink-0 font-semibold tabular-nums text-destructive">
                    {(p.stock || []).filter(Boolean).length} left
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">All auto-delivery products are stocked.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

