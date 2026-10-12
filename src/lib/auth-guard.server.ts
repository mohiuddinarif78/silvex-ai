/**
 * Server-side identity checks for server functions.
 *
 * The browser attaches the Supabase session as `Authorization: Bearer <token>`
 * to every server-function call (see integrations/supabase/auth-attacher.ts).
 * These helpers verify that token on the server, so a call made outside the
 * website (curl, scripts) gets no more power than its real login.
 */
import { getRequestHeader } from "@tanstack/react-start/server";
import type { Caller } from "./cloud-access.server";

function bearer(): string | null {
  const h = getRequestHeader("authorization") || "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : null;
}

/** The verified signed-in caller. Throws when nobody is signed in. */
export async function requireCaller(): Promise<NonNullable<Caller>> {
  const { callerFromToken } = await import("./cloud-access.server");
  const who = await callerFromToken(bearer());
  if (!who) throw new Error("Please sign in again.");
  return who;
}

/** The verified caller, who must be store staff (owner/admin role + owner email). */
export async function requireStaff(): Promise<NonNullable<Caller>> {
  const who = await requireCaller();
  if (!who.staff) throw new Error("Admins only.");
  return who;
}
