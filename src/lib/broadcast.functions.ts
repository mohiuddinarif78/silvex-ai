import { createServerFn } from "@tanstack/react-start";

type Input = {
  kind: "new" | "restock" | "low" | "flash";
  productId: string;
  price?: number;
  left?: number;
  added?: number;
  ends?: number;
};

function validate(input: Input): Input {
  const kind = ["new", "restock", "low", "flash"].includes(String(input?.kind))
    ? (input.kind as Input["kind"])
    : "new";
  return {
    kind,
    productId: String(input?.productId || ""),
    ...(input?.price != null ? { price: Number(input.price) } : {}),
    ...(input?.left != null ? { left: Number(input.left) } : {}),
    ...(input?.added != null ? { added: Number(input.added) } : {}),
    ...(input?.ends != null ? { ends: Number(input.ends) } : {}),
  };
}

/** Announce a store event (new product, restock, low stock, flash sale) to all bot users. */
export const broadcastProductEvent = createServerFn({ method: "POST" })
  .inputValidator(validate)
  .handler(async ({ data }) => {
    const { requireStaff } = await import("./auth-guard.server");
    await requireStaff();
    if (!data.productId) return { ok: false as const, sent: 0, total: 0, error: "no product" };
    try {
      const { announce } = await import("./broadcast.server");
      const extra: { price?: number; left?: number; ends?: number; added?: number } = {};
      if (data.added != null) extra.added = data.added;
      if (data.price != null) extra.price = data.price;
      if (data.left != null) extra.left = data.left;
      if (data.ends != null) extra.ends = data.ends;
      return await announce(data.kind, data.productId, extra);
    } catch (err) {
      return {
        ok: false as const,
        sent: 0,
        total: 0,
        error: err instanceof Error ? err.message : "broadcast failed",
      };
    }
  });
