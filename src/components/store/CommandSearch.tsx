import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { PackageSearch, ShoppingBag, Search } from "lucide-react";

import { useStore } from "@/context/StoreContext";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { EmojiArt } from "@/components/store/EmojiArt";

/**
 * Global product search. Opens with the keyboard (⌘K / Ctrl+K) or any trigger
 * that flips `open`. Picking a product opens its detail modal; data comes from
 * the live store, so nothing about products or routing changes.
 */
export function CommandSearch({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { products, openProduct, productEmoji } = useStore();
  const navigate = useNavigate();

  const visible = React.useMemo(
    () => products.filter((p) => !p.hidden && !p.hideWeb),
    [products],
  );

  const go = React.useCallback(
    (fn: () => void) => {
      onOpenChange(false);
      fn();
    },
    [onOpenChange],
  );

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Search products" description="Find a product by name">
      <CommandInput placeholder="Search products…" />
      <CommandList>
        <CommandEmpty>No products found.</CommandEmpty>
        <CommandGroup heading="Quick links">
          <CommandItem value="shop all products" onSelect={() => go(() => navigate({ to: "/products" }))}>
            <ShoppingBag className="text-muted-foreground" />
            Browse all products
          </CommandItem>
          <CommandItem value="reseller api docs" onSelect={() => go(() => navigate({ to: "/products", search: { q: "api" } }))}>
            <PackageSearch className="text-muted-foreground" />
            Reseller API docs
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading="Products">
          {visible.map((p) => {
            const pe = productEmoji(p.id);
            return (
              <CommandItem
                key={p.id}
                value={`${p.title} ${p.type ?? ""} ${p.id}`}
                onSelect={() => go(() => openProduct(p.id))}
              >
                {pe.img ? (
                  <EmojiArt src={pe.img} className="!size-4" />
                ) : pe.char ? (
                  <span aria-hidden>{pe.char}</span>
                ) : (
                  <Search className="text-muted-foreground" />
                )}
                <span className="flex-1 truncate">{p.title}</span>
                <span className="font-display text-xs font-semibold tabular-nums text-muted-foreground">
                  ${p.price}
                </span>
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

/** Hook that wires ⌘K / Ctrl+K to toggle a search palette. */
export function useCommandSearch() {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return { open, setOpen };
}
