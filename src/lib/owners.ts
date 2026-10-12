import { isOriginProject } from "./origin";

/**
 * Owner / revoked-admin email lists.
 *
 * Configured through environment variables so no address is baked into the
 * source. Set them as comma-separated lists:
 *   OWNER_EMAILS            (server)   + VITE_OWNER_EMAILS            (browser)
 *   REVOKED_ADMIN_EMAILS    (server)   + VITE_REVOKED_ADMIN_EMAILS    (browser)
 * The VITE_ copies are required for the client bundle, since Vite only exposes
 * VITE_-prefixed variables to the browser. Both are optional; missing lists
 * simply mean "no permanent owners / none revoked".
 */
function envList(...names: string[]): string[] {
  for (const name of names) {
    // import.meta.env for the browser bundle, process.env on the server.
    const raw =
      (typeof import.meta !== "undefined" && (import.meta as any).env?.[name]) ??
      (typeof process !== "undefined" ? process.env?.[name] : undefined);
    if (raw) {
      return String(raw)
        .split(/[,\s]+/)
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
    }
  }
  return [];
}

/**
 * Permanent owners of the store. They always keep full admin access and nobody
 * can grant admin to others. Ignored on any remixed database.
 */
export const PERMANENT_OWNER_EMAILS: string[] = envList("VITE_OWNER_EMAILS", "OWNER_EMAILS");

/** Former admins whose access is permanently removed, even if old data says otherwise. */
export const REVOKED_ADMIN_EMAILS: string[] = envList(
  "VITE_REVOKED_ADMIN_EMAILS",
  "REVOKED_ADMIN_EMAILS",
);

const norm = (e?: string | null) => String(e ?? "").trim().toLowerCase();

export function isPermanentOwner(email?: string | null): boolean {
  if (!isOriginProject()) return false;
  return PERMANENT_OWNER_EMAILS.includes(norm(email));
}

export function isRevokedAdmin(email?: string | null): boolean {
  if (!isOriginProject()) return false;
  return REVOKED_ADMIN_EMAILS.includes(norm(email));
}
