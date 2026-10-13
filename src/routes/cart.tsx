import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Minus, Plus, ShoppingCart, Trash2, Wallet } from "lucide-react";
import { get, ref } from "@/lib/fb/database";
import { useStore } from "@/context/StoreContext";
import { deliveryBlock, emailShell, itemsTable, sendMail } from "@/lib/mailer";
import { notifyTelegramOrder } from "@/lib/telegram.functions";
import { websiteUrl } from "@/lib/referral";
import { checkoutCart } from "@/lib/wallet.functions";

import { Emo } from "@/components/store/Emo";
import { productImageSrc } from "@/lib/product-image";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";


export const Route = createFileRoute("/cart")({
  head: () => ({
    meta: [
      { title: "Your Cart — Silvex AI" },
      {
        name: "description",
        content: "Review your items, apply a promo code and pay instantly from your wallet.",
      },
      { property: "og:title", content: "Your Cart — Silvex AI" },
      { property: "og:description", content: "Review items and pay instantly from your wallet." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Cart,
});

function Cart() {
  const { db, user, profile, cart, cartTotal, setQty, clearCart, wallet, config, openModal, showSuccess, notify, siteName, emoji } =
    useStore();
  const navigate = useNavigate();
  const [coupon, setCoupon] = useState("");
  const [discount, setDiscount] = useState(0);
  const [couponMsg, setCouponMsg] = useState("");
  const [couponOk, setCouponOk] = useState(false);
  const [phone, setPhone] = useState(profile?.phone ?? "");
  const [editPhone, setEditPhone] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  // Remember the WhatsApp number: once saved on the profile it is reused automatically.
  useEffect(() => {
    if (profile?.phone) setPhone(profile.phone);
  }, [profile?.phone]);

  const total = Math.max(0, cartTotal - discount);

  async function applyCoupon() {
    if (!db || !user) return openModal("auth");
    const code = coupon.trim().toUpperCase();
    if (!code) return;
    const snap = await get(ref(db, `coupons/${code}`));
    if (!snap.exists()) {
      setDiscount(0);
      setCouponOk(false);
      return setCouponMsg("Invalid code");
    }
    const c = snap.val();
    if (cartTotal < Number(c.minOrder || 0)) {
      setDiscount(0);
      setCouponOk(false);
      return setCouponMsg(`Minimum order $${c.minOrder}`);
    }
    const used = await get(ref(db, `users/${user.uid}/used_coupons/${code}`));
    if ((Number(used.val()) || 0) >= Number(c.maxUsage || 1)) {
      setDiscount(0);
      setCouponOk(false);
      return setCouponMsg("Already used!");
    }
    const value =
      c.type === "percent"
        ? Math.round((cartTotal * Number(c.value)) / 100)
        : Number(c.value);
    setDiscount(value);
    setCouponOk(true);
    setCouponMsg(`Coupon applied: −$${value}`);
  }

  async function checkout() {
    if (!user || !db) return openModal("auth");
    if (cart.length === 0) return;
    const soldOutItem = cart.find((i) => i.soldOut);
    if (soldOutItem) return notify(`${soldOutItem.title} is out of stock`);
    if (phone.length < 10) return notify("Enter your WhatsApp number");
    if (wallet < total) return notify("Not enough wallet balance");
    setBusy(true);
    try {
      const res = await checkoutCart({
        data: {
          idToken: await user.getIdToken(),
          items: cart.map((i) => ({ id: i.id, qty: i.qty })),
          coupon: discount > 0 ? coupon.trim().toUpperCase() : undefined,
          phone,
          note,
        },
      });
      if (!res.ok) return notify(res.error);
      const { orderId, delivered, total } = res;
      const allDelivered = res.status === "Completed";
      const partialRefunds = res.refunded > 0 ? [{ amount: res.refunded }] : [];
      if (user.email) {
        const done = allDelivered;
        sendMail(db, {
          to: user.email,
          subject: `${siteName} · Order ${orderId.slice(-6)} ${done ? "delivered" : "received"}`,
          html: emailShell(
            siteName,
            done ? `Your order is delivered ${emoji("web.party")}` : `Order received ${emoji("web.ok")}`,
            `<p>Hi${user.displayName ? " " + user.displayName : ""}, thanks for your purchase.</p>
             ${itemsTable(
               res.items.map((i) => ({ title: i.title, qty: i.qty, amount: i.price * i.qty })),
               total,
             )}
             ${done ? "<p><b>Your delivery details:</b></p>" + deliveryBlock(delivered) : "<p>Our team is preparing your order. You will get another email the moment it is delivered.</p>"}
             <p style="color:#8a8ca3;font-size:12px">Order ID: ${orderId}</p>`,
            {
              preheader: done ? "Your items are ready" : "We received your order",
              ctaText: "View my order",
              ctaUrl: `${(config.siteUrl || websiteUrl()).replace(/\/+$/, "")}/orders`,
            },
          ),
          ...(done ? { receipt: { orderId, siteName, total, items: delivered } } : {}),
        }).then((r) => {
          if (!r.ok) notify(`Email not sent: ${r.error}`);
        });
      }

      void notifyTelegramOrder({
        data: {
          orderId,
          email: user.email || undefined,
          total,
          status: delivered.length && allDelivered ? "Completed" : "Pending",
          items: cart.map((i) => ({ title: i.title, qty: i.qty })),
          delivered,
          uid: user.uid,
        },
      }).catch(() => undefined);
      clearCart();

      setDiscount(0);
      showSuccess(
        delivered.length && allDelivered ? "Delivered!" : "Order placed",
        delivered.length && allDelivered
          ? "Your item is ready in Orders."
          : partialRefunds.length
            ? `Some items were unavailable — $${partialRefunds.reduce((s, pr) => s + pr.amount, 0).toFixed(2)} was refunded to your wallet.`
            : "We'll deliver it shortly. Check Orders for status.",
      );
      navigate({ to: "/orders" });
    } finally {
      setBusy(false);
    }
  }

  const insufficient = wallet < total;

  return (
    <div className="fade-in">
      <h1 className="font-display mb-4 text-2xl font-bold tracking-tight sm:text-3xl">My cart</h1>
      {cart.length === 0 ? (
        <EmptyState
          icon={ShoppingCart}
          title="Your cart is empty"
          description="Browse the shop and add items to get started."
          action={
            <Button onClick={() => navigate({ to: "/products" })}>Browse products</Button>
          }
        />
      ) : (
        <div className="grid gap-6 pb-28 lg:grid-cols-[1fr_380px] lg:pb-10">
          {/* Line items */}
          <div className="space-y-3">
            {cart.map((i) => (
              <Card key={i.id} className="py-0">
                <CardContent className="flex items-center gap-3 p-3">
                  {i.logo ? (
                    <img
                      src={productImageSrc(i.id, i.logo)}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="size-16 shrink-0 rounded-xl object-cover"
                    />
                  ) : (
                    <div className="flex size-16 shrink-0 items-center justify-center rounded-xl bg-muted text-xl">
                      <Emo k="web.bag" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <h3 className="line-clamp-1 text-sm font-semibold">{i.title}</h3>
                    {i.discountLabel ? (
                      <Badge variant="destructive" className="mt-0.5">
                        {i.discountLabel}
                      </Badge>
                    ) : null}
                    <p className="mt-0.5 font-display text-sm font-bold tabular-nums">${i.price}</p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        aria-label="Decrease quantity"
                        onClick={() => setQty(i.id, i.qty - 1)}
                      >
                        <Minus className="size-3.5" />
                      </Button>
                      <span className="w-6 text-center text-sm font-semibold tabular-nums">{i.qty}</span>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        aria-label="Increase quantity"
                        onClick={() => setQty(i.id, i.qty + 1)}
                      >
                        <Plus className="size-3.5" />
                      </Button>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-destructive"
                      aria-label={`Remove ${i.title}`}
                      onClick={() => setQty(i.id, 0)}
                    >
                      <Trash2 className="size-3.5" />
                      Remove
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Summary */}
          <div className="lg:sticky lg:top-20 lg:self-start">
            <Card>
              <CardContent className="space-y-4">
                <h2 className="font-display text-base font-semibold">Order summary</h2>

                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span className="font-medium tabular-nums">${cartTotal}</span>
                </div>
                {discount > 0 ? (
                  <div className="flex items-center justify-between text-sm text-success">
                    <span>Discount</span>
                    <span className="font-medium tabular-nums">−${discount}</span>
                  </div>
                ) : null}

                {/* Coupon */}
                <div>
                  <Label htmlFor="coupon" className="mb-1.5 text-xs text-muted-foreground">
                    Promo code
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="coupon"
                      value={coupon}
                      onChange={(e) => setCoupon(e.target.value.toUpperCase())}
                      placeholder="PROMO CODE"
                      className="uppercase"
                    />
                    <Button variant="secondary" onClick={applyCoupon}>
                      Apply
                    </Button>
                  </div>
                  {couponMsg ? (
                    <p
                      className={cn(
                        "mt-1.5 text-xs font-medium",
                        couponOk ? "text-success" : "text-destructive",
                      )}
                    >
                      {couponMsg}
                    </p>
                  ) : null}
                </div>

                <Separator />

                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">Total payable</span>
                  <span className="font-display text-2xl font-bold tabular-nums text-primary">${total}</span>
                </div>

                {/* WhatsApp + note */}
                {profile?.phone && !editPhone ? (
                  <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/50 p-3">
                    <p className="flex-1 text-sm">
                      <span className="text-muted-foreground">WhatsApp: </span>
                      <span className="font-semibold">{profile.phone}</span>
                    </p>
                    <Button size="sm" variant="outline" onClick={() => setEditPhone(true)}>
                      Change
                    </Button>
                  </div>
                ) : (
                  <div>
                    <Label htmlFor="phone" className="mb-1.5 text-xs text-muted-foreground">
                      WhatsApp number (required)
                    </Label>
                    <Input
                      id="phone"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="WhatsApp number"
                      inputMode="tel"
                    />
                  </div>
                )}
                <div>
                  <Label htmlFor="note" className="mb-1.5 text-xs text-muted-foreground">
                    Email / ID (optional)
                  </Label>
                  <Input
                    id="note"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Email or account ID"
                  />
                </div>

                <div className="flex items-center justify-between rounded-xl bg-muted/50 px-3 py-2 text-sm">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <Wallet className="size-4" /> Wallet balance
                  </span>
                  <span className="font-semibold tabular-nums">${wallet}</span>
                </div>

                {insufficient ? (
                  <Button variant="outline" className="w-full" onClick={() => openModal("wallet")}>
                    Top up wallet
                  </Button>
                ) : null}

                {/* Desktop checkout */}
                <Button
                  className="hidden w-full lg:flex"
                  size="lg"
                  onClick={checkout}
                  disabled={busy || insufficient}
                >
                  {busy ? "Processing…" : "Pay from wallet"}
                </Button>
              </CardContent>
            </Card>
          </div>

          {/* Sticky mobile checkout bar */}
          <div
            className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 p-3 backdrop-blur-md lg:hidden"
            style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
          >
            <div className="mx-auto flex max-w-7xl items-center gap-3">
              <div className="shrink-0">
                <p className="text-[11px] text-muted-foreground">Total</p>
                <p className="font-display text-lg font-bold tabular-nums text-primary">${total}</p>
              </div>
              <Button className="flex-1" size="lg" onClick={checkout} disabled={busy || insufficient}>
                {busy ? "Processing…" : insufficient ? "Insufficient balance" : "Pay from wallet"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
