import { useEffect, useMemo, useState } from "react";
import { Fragment } from "react";
import { Download, FileText, Search } from "lucide-react";
import { get, onValue, ref, update } from "@/lib/fb/database";
import { buildStatementCsv, downloadCsv } from "@/lib/statement";
import { useStore } from "@/context/StoreContext";
import { deliveryBlock, emailShell, sendMail } from "@/lib/mailer";
import { notifyTelegramOrder } from "@/lib/telegram.functions";
import { websiteUrl } from "@/lib/referral";
import { exportOrdersCsv, exportOrdersPdf, type ExportRow } from "@/lib/export-orders";
import { downloadDeliveryTxt } from "@/lib/delivery-download";
import { Empty, type OrderRow } from "@/components/admin/shared";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
  if (status === "Completed") return "success";
  if (status === "Cancelled") return "destructive";
  return "secondary";
}

/** Order date + time, shown in the buyer's local timezone. */
function formatOrderDate(date: string): { date: string; time: string } {
  const d = date ? new Date(date) : null;
  if (!d || Number.isNaN(d.getTime())) return { date: "—", time: "" };
  return {
    date: d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }),
    time: d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
  };
}

export function OrdersAdmin({ orders }: { orders: OrderRow[] }) {
  const { db, products, config, notify, showSuccess } = useStore();
  const [deliverFor, setDeliverFor] = useState<OrderRow | null>(null);
  const [deliverLines, setDeliverLines] = useState<string[]>([]);
  const [deliverNote, setDeliverNote] = useState("");
  const [delivering, setDelivering] = useState(false);
  const [query, setQuery] = useState("");
  const [userNames, setUserNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!db) return;
    return onValue(ref(db, "users"), (snapshot) => {
      const names: Record<string, string> = {};
      Object.entries(snapshot.val() || {}).forEach(([uid, value]) => {
        const user = value as { name?: string };
        names[uid] = user.name || "";
      });
      setUserNames(names);
    });
  }, [db]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return orders;
    return orders.filter((order) =>
      [order.orderId, order.uid, order.email, order.phone, userNames[order.uid]]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(term)),
    );
  }, [orders, query, userNames]);

  function deliveryOf(item: { id?: string; title: string }) {
    const product = products.find((entry) => entry.id === item.id || entry.title === item.title);
    return product?.delivery === "auto"
      ? "Auto stock"
      : product?.delivery === "repeat"
        ? "Repeated"
        : "Manual";
  }

  async function downloadFullStatement() {
    if (!db) return;
    const [u, o] = await Promise.all([get(ref(db, "users")), get(ref(db, "orders"))]);
    const users = Object.entries(u.val() || {}).map(([uid, v]) => ({ uid, ...(v as object) }));
    downloadCsv(
      buildStatementCsv(
        users,
        Object.values(o.val() || {}),
        `${config.siteName || "Store"} — full statement`,
      ),
      `full-statement-${new Date().toISOString().slice(0, 10)}.csv`,
    );
  }

  function openDelivery(order: OrderRow) {
    setDeliverFor(order);
    setDeliverLines((order.items || []).map((_, index) => order.delivered?.[index]?.content ?? ""));
    setDeliverNote(order.deliveryNote ?? "");
  }

  async function completeDelivery() {
    if (!db || !deliverFor) return;
    const items = deliverFor.items || [];
    const delivered = items
      .map((item, index) => ({ title: item.title, content: (deliverLines[index] || "").trim() }))
      .filter((item) => item.content);
    if (!delivered.length && !deliverNote.trim())
      return notify("Add the delivery details the buyer should see");
    setDelivering(true);
    try {
      await update(ref(db, `orders/${deliverFor.orderId}`), {
        delivered,
        deliveryNote: deliverNote.trim(),
        status: "Completed",
        deliveredAt: new Date().toISOString(),
      });
      if (deliverFor.email)
        void sendMail(db, {
          to: deliverFor.email,
          subject: `${config.siteName || "Silvex AI"} · Order ${deliverFor.orderId.slice(-6)} delivered`,
          html: emailShell(
            config.siteName || "Silvex AI",
            "Your order is delivered 🎉",
            `<p>Thank you for your purchase — your order is complete. Here are your delivery details:</p>${deliveryBlock(delivered)}${deliverNote.trim() ? `<p style="background:#fff8e6;border:1px solid #ffe2a8;border-radius:12px;padding:12px;font-size:14px">${deliverNote.trim()}</p>` : ""}<p style="color:#8a8ca3;font-size:12px">Order ID: ${deliverFor.orderId} · Total: $${Number(deliverFor.total || 0).toFixed(2)}</p>`,
            {
              preheader: "Your items are ready",
              badge: "Delivered",
              ctaText: "View my order",
              ctaUrl: `${(config.siteUrl || websiteUrl()).replace(/\/+$/, "")}/orders`,
            },
          ),
          receipt: {
            orderId: deliverFor.orderId,
            siteName: config.siteName || "Silvex AI",
            total: Number(deliverFor.total || 0),
            note: deliverNote.trim() || undefined,
            items: delivered,
          },
        }).then((result) => {
          if (!result.ok) notify(`Email not sent: ${result.error}`);
        });
      void notifyTelegramOrder({
        data: {
          orderId: deliverFor.orderId,
          email: deliverFor.email || undefined,
          total: Number(deliverFor.total || 0),
          status: "Completed",
          items: items.map((item) => ({ title: item.title, qty: item.qty })),
          delivered,
          uid: deliverFor.uid,
        },
      }).catch(() => undefined);
      setDeliverFor(null);
      showSuccess("Delivered", "The buyer can now see the delivery details.");
    } finally {
      setDelivering(false);
    }
  }

  function exportFilteredRows(): ExportRow[] {
    return filtered.flatMap((order) => {
      const items = order.items || [];
      if (!items.length)
        return [
          {
            orderId: order.orderId,
            date: order.date,
            buyer: order.email || order.uid,
            product: "—",
            delivery: "—",
            amount: Number(order.total) || 0,
            status: order.status,
          },
        ];
      return items.map((item, index) => ({
        orderId: order.orderId,
        date: order.date,
        buyer: order.email || order.uid,
        product: `${item.title} × ${item.qty}`,
        delivery: deliveryOf(item),
        amount:
          item.price != null
            ? Number(item.price) * Number(item.qty || 1)
            : index === 0
              ? Number(order.total) || 0
              : 0,
        status: order.status,
      }));
    });
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search order ID, name, user ID, email…"
            className="pl-9"
          />
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => exportOrdersCsv(exportFilteredRows(), `orders-${Date.now()}.csv`)}
          >
            <Download className="size-4" /> CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              exportOrdersPdf(
                exportFilteredRows(),
                `${config.siteName || "Store"} — orders report`,
                `orders-${Date.now()}.pdf`,
              )
            }
          >
            <FileText className="size-4" /> PDF
          </Button>
          <Button variant="secondary" size="sm" onClick={downloadFullStatement}>
            Statement
          </Button>
        </div>
      </div>

      {!filtered.length ? (
        <Empty text={orders.length ? "No orders match your search." : "No orders yet."} />
      ) : (
        <Card className="gap-0 overflow-hidden py-0">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Buyer</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Items</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((order) => (
                  <Fragment key={order.orderId}>
                    <TableRow>
                      <TableCell className="font-mono text-xs">
                        #{order.orderId.slice(-6)}
                      </TableCell>
                      <TableCell className="max-w-[180px]">
                        <p className="truncate text-sm font-medium">
                          {userNames[order.uid] || order.email || order.uid}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {order.email} {order.phone ? `· ${order.phone}` : ""}
                        </p>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <p className="text-sm">{formatOrderDate(order.date).date}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatOrderDate(order.date).time}
                        </p>
                      </TableCell>
                      <TableCell className="max-w-[220px]">
                        <p className="truncate text-sm text-muted-foreground">
                          {(order.items || []).map((i) => `${i.title} ×${i.qty}`).join(", ") || "—"}
                        </p>
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">
                        ${order.total}
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(order.status)}>{order.status}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1.5">
                          {order.delivered?.length ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 px-2"
                              onClick={() => downloadDeliveryTxt(order)}
                              aria-label="Download delivery"
                            >
                              <Download className="size-4" />
                            </Button>
                          ) : null}
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8"
                            onClick={() => openDelivery(order)}
                          >
                            {order.status === "Completed" ? "Edit" : "Deliver"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 text-destructive hover:bg-destructive/10"
                            onClick={() =>
                              db &&
                              update(ref(db, `orders/${order.orderId}`), {
                                status: "Cancelled",
                              }).then(() => notify("Order marked Cancelled"))
                            }
                          >
                            Cancel
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                    {deliverFor?.orderId === order.orderId ? (
                      <TableRow>
                        <TableCell colSpan={7} className="bg-muted/30">
                          <div className="space-y-3 py-2">
                            <p className="text-sm font-semibold">Delivery details</p>
                            {(order.items || []).map((item, index) => (
                              <div key={index}>
                                <Label className="mb-1 text-xs text-muted-foreground">
                                  {item.title} × {item.qty}
                                </Label>
                                <Textarea
                                  rows={2}
                                  value={deliverLines[index] ?? ""}
                                  onChange={(e) => {
                                    const next = [...deliverLines];
                                    next[index] = e.target.value;
                                    setDeliverLines(next);
                                  }}
                                />
                              </div>
                            ))}
                            <Textarea
                              rows={2}
                              placeholder="Note for the buyer (optional)"
                              value={deliverNote}
                              onChange={(e) => setDeliverNote(e.target.value)}
                            />
                            <div className="flex gap-2">
                              <Button disabled={delivering} onClick={completeDelivery}>
                                {delivering ? "Sending…" : "Mark delivered & notify buyer"}
                              </Button>
                              <Button variant="outline" onClick={() => setDeliverFor(null)}>
                                Close
                              </Button>
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
