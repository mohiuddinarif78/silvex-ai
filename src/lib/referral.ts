/**
 * Referral programme. Every value here is a fallback only — the admin panel
 * (Settings → Referral & links) overrides them from site_settings/config.
 * Bot username / website fall back to TELEGRAM_BOT_USERNAME / SITE_URL (server)
 * or the current page address (browser); nothing store-specific is hardcoded.
 */

export const REFERRAL_DEFAULTS = {
  rate: 0.02,
  cap: 201,
};

const serverEnv = (name: string): string =>
  String((globalThis as any)?.process?.env?.[name] ?? "").trim();

const settings = { rate: REFERRAL_DEFAULTS.rate, cap: REFERRAL_DEFAULTS.cap, botUsername: "", websiteUrl: "" };

export type ReferralConfig = {
  referralRate?: number | string;
  referralCap?: number | string;
  botUsername?: string;
  siteUrl?: string;
};

/** Apply admin settings (percent values such as 2 are read as 2%). */
export function applyReferralConfig(c?: ReferralConfig | null) {
  if (!c) return;
  const rate = Number(c.referralRate);
  if (Number.isFinite(rate) && rate > 0) settings.rate = rate > 1 ? rate / 100 : rate;
  const cap = Number(c.referralCap);
  if (Number.isFinite(cap) && cap > 0) settings.cap = cap;
  if (c.botUsername) settings.botUsername = String(c.botUsername).trim().replace(/^@/, "");
  if (c.siteUrl) settings.websiteUrl = String(c.siteUrl).trim().replace(/\/+$/, "");
}

export const referralRate = () => settings.rate;
export const referralCap = () => settings.cap;
export const referralPercent = () => Math.round(settings.rate * 10000) / 100;
export const websiteUrl = () => {
  if (settings.websiteUrl) return settings.websiteUrl;
  if (typeof window !== "undefined") return window.location.origin;
  return serverEnv("SITE_URL").replace(/\/+$/, "");
};
export const botUsername = () =>
  settings.botUsername || serverEnv("TELEGRAM_BOT_USERNAME").replace(/^@/, "");


export function websiteReferralLink(code: string) {
  return `${websiteUrl()}/?ref=${code}`;
}
export function botReferralLink(code: string) {
  return `https://t.me/${botUsername()}?start=${code}`;
}

export type HistoryEntry = { type?: string; amount?: number; date?: string };

/** Today / this week / this month / all-time referral earnings from a user's history list. */
export function referralEarnings(history: HistoryEntry[]) {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfWeek = startOfDay - ((now.getDay() + 6) % 7) * 86400000;
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  let today = 0,
    week = 0,
    month = 0,
    total = 0;
  for (const h of history) {
    if (!h || !String(h.type || "").toLowerCase().startsWith("referral")) continue;
    const amt = Number(h.amount) || 0;
    const t = h.date ? new Date(h.date).getTime() : 0;
    total += amt;
    if (t >= startOfMonth) month += amt;
    if (t >= startOfWeek) week += amt;
    if (t >= startOfDay) today += amt;
  }
  return { today, week, month, total };
}
