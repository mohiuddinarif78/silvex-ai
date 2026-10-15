import { Plus, Zap, Clock } from "lucide-react";

import { useStore, type Product } from "@/context/StoreContext";
import { productImageSrc } from "@/lib/product-image";
import { productStock, deliveryLabel } from "@/lib/product-meta";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Emo } from "@/components/store/Emo";
import { EmoText } from "@/components/store/EmoText";
import { EmojiArt } from "@/components/store/EmojiArt";

export function ProductCard({ product }: { product: Product }) {
  const { openProduct, addToCart, productEmoji } = useStore();
  const pe = productEmoji(product.id);
  const stock = productStock(product);
  const delivery = deliveryLabel(product);
  const img = productImageSrc(product.id, product.logo);

  return (
    <div className="group flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition-shadow duration-200 hover:shadow-md">
      {/* Media */}
      <button
        type="button"
        onClick={() => openProduct(product.id)}
        aria-label={`View ${product.title}`}
        className="relative block aspect-[4/3] w-full overflow-hidden bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {img ? (
          <img
            src={img}
            alt={product.title}
            loading="lazy"
            decoding="async"
            className={cn(
              "size-full object-cover transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transform-none",
              stock.soldOut && "opacity-60 grayscale",
            )}
          />
        ) : (
          <div className="flex size-full items-center justify-center bg-gradient-to-br from-primary/10 to-secondary/10 text-4xl">
            {pe.img ? (
              <EmojiArt src={pe.img} className="!size-12" />
            ) : pe.char ? (
              <span aria-hidden>{pe.char}</span>
            ) : (
              <Emo k="web.bag" />
            )}
          </div>
        )}

        {/* Badges overlay — single row so they wrap instead of overlapping on narrow cards */}
        <div className="absolute inset-x-2 top-2 flex flex-wrap items-start justify-between gap-1">
          {stock.soldOut ? (
            <Badge variant="muted">Sold out</Badge>
          ) : stock.low ? (
            <Badge variant="destructive">Low stock</Badge>
          ) : stock.unlimited || stock.count > 0 || product.delivery === "manual" ? (
            <Badge variant="success">In stock</Badge>
          ) : (
            <span />
          )}
          <Badge variant="secondary" className="gap-0.5 bg-background/85 text-foreground backdrop-blur-sm">
            {delivery.instant ? <Zap className="size-3" /> : <Clock className="size-3" />}
            {delivery.label}
          </Badge>
        </div>
      </button>

      {/* Body */}
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        {product.type ? (
          <Badge variant="muted" className="rounded-md px-1.5 text-[10px] uppercase tracking-wide">
            {product.type}
          </Badge>
        ) : null}

        <h3 className="line-clamp-2 text-sm font-semibold leading-snug">
          <button
            type="button"
            onClick={() => openProduct(product.id)}
            className="text-left outline-none hover:text-primary focus-visible:text-primary"
          >
            {pe.img ? (
              <EmojiArt src={pe.img} className="mr-1" />
            ) : pe.char ? (
              <span className="mr-1" aria-hidden>
                {pe.char}
              </span>
            ) : null}
            <EmoText text={product.title || ""} />
          </button>
        </h3>

        <div className="mt-auto flex items-center justify-between gap-2 pt-2">
          <span className="font-display text-lg font-bold tabular-nums">${product.price}</span>
          {stock.soldOut ? (
            <Button size="sm" variant="secondary" disabled className="h-9">
              Sold out
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => addToCart(product)}
              aria-label={`Add ${product.title} to cart`}
              className="h-9"
            >
              <Plus className="size-4" />
              Add
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function ProductCardSkeleton() {
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <Skeleton className="aspect-[4/3] w-full rounded-none" />
      <div className="flex flex-col gap-2 p-3">
        <Skeleton className="h-3.5 w-14 rounded-md" />
        <Skeleton className="h-4 w-full rounded-md" />
        <Skeleton className="h-4 w-2/3 rounded-md" />
        <div className="mt-2 flex items-center justify-between">
          <Skeleton className="h-5 w-12 rounded-md" />
          <Skeleton className="h-9 w-16 rounded-xl" />
        </div>
      </div>
    </div>
  );
}

/** Standard responsive product grid: 2 cols mobile, 3 tablet, 4–5 desktop. */
export function ProductGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5",
        className,
      )}
    >
      {children}
    </div>
  );
}
