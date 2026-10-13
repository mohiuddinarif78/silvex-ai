import { useEffect, useState } from "react";
import { onValue, ref } from "@/lib/fb/database";
import { useStore } from "@/context/StoreContext";
import { decideRequestWeb } from "@/lib/wallet.functions";
import { Empty, type RequestRow } from "@/components/admin/shared";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

function statusVariant(status: string): "success" | "destructive" | "secondary" {
  if (status === "Approved" || status === "Credited") return "success";
  if (status === "Rejected") return "destructive";
  return "secondary";
}

export function RequestsAdmin() {
  const { db, notify } = useStore();
  const [requests, setRequests] = useState<RequestRow[]>([]);

  useEffect(() => {
    if (!db) return;
    return onValue(ref(db, "requests"), (snapshot) =>
      setRequests(
        Object.entries(snapshot.val() || {})
          .map(([id, request]) => ({ id, ...(request as Omit<RequestRow, "id">) }))
          .sort((a, b) => (a.date < b.date ? 1 : -1)),
      ),
    );
  }, [db]);

  async function decide(request: RequestRow, approve: boolean) {
    const res = await decideRequestWeb({ data: { id: request.id, approve } }).catch((e) => ({
      ok: false as const,
      error: e instanceof Error ? e.message : "Could not update the request",
    }));
    if (!res.ok) return notify("error" in res ? res.error : "Could not update the request");
    notify(approve ? "Approved" : "Rejected");
  }

  if (!requests.length) return <Empty text="No wallet requests." />;

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Reference</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {requests.map((request) => (
              <TableRow key={request.id}>
                <TableCell className="max-w-[180px]">
                  <p className="truncate text-sm font-medium">{request.name || "User"}</p>
                  <p className="truncate text-xs text-muted-foreground">{request.email}</p>
                </TableCell>
                <TableCell className="text-sm">{request.type}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">${request.amount}</TableCell>
                <TableCell className="max-w-[160px]">
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {request.utr || request.upi || "—"}
                  </span>
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant(request.status)}>{request.status}</Badge>
                </TableCell>
                <TableCell className="text-right">
                  {request.status === "Pending" ? (
                    <div className="flex justify-end gap-1.5">
                      <Button size="sm" className="h-8" onClick={() => decide(request, true)}>
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 text-destructive hover:bg-destructive/10"
                        onClick={() => decide(request, false)}
                      >
                        Reject
                      </Button>
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
