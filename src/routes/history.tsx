import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Download, Receipt } from "lucide-react";
import { equalTo, get, onValue, orderByChild, query, ref } from "@/lib/fb/database";
import { buildStatementCsv, downloadCsv } from "@/lib/statement";
import { useStore } from "@/context/StoreContext";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/history")({
  head: () => ({
    meta: [
      { title: "Wallet History — Silvex AI" },
      {
        name: "description",
        content: "See every deposit, purchase and refund made with your wallet.",
      },
      { property: "og:title", content: "Wallet History — Silvex AI" },
      {
        property: "og:description",
        content: "See every deposit, purchase and refund made with your wallet.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: HistoryPage,
});

type Entry = { id: string; type: string; amount: number; desc: string; date: string; status?: string };

/** Credits add to the wallet; everything else is spending. */
function isCredit(type: string) {
  return /deposit|refund|bonus|credit|referral|added|top ?up/i.test(type);
}

function HistoryPage() {
  const { db, user, wallet, openModal } = useStore();
  const [items, setItems] = useState<Entry[]>([]);
  const [limit, setLimit] = useState(10);
  const [typeFilter, setTypeFilter] = useState("all");

  useEffect(() => {
    if (!db || !user) return;
    return onValue(ref(db, `users/${user.uid}/history`), (s) => {
      const val = (s.val() || {}) as Record<string, Omit<Entry, "id">>;
      setItems(
        Object.entries(val)
          .map(([id, h]) => ({ id, ...h }))
          .sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))),
      );
    });
  }, [db, user]);

  const types = useMemo(() => Array.from(new Set(items.map((i) => i.type).filter(Boolean))), [items]);
  const filtered = useMemo(
    () => (typeFilter === "all" ? items : items.filter((i) => i.type === typeFilter)),
    [items, typeFilter],
  );

  // Group by day for readable sections.
  const groups = useMemo(() => {
    const map = new Map<string, Entry[]>();
    for (const h of filtered.slice(0, limit)) {
      const key = h.date ? new Date(h.date).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—";
      const arr = map.get(key) ?? [];
      arr.push(h);
      map.set(key, arr);
    }
    return Array.from(map.entries());
  }, [filtered, limit]);

  async function downloadStatement() {
    if (!db || !user) return;
    const [o, u] = await Promise.all([
      get(query(ref(db, "orders"), orderByChild("uid"), equalTo(user.uid))),
      get(ref(db, `users/${user.uid}`)),
    ]);
    const me = { uid: user.uid, ...(u.val() || {}) };
    downloadCsv(
      buildStatementCsv([me], Object.values(o.val() || {}), `Statement for ${me.email || user.uid}`),
      `statement-${new Date().toISOString().slice(0, 10)}.csv`,
    );
  }

  if (!user) {
    return (
      <div className="fade-in">
        <EmptyState
          icon={Receipt}
          title="Log in to see your transactions"
          description="Deposits, purchases and refunds all show up here."
          action={<Button onClick={() => openModal("auth")}>Login</Button>}
        />
      </div>
    );
  }

  return (
    <div className="fade-in mx-auto max-w-3xl">
      <div className="mb-5">
        <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">Wallet history</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Current balance:{" "}
          <span className="font-display font-semibold tabular-nums text-foreground">${wallet}</span>
        </p>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger size="sm" className="w-[160px]" aria-label="Filter by type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {types.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={downloadStatement} className="ml-auto">
          <Download className="size-4" />
          Statement
        </Button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={Receipt} title="No transactions yet" description="Your wallet activity will appear here." />
      ) : (
        <div className="space-y-6 pb-10">
          {groups.map(([day, entries]) => (
            <section key={day}>
              <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {day}
              </h2>
              <Card className="gap-0 py-0">
                <CardContent className="divide-y divide-border p-0">
                  {entries.map((h) => {
                    const credit = isCredit(h.type);
                    return (
                      <div key={h.id} className="flex items-center gap-3 p-3">
                        <span
                          className={cn(
                            "flex size-9 shrink-0 items-center justify-center rounded-full",
                            credit ? "bg-success/10 text-success" : "bg-muted text-muted-foreground",
                          )}
                        >
                          {credit ? (
                            <ArrowDownLeft className="size-4" />
                          ) : (
                            <ArrowUpRight className="size-4" />
                          )}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-2 text-sm font-medium">
                            {h.type}
                            {h.status ? (
                              <Badge variant={h.status === "Paid" ? "default" : "muted"}>{h.status}</Badge>
                            ) : null}
                          </p>
                          {h.desc ? (
                            <p className="truncate text-xs text-muted-foreground">{h.desc}</p>
                          ) : null}
                        </div>
                        <span
                          className={cn(
                            "shrink-0 font-display text-sm font-bold tabular-nums",
                            credit ? "text-success" : "text-foreground",
                          )}
                        >
                          {credit ? "+" : "−"}${Math.abs(Number(h.amount))}
                        </span>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            </section>
          ))}

          {filtered.length > limit ? (
            <div className="flex justify-center">
              <Button variant="outline" onClick={() => setLimit((l) => l + 20)}>
                Show more ({filtered.length - limit} left)
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
