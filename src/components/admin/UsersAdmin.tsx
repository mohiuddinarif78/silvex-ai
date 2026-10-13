import { useEffect, useMemo, useState } from "react";
import { ChevronDown, History as HistoryIcon, Search, Wallet } from "lucide-react";
import { get, onValue, push, ref, set, update } from "@/lib/fb/database";
import { useStore, isOwnerEmail, isFixedOwner } from "@/context/StoreContext";
import { reportBalanceChange } from "@/lib/wallet.functions";
import { input, Empty } from "@/components/admin/shared";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@radix-ui/react-collapsible";

type HistoryRow = {
  id: string;
  type?: string;
  amount?: number;
  desc?: string;
  date?: string;
  status?: string;
};

type UserRow = {
  uid: string;
  name?: string;
  email?: string;
  wallet?: number;
  phone?: string;
  isAdmin?: boolean;
  isOwner?: boolean;
  hidden?: boolean;
};

type SortMode = "none" | "deposits" | "wallet" | "orders";
type RawUser = Omit<UserRow, "uid"> & { history?: Record<string, HistoryRow> };

export function UsersAdmin() {
  const { db, user, notify } = useStore();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [orderCounts, setOrderCounts] = useState<Record<string, number>>({});
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("none");
  const [listLimit, setListLimit] = useState(10);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [historyLimit, setHistoryLimit] = useState(10);
  const [walletSearch, setWalletSearch] = useState("");
  const [walletLimit, setWalletLimit] = useState(10);

  // Wallet editor dialog state
  const [editUser, setEditUser] = useState<UserRow | null>(null);
  const [editAmount, setEditAmount] = useState("");
  const [editConfirm, setEditConfirm] = useState("");
  const [editBusy, setEditBusy] = useState(false);

  const allWalletRows = useMemo(
    () =>
      users
        .flatMap((u) =>
          Object.entries((u as RawUser).history || {}).map(([id, h]) => ({
            id,
            ...(h as Omit<HistoryRow, "id">),
            userName: u.name || "User",
            userEmail: u.email || "",
          })),
        )
        .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")),
    [users],
  );
  const walletFiltered = allWalletRows.filter((h) =>
    `${h.userName} ${h.userEmail} ${h.type ?? ""} ${h.desc ?? ""}`
      .toLowerCase()
      .includes(walletSearch.toLowerCase()),
  );

  useEffect(() => {
    if (!db) return;
    get(ref(db, "orders")).then((s) => {
      const counts: Record<string, number> = {};
      Object.values(s.val() || {}).forEach((o) => {
        const uid = (o as { userId?: string; uid?: string }).userId ?? (o as { uid?: string }).uid;
        if (uid) counts[uid] = (counts[uid] ?? 0) + 1;
      });
      setOrderCounts(counts);
    });
  }, [db]);

  useEffect(() => {
    if (!db || !historyFor) {
      setHistory([]);
      return;
    }
    return onValue(ref(db, `users/${historyFor}/history`), (s) => {
      const val = s.val() || {};
      setHistory(
        Object.entries(val)
          .map(([id, h]) => ({ id, ...(h as Omit<HistoryRow, "id">) }))
          .reverse(),
      );
    });
  }, [db, historyFor]);

  useEffect(() => {
    if (!db) return;
    return onValue(ref(db, "users"), (s) =>
      setUsers(Object.entries(s.val() || {}).map(([uid, u]) => ({ uid, ...(u as Omit<UserRow, "uid">) }))),
    );
  }, [db]);

  const disguised = users.map((u) => {
    const otherOwner = isOwnerEmail(u.email) && u.uid !== user?.uid;
    return otherOwner ? { ...u, isOwner: false, isAdmin: false, hidden: true } : u;
  });

  const depositTotal = (u: UserRow) =>
    Object.values((u as RawUser).history || {})
      .filter((h) => h.type === "Deposit")
      .reduce((sum, h) => sum + (h.amount ?? 0), 0);

  const searched = disguised.filter((u) =>
    `${u.name ?? ""} ${u.email ?? ""}`.toLowerCase().includes(search.toLowerCase()),
  );
  const sorted =
    sortMode === "deposits"
      ? [...searched].sort((a, b) => depositTotal(b) - depositTotal(a))
      : sortMode === "wallet"
        ? [...searched].sort((a, b) => (b.wallet ?? 0) - (a.wallet ?? 0))
        : sortMode === "orders"
          ? [...searched].sort((a, b) => (orderCounts[b.uid] ?? 0) - (orderCounts[a.uid] ?? 0))
          : searched;
  const list = sorted.slice(0, listLimit);

  function openWalletEditor(u: UserRow) {
    setEditUser(u);
    setEditAmount(String(u.wallet ?? 0));
    setEditConfirm("");
  }

  async function saveWallet() {
    if (!db || !editUser) return;
    const u = editUser;
    const amount = Number(editAmount);
    if (Number.isNaN(amount) || amount < 0) return notify("Enter a valid amount");
    const before = Number(u.wallet ?? 0);
    const change = amount - before;
    if (Math.abs(change) < 0.0001) return notify("Balance unchanged");
    // Big changes need the amount typed back (same safeguard as before).
    if (Math.abs(change) >= 20 && Number(editConfirm) !== amount) {
      return notify(`Big change — type ${amount} again to confirm.`);
    }
    setEditBusy(true);
    try {
      await set(ref(db, `users/${u.uid}/wallet`), amount);
      await push(ref(db, `users/${u.uid}/history`), {
        type: "Adjustment",
        amount: change,
        desc: `Balance set by admin ${user?.email || ""} ($${before.toFixed(2)} → $${amount.toFixed(2)})`,
        by: user?.email || "",
        date: new Date().toISOString(),
      });
      void user
        ?.getIdToken()
        .then((idToken) =>
          reportBalanceChange({
            data: {
              idToken,
              uid: u.uid,
              type: "Adjustment",
              amount: change,
              desc: `Balance set by admin ($${before.toFixed(2)} → $${amount.toFixed(2)})`,
            },
          }),
        )
        .catch(() => undefined);
      notify("Balance updated");
      setEditUser(null);
    } finally {
      setEditBusy(false);
    }
  }

  const editChange = editUser ? Number(editAmount || 0) - Number(editUser.wallet ?? 0) : 0;
  const needsConfirm = Math.abs(editChange) >= 20;

  return (
    <div className="space-y-4">
      {/* Search + filters */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Search name or email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        {(
          [
            ["none", "All users"],
            ["deposits", "High deposit"],
            ["wallet", "High balance"],
            ["orders", "High orders"],
          ] as [SortMode, string][]
        ).map(([mode, label]) => (
          <button
            key={mode}
            onClick={() => {
              setSortMode(mode);
              setListLimit(10);
            }}
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
              sortMode === mode
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card hover:border-primary/40",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* All wallet changes */}
      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button variant="outline" className="w-full justify-between">
            <span className="flex items-center gap-2">
              <Wallet className="size-4" /> Wallet changes ({allWalletRows.length})
            </span>
            <ChevronDown className="size-4 transition-transform data-[state=open]:rotate-180" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2">
          <Card>
            <CardContent className="space-y-2">
              <Input
                placeholder="Search user, type or description"
                value={walletSearch}
                onChange={(e) => {
                  setWalletSearch(e.target.value);
                  setWalletLimit(10);
                }}
              />
              {walletFiltered.length === 0 ? (
                <p className="py-2 text-center text-xs text-muted-foreground">No wallet changes found.</p>
              ) : (
                walletFiltered.slice(0, walletLimit).map((h) => (
                  <div
                    key={`${h.userEmail}-${h.id}`}
                    className="flex items-center justify-between gap-3 rounded-xl border border-border p-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-xs font-semibold">
                        {h.userName} <span className="text-muted-foreground">({h.userEmail})</span>
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {h.type} — {h.desc}
                      </p>
                    </div>
                    <span className="shrink-0 font-display text-sm font-bold tabular-nums">${h.amount ?? 0}</span>
                  </div>
                ))
              )}
              {walletFiltered.length > walletLimit ? (
                <Button variant="ghost" size="sm" className="w-full" onClick={() => setWalletLimit((l) => l + 20)}>
                  Show more
                </Button>
              ) : null}
            </CardContent>
          </Card>
        </CollapsibleContent>
      </Collapsible>

      {/* Users */}
      {list.length === 0 ? (
        <Empty text="No users found." />
      ) : (
        <div className="space-y-3">
          {list.map((u) => (
            <Card key={u.uid} className="gap-0 py-0">
              <CardContent className="p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{u.name || "User"}</p>
                    <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                  </div>
                  <span className="shrink-0 font-display text-base font-bold tabular-nums">${u.wallet ?? 0}</span>
                </div>
                {sortMode !== "none" ? (
                  <p className="mt-1 text-xs font-medium text-muted-foreground">
                    {sortMode === "deposits"
                      ? `Total deposited: $${depositTotal(u).toFixed(2)}`
                      : sortMode === "orders"
                        ? `Orders: ${orderCounts[u.uid] ?? 0}`
                        : `Wallet balance: $${u.wallet ?? 0}`}
                  </p>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => openWalletEditor(u)}>
                    <Wallet className="size-4" /> Set balance
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-primary hover:bg-primary/10"
                    onClick={() => {
                      setHistoryFor(historyFor === u.uid ? null : u.uid);
                      setHistoryLimit(10);
                    }}
                  >
                    <HistoryIcon className="size-4" />
                    {historyFor === u.uid ? "Hide history" : "History"}
                  </Button>
                  {u.uid === user?.uid ? (
                    <Badge variant="muted">You</Badge>
                  ) : isFixedOwner(u.email) ? (
                    <Badge variant="muted" className="bg-accent/10 text-accent-foreground">
                      Permanent owner
                    </Badge>
                  ) : u.isAdmin || u.hidden ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:bg-destructive/10"
                      onClick={async () => {
                        if (!db) return;
                        await update(ref(db, `users/${u.uid}`), {
                          isAdmin: false,
                          isOwner: false,
                          ownerRevoked: true,
                        });
                        notify("Access removed");
                      }}
                    >
                      Remove admin
                    </Button>
                  ) : null}
                </div>

                {historyFor === u.uid ? (
                  <div className="mt-3 space-y-2 border-t border-border pt-3">
                    <p className="text-xs font-semibold text-muted-foreground">Wallet history</p>
                    {history.length === 0 ? (
                      <p className="py-2 text-center text-xs text-muted-foreground">No transactions yet.</p>
                    ) : (
                      history.slice(0, historyLimit).map((h) => (
                        <div
                          key={h.id}
                          className="flex items-center justify-between gap-3 rounded-xl border border-border p-2.5"
                        >
                          <div className="min-w-0">
                            <p className="flex items-center gap-2 text-xs font-semibold">
                              {h.type}
                              {h.status ? (
                                <Badge variant={h.status === "Paid" ? "default" : "muted"}>{h.status}</Badge>
                              ) : null}
                            </p>
                            <p className="truncate text-[11px] text-muted-foreground">{h.desc}</p>
                          </div>
                          <span className="shrink-0 font-display text-sm font-bold tabular-nums">${h.amount ?? 0}</span>
                        </div>
                      ))
                    )}
                    {history.length > historyLimit ? (
                      <Button variant="ghost" size="sm" className="w-full" onClick={() => setHistoryLimit((l) => l + 20)}>
                        Show more
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ))}

          {sorted.length > listLimit ? (
            <div className="flex justify-center">
              <Button variant="outline" onClick={() => setListLimit((l) => l + 20)}>
                Show more ({sorted.length - listLimit} left)
              </Button>
            </div>
          ) : null}
        </div>
      )}

      {/* Wallet editor dialog */}
      <Dialog open={Boolean(editUser)} onOpenChange={(open) => !open && setEditUser(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Set wallet balance</DialogTitle>
            <DialogDescription>
              {editUser?.email || editUser?.uid} · current ${Number(editUser?.wallet ?? 0).toFixed(2)}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="wallet-amount" className="mb-1.5">
                New balance ($)
              </Label>
              <Input
                id="wallet-amount"
                inputMode="decimal"
                value={editAmount}
                onChange={(e) => setEditAmount(e.target.value)}
                autoFocus
              />
            </div>
            {editAmount !== "" && !Number.isNaN(Number(editAmount)) ? (
              <p
                className={cn(
                  "text-xs font-medium",
                  editChange >= 0 ? "text-success" : "text-destructive",
                )}
              >
                {editChange >= 0 ? "+" : "−"}${Math.abs(editChange).toFixed(2)} change
              </p>
            ) : null}
            {needsConfirm ? (
              <div>
                <Label htmlFor="wallet-confirm" className="mb-1.5 text-destructive">
                  Large change — type {Number(editAmount)} again to confirm
                </Label>
                <Input
                  id="wallet-confirm"
                  inputMode="decimal"
                  value={editConfirm}
                  onChange={(e) => setEditConfirm(e.target.value)}
                />
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditUser(null)}>
              Cancel
            </Button>
            <Button onClick={saveWallet} disabled={editBusy}>
              {editBusy ? "Saving…" : "Update balance"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
