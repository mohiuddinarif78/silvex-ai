/**
 * Block a reseller account and revoke its API key.
 *
 * The reseller endpoint's resolveKey() denies access when EITHER
 * `user.blocked` is truthy OR `user.apiEnabled === false`, after looking the
 * caller up via `apiKeys/<key>` → uid. This script shuts an account down on all
 * three fronts so a leaked key is dead immediately:
 *   1. delete the `apiKeys/<key>` index entry      → the key no longer resolves
 *   2. clear `users/<uid>/apiKey`, set apiEnabled=false
 *   3. set `users/<uid>/blocked = true`             → also blocks bot/website
 *
 * SAFE BY DEFAULT: this is a DRY RUN unless you pass --apply. The dry run reads
 * the account and prints exactly what would change, writing nothing.
 *
 * Usage (same server env as the app — Supabase creds / DATA_BACKEND):
 *   npx tsx scripts/block-reseller-account.ts probe.r1017@kigege.me          # preview
 *   npx tsx scripts/block-reseller-account.ts probe.r1017@kigege.me --apply  # execute
 *   npx tsx scripts/block-reseller-account.ts <uid> --apply
 *
 * To UNDO a block later, pass --unblock (optionally with --apply):
 *   npx tsx scripts/block-reseller-account.ts <uid> --unblock --apply
 * (Unblock clears `blocked` and re-enables the API, but does NOT restore the
 *  old key — the owner regenerates one from the bot.)
 */
import { dbGet, dbPut, dbPatch } from "../src/lib/telegram.server";

type User = { email?: string; apiKey?: string; apiEnabled?: boolean; blocked?: boolean; wallet?: number };

function parseArgs(argv: string[]) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const target = argv.find((a) => !a.startsWith("--"))?.trim() || "";
  return {
    target,
    apply: flags.has("--apply"),
    unblock: flags.has("--unblock"),
  };
}

/** Resolve an email or uid to a uid by scanning the users map once. */
async function resolveUid(target: string): Promise<{ uid: string; user: User } | null> {
  // Direct uid hit first (cheap-ish single-record read).
  const direct = await dbGet<User>(`users/${target}`);
  if (direct && (direct.email || direct.apiKey !== undefined || direct.wallet !== undefined)) {
    return { uid: target, user: direct };
  }
  const lower = target.toLowerCase();
  const all = (await dbGet<Record<string, User>>("users")) || {};
  for (const [uid, u] of Object.entries(all)) {
    if (!u || typeof u !== "object") continue;
    if (uid === target) return { uid, user: u };
    if (String(u.email || "").toLowerCase() === lower) return { uid, user: u };
  }
  return null;
}

async function main() {
  const { target, apply, unblock } = parseArgs(process.argv.slice(2));
  if (!target) {
    console.error("Usage: npx tsx scripts/block-reseller-account.ts <email|uid> [--unblock] [--apply]");
    process.exitCode = 1;
    return;
  }

  const found = await resolveUid(target);
  if (!found) {
    console.error(`No account found for "${target}".`);
    process.exitCode = 1;
    return;
  }
  const { uid, user } = found;
  const key = String(user.apiKey || "");

  const mode = apply ? "APPLY" : "DRY RUN";
  const action = unblock ? "UNBLOCK + re-enable API" : "BLOCK + revoke API key";
  console.log(`\n[${mode}] ${action}`);
  console.log(`  uid:        ${uid}`);
  console.log(`  email:      ${user.email || "(none)"}`);
  console.log(`  wallet:     $${Number(user.wallet || 0)}`);
  console.log(`  apiKey:     ${key ? key.slice(0, 10) + "…" : "(none)"}`);
  console.log(`  apiEnabled: ${user.apiEnabled === true}`);
  console.log(`  blocked:    ${user.blocked === true}\n`);

  if (!unblock) {
    console.log("Planned changes:");
    if (key) console.log(`  • delete apiKeys/${key.slice(0, 10)}…         (key stops resolving)`);
    console.log(`  • users/${uid}.apiKey    = (removed)`);
    console.log(`  • users/${uid}.apiEnabled = false`);
    console.log(`  • users/${uid}.blocked    = true`);

    if (!apply) {
      console.log(`\nDRY RUN — nothing was changed. Re-run with --apply to execute.`);
      return;
    }
    if (key) await dbPut(`apiKeys/${key}`, null);
    await dbPatch(`users/${uid}`, { apiKey: null, apiEnabled: false, blocked: true });
    console.log(`\n✅ Account blocked and API key revoked.`);
    console.log(`   The key no longer resolves and the account is denied on bot/website/API.`);
    return;
  }

  // --unblock path
  console.log("Planned changes:");
  console.log(`  • users/${uid}.blocked    = false`);
  console.log(`  • users/${uid}.apiEnabled = true`);
  console.log(`  (old API key is NOT restored — owner regenerates from the bot)`);
  if (!apply) {
    console.log(`\nDRY RUN — nothing was changed. Re-run with --apply to execute.`);
    return;
  }
  await dbPatch(`users/${uid}`, { blocked: false, apiEnabled: true });
  console.log(`\n✅ Account unblocked and API re-enabled.`);
}

main().catch((e) => {
  console.error("Failed:", e);
  process.exitCode = 1;
});
