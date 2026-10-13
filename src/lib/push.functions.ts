import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const schema = z.object({
  idToken: z.string().min(10).max(5000),
  sub: z.object({
    endpoint: z.string().url().max(1000),
    keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
  }),
});

/** Saves this device so it can receive pop-up notifications. The signed-in
 *  account is verified with Firebase, and admin alerts are only enabled when the
 *  database marks that account as admin. */
export const savePushSubscription = createServerFn({ method: "POST" })
  .inputValidator((d) => schema.parse(d))
  .handler(async ({ data }) => {
    const { callerFromToken } = await import("./cloud-access.server");
    const who = await callerFromToken(data.idToken);
    if (!who) return { ok: false as const, error: "Please sign in again." };
    const uid = who.uid;
    const { dbGet, dbPut } = await import("./telegram.server");
    const { subKey } = await import("./push.server");
    const admin = who.staff;
    await dbPut(`pushSubs/${uid}/${subKey(data.sub.endpoint)}`, { ...data.sub, admin, at: Date.now() });
    return { ok: true as const, admin };
  });

export const getVapidKey = createServerFn({ method: "GET" }).handler(async () => {
  const { VAPID_PUBLIC_KEY } = await import("./push.server");
  return { key: VAPID_PUBLIC_KEY };
});

async function verify(idToken: string) {
  const { callerFromToken } = await import("./cloud-access.server");
  const who = await callerFromToken(idToken);
  return who ? { uid: who.uid, admin: who.staff } : null;
}

/** Admin "Send notification" → pop-up on every subscribed phone. */
export const sendNoticePush = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ idToken: z.string().min(10).max(5000), msg: z.string().min(1).max(500) }).parse(d))
  .handler(async ({ data }) => {
    const who = await verify(data.idToken);
    if (!who?.admin) return { ok: false as const, error: "Admins only." };
    const { pushEveryone } = await import("./push.server");
    const r = await pushEveryone({ title: "🔔 Silvex AI", body: data.msg, url: "/" });
    return { ok: true as const, ...r };
  });

/** Sends a test pop-up to the signed-in user's own devices. */
export const sendTestPush = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ idToken: z.string().min(10).max(5000) }).parse(d))
  .handler(async ({ data }) => {
    const who = await verify(data.idToken);
    if (!who) return { ok: false as const, error: "Please sign in again." };
    const { pushUser } = await import("./push.server");
    const r = await pushUser(who.uid, { title: "✅ Notifications work", body: "You'll get store alerts here.", url: "/" });
    return { ok: true as const, ...r };
  });
