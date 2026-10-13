import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { z } from "zod";

function bearer(): string | null {
  const h = getRequestHeader("authorization") || "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : null;
}

async function caller() {
  const { callerFromToken } = await import("./cloud-access.server");
  return callerFromToken(bearer());
}

const pathSchema = z.string().max(400).regex(/^[^.#$\[\]]*$/);

/** Read one location (optionally filtered by a child value). */
export const cloudRead = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({ path: pathSchema, child: z.string().max(60).optional(), equalTo: z.any().optional() }).parse(d),
  )
  .handler(async ({ data }) => {
    const c = await caller();
    const { canRead } = await import("./cloud-access.server");
    const { cloudGet } = await import("./cloud-db.server");
    const top = data.path.split("/").filter(Boolean);
    const filtered = data.child !== undefined;
    let allowed = canRead(data.path, c);
    // Customers may list their own orders/requests, and count who used their referral code.
    if (!allowed && filtered && c && top.length === 1) {
      if ((top[0] === "orders" || top[0] === "requests") && data.child === "uid" && data.equalTo === c.uid) allowed = true;
      if (top[0] === "users" && data.child === "usedRef") allowed = true;
    }
    if (!allowed) throw new Error("Permission denied");
    let value: any = await cloudGet(data.path);
    if (filtered && value && typeof value === "object") {
      value = Object.fromEntries(Object.entries(value).filter(([, v]: any) => v && v[data.child!] === data.equalTo));
      if (!c?.staff && top[0] === "users") {
        value = Object.fromEntries(Object.entries(value).map(([k, v]: any) => [k, { name: v.name, joined: v.joined, usedRef: v.usedRef }]));
      }
      if (!Object.keys(value).length) value = null;
    }
    return { value: value ?? null } as { value: any };
  });

/** Write one location: set / update / remove. */
export const cloudWrite = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({ op: z.enum(["set", "update", "remove"]), path: pathSchema, value: z.any().optional() }).parse(d),
  )
  .handler(async ({ data }) => {
    const c = await caller();
    const { writeProblem } = await import("./cloud-access.server");
    const db = await import("./cloud-db.server");
    const p = data.path.split("/").filter(Boolean);
    let value = data.value ?? null;
    let op = data.op;
    // A customer "set" on their own record only touches the fields they own.
    if (!c?.staff && c && p[0] === "users" && p[1] === c.uid && p.length === 2 && op === "set") op = "update";
    const needsCurrent = ["products", "requests", "apiKeys"].includes(p[0] || "") && !c?.staff;
    const current = needsCurrent ? await db.cloudGet(data.path) : null;
    const problem = writeProblem(op, data.path, value, current, c);
    if (problem) throw new Error(problem);
    if (op === "remove") await db.cloudPut(data.path, null);
    else if (op === "update") await db.cloudPatch(data.path, value || {});
    else await db.cloudPut(data.path, value);
    if (p[0] === "users" && p[2] === "history" && op === "set" && value && c?.staff) {
      const { notifyBalanceChange } = await import("./telegram.server");
      void notifyBalanceChange(p[1]!, value).catch(() => undefined);
    }
    return { ok: true };
  });

/** The signed-in customer's store id, email, and whether the server treats them as admin. */
export const cloudWhoami = createServerFn({ method: "POST" }).handler(async () => {
  const c = await caller();
  return c ? { uid: c.uid, email: c.email, staff: c.staff } : null;
});

/**
 * Customers from before the move have no login yet. Create one (already
 * confirmed) so the password-reset email can reach them. Only the inbox owner
 * can use that email, so nobody else gains access.
 */
export const prepareLegacyLogin = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ email: z.string().email().max(200) }).parse(d))
  .handler(async ({ data }) => {
    const email = data.email.trim().toLowerCase();
    const rl = await import("./rate-limit.server");
    rl.limitByIp("legacy-login", 10, 10 * rl.MINUTE);
    rl.limitBy("legacy-login", email, 3, 10 * rl.MINUTE);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = supabaseAdmin as any;
    const { data: cust } = await db.from("customers").select("id, auth_user_id").ilike("email", email).limit(1).maybeSingle();
    if (!cust || cust.auth_user_id) return { legacy: false };
    const password = crypto.randomUUID() + crypto.randomUUID();
    const { error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
    return { legacy: !error || /already/i.test(error.message) };
  });
