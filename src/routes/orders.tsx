import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  Copy,
  Download,
  PackageCheck,
  Wallet,
} from "lucide-react";
import { equalTo, onValue, orderByChild, query, ref } from "@/lib/fb/database";
import { cancelMyOrder } from "@/lib/wallet.functions";
import { useStore } from "@/context/StoreContext";
import { downloadDeliveryTxt } from "@/lib/delivery-download";
import type { CartItem } from "@/context/StoreContext";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { EmptyState } from "@/components/ui/empty-state";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@radix-ui/react-collapsible";

export const Route = createFileRoute("/orders")({
  head: () => ({
    meta: [
      { title: "Orders — Silvex AI" },
      {
        name: "description",
        content: "Track your Silvex AI orders, delivery status and wallet refunds.",
      },
      { property: "og:title", content: "Orders — Silvex AI" },
      { property: "og:description", content: "Track your orders and refunds in one place." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Orders,
});

type Order = {
  orderId: string;
  items: CartItem[];
  total: number;
  status: string;
  date: string;
  deliveryNote?: string;
  delivered?: { title: string; content: string }[];
};

function statusVariant(status: string): "success" | "destructive" | "secondary" {
  if (status === "Completed") return "success";
  if (status === "Cancelled") return "destructive";
  return "secondary";
}

function Orders() {
  const { db, user, wallet, openModal, showSuccess } = useStore();
  const [orders, setOrders] = useState<Order[]>([]);

  useEffect(() => {
    if (!db || !user) return;
    return onValue(query(ref(db, "orders"), orderByChild("uid"), equalTo(user.uid)), (s) => {
      const val = s.val() || {};
      setOrders((Object.values(val) as Order[]).sort((a, b) => (a.date < b.date ? 1 : -1)));
    });
  }, [db, user]);

  async function cancelOrder(order: Order) {
    if (!db || !user) return;
    const res = await cancelMyOrder({
      data: { idToken: await user.getIdToken(), orderId: order.orderId },
    });
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    showSuccess("Cancelled", "Amount refunded to your wallet.");
  }

  if (!user) {
    return (
      <div className="fade-in">
        <EmptyState
          icon={PackageCheck}
          title="Log in to see your orders"
          description="Your purchase history and deliveries live here."
          action={<Button onClick={() => openModal("auth")}>Login</Button>}
        />
      </div>
    );
  }

  return (
    <div className="fade-in">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">Orders</h1>
        <Badge variant="muted" className="gap-1 px-2.5 py-1 text-sm">
          <Wallet className="size-3.5" /> ${wallet}
        </Badge>
      </div>

      {orders.length === 0 ? (
        <EmptyState icon={PackageCheck} title="No orders yet" description="Your purchases will appear here." />
      ) : (
        <div className="space-y-4 pb-10">
          {orders.map((o) => (
            <Card key={o.orderId} className="gap-0 py-0">
              <CardContent className="p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="font-mono text-xs font-semibold text-muted-foreground">
                    #{o.orderId.slice(-6)}
                  </span>
                  <Badge variant={statusVariant(o.status)}>{o.status}</Badge>
                </div>

                <ul className="space-y-1 text-sm">
                  {(o.items || []).map((i) => (
                    <li key={i.id} className="flex justify-between gap-3">
                      <span className="line-clamp-1 text-muted-foreground">
                        {i.title} × {i.qty}
                      </span>
                      <span className="font-medium tabular-nums">${i.price * i.qty}</span>
                    </li>
                  ))}
                </ul>

                {(o.delivered || []).length ? (
                  <Collapsible className="mt-3">
                    <div className="flex items-center justify-between rounded-t-xl bg-success/10 px-3 py-2">
                      <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs font-semibold text-success">
                        <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" />
                        Delivered items ({o.delivered!.length})
                      </CollapsibleTrigger>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1 px-2 text-xs text-success hover:bg-success/10"
                        onClick={() => downloadDeliveryTxt(o)}
                      >
                        <Download className="size-3.5" /> .txt
                      </Button>
                    </div>
                    <CollapsibleContent className="space-y-2 rounded-b-xl bg-success/5 p-3">
                      {(o.delivered || []).map((d, idx) => (
                        <DeliveredLine key={idx} content={d.content} />
                      ))}
                    </CollapsibleContent>
                  </Collapsible>
                ) : null}

                {o.deliveryNote ? (
                  <div className="mt-3 rounded-xl bg-success/5 p-3 text-xs font-medium text-success">
                    {o.deliveryNote}
                  </div>
                ) : null}

                <Separator className="my-3" />
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {new Date(o.date).toLocaleString()}
                  </span>
                  <span className="font-display text-lg font-bold tabular-nums">${o.total}</span>
                </div>

                {o.status === "Pending" ? (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="outline" className="mt-3 w-full text-destructive hover:bg-destructive/10">
                        Cancel &amp; refund
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Cancel this order?</AlertDialogTitle>
                        <AlertDialogDescription>
                          The full amount will be refunded to your wallet. This cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Keep order</AlertDialogCancel>
                        <AlertDialogAction
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          onClick={() => cancelOrder(o)}
                        >
                          Cancel &amp; refund
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function DeliveredLine({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(content);
    setCopied(true);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="flex items-center gap-2 rounded-lg bg-card p-2">
      <p className="min-w-0 flex-1 break-all font-mono text-xs text-foreground">{content}</p>
      <Button
        size="icon"
        variant="ghost"
        className={cn("size-7 shrink-0", copied && "text-success")}
        aria-label="Copy delivered item"
        onClick={copy}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </Button>
    </div>
  );
}
