/** Phone / desktop pop-up notifications (standard Web Push, no third-party service). */
import webpush from "web-push";
import { dbGet, dbPut } from "./telegram.server";

export const VAPID_PUBLIC_KEY =
  "BMYnyjI7-1QpvdFivYd4W4nbB5je6Te1PHZeV88Z9ie7s-x8cl6v5eJYgwg3p4z8Y0u6ihD20TtyrSoTZaApTzc";

type Sub = { endpoint: string; keys: { p256dh: string; auth: string }; admin?: boolean };
type Payload = { title: string; body: string; url?: string };

let ready = false;
function setup(): boolean {
  if (ready) return true;
  const priv = process.env["VAPID_PRIVATE_KEY"];
  if (!priv) return false;
  webpush.setVapidDetails("mailto:adithyanbraj@gmail.com", VAPID_PUBLIC_KEY, priv);
  ready = true;
  return true;
}

export function subKey(endpoint: string): string {
  let h = 0;
  for (let i = 0; i < endpoint.length; i++) h = (h * 31 + endpoint.charCodeAt(i)) | 0;
  return `s${(h >>> 0).toString(36)}${endpoint.length}`;
}

/** Plain text for notifications (bot messages are HTML). */
export function plain(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

type Result = { sent: number; failed: number; devices: number; configured: boolean };
async function sendTo(entries: Array<[string, string, Sub]>, payload: Payload): Promise<Result> {
  const r: Result = { sent: 0, failed: 0, devices: entries.length, configured: setup() };
  if (!r.configured || !entries.length) return r;
  const data = JSON.stringify({ ...payload, body: plain(payload.body).slice(0, 400) });
  await Promise.all(
    entries.map(async ([uid, key, sub]) => {
      try {
        await webpush.sendNotification(sub, data, { TTL: 86400, urgency: "high" });
        r.sent++;
      } catch (e: any) {
        r.failed++;
        console.error("push failed", e?.statusCode, e?.body || e?.message);
        // Phone uninstalled / permission revoked → forget this device.
        if (e?.statusCode === 404 || e?.statusCode === 410)
          await dbPut(`pushSubs/${uid}/${key}`, null).catch(() => undefined);
      }
    }),
  );
  return r;
}

async function allSubs(): Promise<Array<[string, string, Sub]>> {
  const all = (await dbGet<Record<string, Record<string, Sub>>>("pushSubs").catch(() => null)) || {};
  const out: Array<[string, string, Sub]> = [];
  for (const [uid, subs] of Object.entries(all))
    for (const [k, s] of Object.entries(subs || {})) if (s?.endpoint) out.push([uid, k, s]);
  return out;
}

const none: Result = { sent: 0, failed: 0, devices: 0, configured: false };
export async function pushUser(uid: string | undefined, payload: Payload): Promise<Result> {
  if (!uid) return none;
  const subs = (await dbGet<Record<string, Sub>>(`pushSubs/${uid}`).catch(() => null)) || {};
  return sendTo(Object.entries(subs).map(([k, s]) => [uid, k, s] as [string, string, Sub]), payload).catch(() => none);
}

export async function pushAdmins(payload: Payload): Promise<Result> {
  const subs = (await allSubs()).filter(([, , s]) => s.admin === true);
  return sendTo(subs, payload).catch(() => none);
}

export async function pushEveryone(payload: Payload): Promise<Result> {
  return sendTo(await allSubs(), payload).catch(() => none);
}
