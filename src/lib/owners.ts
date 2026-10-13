/**
 * Owner / revoked-admin email lists — server side only, read at call time.
 *
 *   OWNER_EMAILS          comma-separated owner emails
 *   REVOKED_ADMIN_EMAILS  comma-separated emails that never get admin
 *
 * Read through globalThis.process so the build never inlines a value: changing
 * the variable on the host and restarting is enough, no rebuild. In the browser
 * these lists are always empty — the website asks the server (cloudWhoami →
 * staff) whether the signed-in user is an admin.
 */
function serverList(name: string): string[] {
  if (typeof window !== "undefined") return [];
  const raw = (globalThis as any)?.process?.env?.[name];
  if (typeof raw !== "string" || !raw.trim()) return [];
  return raw
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export const ownerEmails = (): string[] => serverList("OWNER_EMAILS");
export const revokedAdminEmails = (): string[] => serverList("REVOKED_ADMIN_EMAILS");

const norm = (e?: string | null) => String(e ?? "").trim().toLowerCase();

/** Server only: is this email a store owner right now? */
export function isPermanentOwner(email?: string | null): boolean {
  const e = norm(email);
  return !!e && ownerEmails().includes(e) && !revokedAdminEmails().includes(e);
}

/** Server only: is this email permanently refused admin? */
export function isRevokedAdmin(email?: string | null): boolean {
  return revokedAdminEmails().includes(norm(email));
}
