import type { Product } from "@/context/StoreContext";

export type StockState = {
  /** true when delivery is "repeat" (same link reused, effectively unlimited). */
  unlimited: boolean;
  count: number;
  /** out of stock (explicit soldOut flag or zero countable stock). */
  soldOut: boolean;
  /** low but not empty. */
  low: boolean;
};

/** Number of deliverable units, matching the product modal / checkout logic. */
export function productStock(product: Product, lowThreshold = 5): StockState {
  const unlimited = product.delivery === "repeat";
  const count =
    product.delivery === "supplier"
      ? Number(product.supplierStock || 0)
      : Array.isArray(product.stock)
        ? product.stock.filter(Boolean).length
        : 0;
  // Manual delivery is fulfilled by an admin, so it is never "out of stock".
  const countable = product.delivery === "auto" || product.delivery === "supplier";
  const empty = countable && count <= 0;
  const soldOut = Boolean(product.soldOut) || empty;
  const low = !unlimited && countable && !soldOut && count > 0 && count <= lowThreshold;
  return { unlimited, count, soldOut, low };
}

/** Human label for the delivery method. */
export function deliveryLabel(product: Product): { label: string; instant: boolean } {
  switch (product.delivery) {
    case "manual":
      return { label: "Manual", instant: false };
    default:
      // auto / repeat / supplier all deliver instantly from the wallet checkout.
      return { label: "Instant", instant: true };
  }
}
