import { useEffect, useState } from "react";
import { onValue, ref } from "@/lib/fb/database";
import { useStore } from "@/context/StoreContext";
import { decideRequestWeb } from "@/lib/wallet.functions";
import { Empty, type RequestRow } from "@/components/admin/shared";

export function RequestsAdmin() {
  const { db, notify } = useStore();
  const [requests, setRequests] = useState<RequestRow[]>([]);

  useEffect(() => {
    if (!db) return;
    return onValue(ref(db, "requests"), (snapshot) => setRequests(
      Object.entries(snapshot.val() || {})
        .map(([id, request]) => ({ id, ...(request as Omit<RequestRow, "id">) }))
        .sort((a, b) => (a.date < b.date ? 1 : -1)),
    ));
  }, [db]);

  async function decide(request: RequestRow, approve: boolean) {
    // Done on the server in one atomic step, so a double click or two admins
    // can never apply the same request twice or overwrite a concurrent change.
    const res = await decideRequestWeb({ data: { id: request.id, approve } }).catch((e) => ({
      ok: false as const,
      error: e instanceof Error ? e.message : "Could not update the request",
    }));
    if (!res.ok) return notify("error" in res ? res.error : "Could not update the request");
    notify(approve ? "Approved" : "Rejected");
  }

  return (
    <div className="space-y-3">
      {requests.map((request) => (
        <div key={request.id} className="rounded-2xl border border-border bg-card p-4">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-xs font-bold">
            <span className="min-w-0 truncate">{request.type} · ${request.amount}</span>
            <span className="shrink-0">{request.status}</span>
          </div>
          <p className="mt-1 break-words text-xs text-muted-foreground">{request.name} · {request.email}</p>
          <p className="break-all text-xs text-muted-foreground">{request.utr || request.upi}</p>
          {request.status === "Pending" ? <div className="mt-3 grid grid-cols-2 gap-2">
            <button onClick={() => decide(request, true)} className="rounded-lg bg-emerald-500 py-2 text-xs font-bold text-white">Approve</button>
            <button onClick={() => decide(request, false)} className="rounded-lg bg-destructive py-2 text-xs font-bold text-destructive-foreground">Reject</button>
          </div> : null}
        </div>
      ))}
      {!requests.length ? <Empty text="No wallet requests." /> : null}
    </div>
  );
}