import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Clock, Headphones, ShieldCheck, Zap } from "lucide-react";

import { useStore } from "@/context/StoreContext";
import { ProductCard, ProductCardSkeleton, ProductGrid } from "@/components/store/ProductCard";
import { Emo } from "@/components/store/Emo";
import { SupportButtons } from "@/components/store/SupportButtons";
import { MarqueeBar } from "@/components/store/MarqueeBar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
} from "@/components/ui/carousel";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Silvex AI — Cheapest Premium Subscriptions & AI Tools" },
      {
        name: "description",
        content:
          "Silvex AI: buy Gemini, ChatGPT, Canva, CapCut, Lovable and other premium subscriptions and AI tools at the cheapest rates. Instant delivery, wallet & crypto payments.",
      },
      { property: "og:title", content: "Silvex AI — Cheapest Premium Subscriptions & AI Tools" },
      {
        property: "og:description",
        content: "Premium subscriptions and AI tools at the cheapest rates with instant delivery.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://silvex-ai.com/" },
      { property: "og:site_name", content: "Silvex AI" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://silvex-ai.com/" }],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "WebSite",
          name: "Silvex AI",
          alternateName: ["Silvex", "silvex-ai.com"],
          url: "https://silvex-ai.com/",
        }),
      },
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "OnlineStore",
          name: "Silvex AI",
          url: "https://silvex-ai.com/",
          logo: "https://silvex-ai.com/favicon.png",
          sameAs: ["https://t.me/silvexai"],
        }),
      },
    ],
  }),
  component: Home,
});




