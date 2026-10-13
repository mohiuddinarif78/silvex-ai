import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Download, KeyRound, PackageSearch, Search, SlidersHorizontal } from "lucide-react";
import { useStore } from "@/context/StoreContext";
import { ProductCard, ProductCardSkeleton, ProductGrid } from "@/components/store/ProductCard";
import { websiteUrl } from "@/lib/referral";
import { downloadTextFile, resellerApiDocs } from "@/lib/reseller-docs";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

type SortKey = "popular" | "price-asc" | "price-desc" | "newest";

type ProductSearch = { q?: string | undefined; category?: string | undefined };

export const Route = createFileRoute("/products")({
  validateSearch: (search: Record<string, unknown>): ProductSearch => ({
    q: typeof search["q"] === "string" ? search["q"] : "",
    category: typeof search["category"] === "string" ? search["category"] : "",
  }),
  head: () => ({
    meta: [
      { title: "Shop Digital Products — Silvex AI" },
      {
        name: "description",
        content:
          "Browse premium subscriptions, services, methods and free digital products with instant delivery.",
      },
      { property: "og:title", content: "Shop Digital Products — Silvex AI" },
      { property: "og:url", content: "https://silvex-ai.com/products" },
      {
        property: "og:description",
        content: "Browse premium subscriptions, services, methods and free digital products.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Products,
});

function Products() {
  const { q, category } = Route.useSearch();
  const { products, profile, config, categories, ready, notify } = useStore();
  const [filter, setFilter] = useState(q ?? "");
  const [cat, setCat] = useState(category ?? "");
  const [sort, setSort] = useState<SortKey>("popular");

  const normalizedFilter = filter.trim().toLowerCase();
  const showApiDocs =
    normalizedFilter === "api" ||
    normalizedFilter.includes("reseller api") ||
    normalizedFilter.includes("api docs");
  const apiKey = (profile as { apiKey?: string } | null)?.apiKey;
  const base = `${(config.siteUrl || websiteUrl()).replace(/\/+$/, "")}/api/public/reseller`;

  const list = useMemo(() => {
    const nf = (filter || "").toLowerCase();
    const items = products.filter((p) => {
      if (!p || !p.title) return false;
      if (p.hidden || p.hideWeb) return false;
      const matchesText = String(p.title).toLowerCase().includes(nf);
      const matchesCat = !cat || p.type === cat;
      return matchesText && matchesCat;
    });
    const sorted = [...items];
    switch (sort) {
      case "price-asc":
        sorted.sort((a, b) => Number(a.price) - Number(b.price));
        break;
      case "price-desc":
        sorted.sort((a, b) => Number(b.price) - Number(a.price));
        break;
      case "newest":
        sorted.reverse();
        break;
      default:
        sorted.sort((a, b) => (b.salesCount ?? 0) - (a.salesCount ?? 0));
    }
    return sorted;
  }, [products, filter, cat, sort]);

  const loading = !ready && products.length === 0;
  const hasFilters = Boolean(filter || cat);

  const reset = () => {
    setFilter("");
    setCat("");
    setSort("popular");
  };

  return (
    <div className="fade-in">
      <h1 className="font-display mb-4 text-2xl font-bold tracking-tight sm:text-3xl">
        {cat || "All products"}
      </h1>

      {/* Sticky toolbar */}
      <div className="sticky top-[61px] z-30 -mx-4 mb-5 border-b border-border bg-background/90 px-4 py-3 backdrop-blur-md md:top-[65px] md:mx-0 md:rounded-2xl md:border md:px-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter items…"
              aria-label="Filter products"
              className="pl-9"
            />
          </div>
          <div className="flex items-center gap-2">
            <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
              <SelectTrigger size="sm" className="w-[150px]" aria-label="Sort products">
                <SlidersHorizontal className="size-4 text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="popular">Most popular</SelectItem>
                <SelectItem value="price-asc">Price: low to high</SelectItem>
                <SelectItem value="price-desc">Price: high to low</SelectItem>
                <SelectItem value="newest">Newest</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Category chips */}
        <div className="no-scrollbar -mx-4 mt-3 flex gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0">
          <button
            onClick={() => setCat("")}
            className={cn(
              "inline-flex shrink-0 items-center rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
              !cat
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card hover:border-primary/40",
            )}
          >
            All
          </button>
          {categories.map((c) => (
            <button
              key={c.label}
              onClick={() => setCat(c.label)}
              className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                cat === c.label
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card hover:border-primary/40",
              )}
            >
              <span>{c.icon}</span>
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {/* Reseller API docs card (kept) */}
      {showApiDocs ? (
        <Card className="mb-5 py-0">
          <CardContent className="flex items-center gap-3 p-4">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <KeyRound className="size-5" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold">Reseller API documentation</h2>
              <p className="text-xs text-muted-foreground">
                Endpoints, authentication, ordering, delivery, and examples.
              </p>
            </div>
            {apiKey ? (
              <Button
                size="icon"
                aria-label="Download reseller API documentation"
                title="Download API documentation"
                onClick={() => {
                  downloadTextFile("silent-seller-reseller-api.txt", resellerApiDocs(base, apiKey));
                  notify("API documentation downloaded");
                }}
              >
                <Download className="size-4" aria-hidden="true" />
              </Button>
            ) : (
              <Button size="sm" asChild>
                <Link to="/api-key">Get file</Link>
              </Button>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* Result count */}
      {!loading && !showApiDocs ? (
        <p className="mb-3 text-xs text-muted-foreground">
          {list.length} {list.length === 1 ? "product" : "products"}
          {hasFilters ? " found" : ""}
        </p>
      ) : null}

      {/* Grid / skeletons / empty */}
      {loading ? (
        <ProductGrid className="pb-10">
          {Array.from({ length: 10 }).map((_, i) => (
            <ProductCardSkeleton key={i} />
          ))}
        </ProductGrid>
      ) : list.length === 0 && !showApiDocs ? (
        <EmptyState
          icon={PackageSearch}
          title="No products found"
          description={
            hasFilters
              ? "Try a different search or clear your filters."
              : "Nothing here yet. Check back soon."
          }
          action={
            hasFilters ? (
              <Button variant="outline" onClick={reset}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : list.length > 0 ? (
        <ProductGrid className="pb-10">
          {list.map((p) => (
            <ProductCard key={p.id} product={p} />
          ))}
        </ProductGrid>
      ) : null}
    </div>
  );
}
