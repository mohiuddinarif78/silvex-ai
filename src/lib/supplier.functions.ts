import { createServerFn } from "@tanstack/react-start";

/** Supplier catalogue, shown in the admin panel when linking a product. */
export const fetchSupplierCatalogue = createServerFn({ method: "GET" }).handler(async () => {
  const { requireStaff } = await import("./auth-guard.server");
  await requireStaff();
  const { supplierProducts, supplierBalance, cleanText } = await import("./supplier.server");
  try {
    const [products, balance] = await Promise.all([
      supplierProducts(),
      supplierBalance().catch(() => ({ balance: 0, currency: "USDT" })),
    ]);
    return {
      ok: true as const,
      balance,
      products: products.map((p) => ({ ...p, description: cleanText(p.description || "") })),
    };
  } catch (err) {
    return { ok: false as const, error: (err as Error).message, products: [], balance: null };
  }
});

/** Refresh prices and stock of all linked products from the supplier. */
export const syncSupplier = createServerFn({ method: "POST" }).handler(async () => {
  const { requireStaff } = await import("./auth-guard.server");
  await requireStaff();
  const { syncSupplierProducts } = await import("./supplier.server");
  try {
    return { ok: true as const, ...(await syncSupplierProducts()) };
  } catch (err) {
    return { ok: false as const, error: (err as Error).message, updated: [] };
  }
});

/** Cheap background refresh (runs at most once every 5 minutes). */
export const autoSyncSupplier = createServerFn({ method: "POST" }).handler(async () => {
  const { syncSupplierProducts } = await import("./supplier.server");
  try {
    return { ok: true as const, ...(await syncSupplierProducts(false)) };
  } catch {
    return { ok: false as const, updated: [] };
  }
});

/** Just the supplier wallet balance, shown in the admin panel. */
export const fetchSupplierBalance = createServerFn({ method: "GET" }).handler(async () => {
  const { requireStaff } = await import("./auth-guard.server");
  await requireStaff();
  const { supplierBalance } = await import("./supplier.server");
  try {
    return { ok: true as const, ...(await supplierBalance()) };
  } catch (err) {
    return { ok: false as const, error: (err as Error).message, balance: 0, currency: "USDT" };
  }
});