function useCountdown(endTime?: number) {
  const [left, setLeft] = useState("00:00:00");
  useEffect(() => {
    if (!endTime) return;
    const tick = () => {
      const diff = endTime - Date.now();
      if (diff <= 0) return setLeft("00:00:00");
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setLeft([h, m, s].map((n) => String(n).padStart(2, "0")).join(":"));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [endTime]);
  return left;
}

function Home() {
  const { products: allProducts, banner, flashSale, categories, addToCart, ready, siteName } =
    useStore();
  const products = useMemo(() => allProducts.filter((p) => !p.hidden && !p.hideWeb), [allProducts]);
  const navigate = useNavigate();
  const [search, setSearch] = useState("");

  const saleActive = Boolean(flashSale?.endTime && flashSale.endTime > Date.now());
  const saleProduct = products.find((p) => p.id === flashSale?.pid);
  const countdown = useCountdown(flashSale?.endTime);
  const loading = !ready && products.length === 0;

  const trending = useMemo(
    () => [...products].sort((a, b) => (b.salesCount ?? 0) - (a.salesCount ?? 0)).slice(0, 10),
    [products],
  );

  const trust = [
    { icon: Zap, title: "Instant delivery", desc: "Most orders land in seconds." },
    { icon: ShieldCheck, title: "Secure wallet", desc: "Protected balance & payments." },
    { icon: Headphones, title: "Real support", desc: "We reply on Telegram & WhatsApp." },
  ];

  return (
    <div className="fade-in space-y-8">
      <MarqueeBar />

      {/* Hero + flash sale */}
      <section className="grid gap-4 lg:grid-cols-3">
        <div className="relative overflow-hidden rounded-3xl gradient-hero p-6 text-white shadow-md sm:p-8 lg:col-span-2">
          <div className="relative z-10 max-w-lg">
            <Badge className="bg-white/20 text-white backdrop-blur-sm">{siteName}</Badge>
            <h1 className="font-display mt-3 text-3xl font-bold leading-tight sm:text-4xl">
              {banner.title || "Premium digital products"}
            </h1>
            <p className="mt-2 text-sm text-white/90 sm:text-base">
              {banner.desc || "Cheapest rates with instant delivery."}
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button
                size="lg"
                onClick={() => navigate({ to: "/products" })}
                className="bg-white text-primary hover:bg-white/90"
              >
                Shop now
                <ArrowRight className="size-4" />
              </Button>
              {banner.link ? (
                <Button
                  size="lg"
                  variant="outline"
                  asChild
                  className="border-white/40 bg-transparent text-white hover:bg-white/10 hover:text-white"
                >
                  <a href={banner.link}>Learn more</a>
                </Button>
              ) : null}
            </div>
          </div>
          <div
            aria-hidden
            className="pointer-events-none absolute -right-16 -top-16 size-56 rounded-full bg-white/10 blur-2xl"
          />
        </div>

        {saleActive && saleProduct ? (
          <div className="flex flex-col justify-between rounded-3xl border border-destructive/20 bg-card p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-destructive">
                <Emo k="web.flash" /> Flash sale
              </span>
              <span className="flex items-center gap-1 rounded-lg bg-destructive/10 px-2 py-1 font-mono text-xs font-bold tabular-nums text-destructive">
                <Clock className="size-3" />
                {countdown}
              </span>
            </div>
            <div className="mt-3">
              <h3 className="line-clamp-2 text-sm font-semibold">{saleProduct.title}</h3>
              <div className="mt-1.5 flex items-baseline gap-2">
                <span className="font-display text-2xl font-bold tabular-nums">${flashSale?.price}</span>
                <span className="text-sm text-muted-foreground line-through tabular-nums">
                  ${saleProduct.price}
                </span>
              </div>
            </div>
            <Button
              variant="destructive"
              className="mt-4 w-full"
              onClick={() => addToCart(saleProduct, Number(flashSale?.price))}
            >
              Buy now
            </Button>
          </div>
        ) : (
          <div className="hidden flex-col justify-center gap-3 rounded-3xl border border-border bg-card p-6 shadow-sm lg:flex">
            {trust.map((t) => {
              const Icon = t.icon;
              return (
                <div key={t.title} className="flex items-start gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Icon className="size-[18px]" />
                  </span>
                  <div>
                    <p className="text-sm font-semibold">{t.title}</p>
                    <p className="text-xs text-muted-foreground">{t.desc}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Search */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          navigate({ to: "/products", search: { q: search } });
        }}
        className="flex items-center gap-2 rounded-xl border border-input bg-card px-3 shadow-sm focus-within:ring-2 focus-within:ring-ring/40"
      >
        <Emo k="web.search" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search products…"
          aria-label="Search products"
          className="h-11 w-full bg-transparent text-sm outline-none"
        />
        <Button type="submit" size="sm" className="my-1.5">
          Search
        </Button>
      </form>

      {/* Category chips */}
      <section>
        <h2 className="mb-3 font-display text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Categories
        </h2>
        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
          {categories.map((c) => (
            <button
              key={c.label}
              onClick={() => navigate({ to: "/products", search: { category: c.label } })}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-2 text-sm font-medium shadow-sm transition-colors hover:border-primary/40 hover:bg-primary/5 active:scale-95 motion-reduce:active:scale-100"
            >
              <span className="text-base">{c.icon}</span>
              {c.label}
            </button>
          ))}
        </div>
      </section>

      {/* Trending */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Trending
          </h2>
          <Button variant="ghost" size="sm" onClick={() => navigate({ to: "/products" })}>
            View all
            <ArrowRight className="size-4" />
          </Button>
        </div>

        {loading ? (
          <>
            {/* Mobile: carousel skeleton */}
            <div className="grid grid-cols-2 gap-3 sm:hidden">
              {Array.from({ length: 4 }).map((_, i) => (
                <ProductCardSkeleton key={i} />
              ))}
            </div>
            <ProductGrid className="hidden sm:grid">
              {Array.from({ length: 5 }).map((_, i) => (
                <ProductCardSkeleton key={i} />
              ))}
            </ProductGrid>
          </>
        ) : products.length === 0 ? (
          <EmptyState
            icon={Zap}
            title="No products yet"
            description="An admin can add products from the admin panel. Check back soon."
          />
        ) : (
          <>
            {/* Mobile: embla carousel */}
            <Carousel opts={{ align: "start", dragFree: true }} className="sm:hidden">
              <CarouselContent>
                {trending.map((p) => (
                  <CarouselItem key={p.id} className="basis-[46%]">
                    <ProductCard product={p} />
                  </CarouselItem>
                ))}
              </CarouselContent>
            </Carousel>
            {/* Tablet+ : grid */}
            <ProductGrid className="hidden sm:grid">
              {trending.slice(0, 10).map((p) => (
                <ProductCard key={p.id} product={p} />
              ))}
            </ProductGrid>
          </>
        )}
      </section>

      {/* Trust strip (mobile / when sale card took the desktop slot) */}
      <section className="grid gap-3 sm:grid-cols-3">
        {trust.map((t) => {
          const Icon = t.icon;
          return (
            <div
              key={t.title}
              className="flex items-start gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Icon className="size-[18px]" />
              </span>
              <div>
                <p className="text-sm font-semibold">{t.title}</p>
                <p className="text-xs text-muted-foreground">{t.desc}</p>
              </div>
            </div>
          );
        })}
      </section>

      <SupportButtons />
    </div>
  );
}
