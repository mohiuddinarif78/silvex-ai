/**
 * Small in-memory rate limiter (sliding window).
 *
 * The store runs as one long-lived Node process on Railway, so counters in
 * memory are shared by every request. They reset on restart, and each replica
 * counts separately if the service is ever scaled out — move this to Redis or
 * the database at that point.
 *
 * Limits are keyed by client IP (Railway's edge sets X-Real-IP) and, wherever
 * an identity is known, by account / API key too, because IPs can be rotated
 * but an account cannot.
 */
import { getRequestHeader } from "@tanstack/react-start/server";

const hits = new Map<string, number[]>();
let lastSweep = Date.now();

/** Drop expired entries now and then so memory stays bounded. */
function sweep(now: number) {
  if (now - lastSweep < 60_000 && hits.size < 50_000) return;
  lastSweep = now;
  for (const [key, times] of hits) {
    // Longest window used anywhere is one hour.
    if (!times.length || now - times[times.length - 1]! > 3_600_000) hits.delete(key);
  }
}

export class RateLimitError extends Error {
  constructor(public retryAfterSec: number) {
    super(`Too many requests. Please try again in ${retryAfterSec}s.`);
  }
}

/** Count one hit for `key`; throws RateLimitError when over `limit` per `windowMs`. */
export function consume(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  sweep(now);
  const times = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (times.length >= limit) {
    hits.set(key, times);
    throw new RateLimitError(Math.max(1, Math.ceil((windowMs - (now - times[0]!)) / 1000)));
  }
  times.push(now);
  hits.set(key, times);
}

/** Throw RateLimitError if `key` is already at `limit`, without counting a hit. */
export function assertUnder(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const times = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (times.length >= limit) {
    throw new RateLimitError(Math.max(1, Math.ceil((windowMs - (now - times[0]!)) / 1000)));
  }
}

/** Best-effort client IP from a header getter. */
export function clientIpFrom(get: (name: string) => string | null | undefined): string {
  const real = String(get("x-real-ip") || "").trim();
  if (real) return real;
  const fwd = String(get("x-forwarded-for") || "").split(",").map((s) => s.trim()).filter(Boolean);
  return fwd[0] || "unknown";
}

/** Client IP for the current server-function request. */
export function clientIp(): string {
  return clientIpFrom((n) => getRequestHeader(n));
}

/** Limit the current server-function call by client IP. */
export function limitByIp(action: string, limit: number, windowMs: number): void {
  consume(`${action}:ip:${clientIp()}`, limit, windowMs);
}

/** Limit by a known identity (account id, API key, email, chat id). */
export function limitBy(action: string, id: string, limit: number, windowMs: number): void {
  consume(`${action}:id:${id}`, limit, windowMs);
}

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
