/**
 * Historical Razorpay credit audit.
 *
 * Finds every wallet credit that the OLD code could have mis-credited:
 *   • credited USD does not match the rupees actually recorded (usd ≠ inr/rate), or
 *   • the captured INR is far below what the originating link was meant to charge
 *     (the ₹60-for-$1000 underpayment), or
 *   • the credit has no matching link / an INR that is implausibly small.
 *
 * This is READ-ONLY. It prints a report and a suggested clawback total per user.
 * It does NOT change any balance — reversals are a deliberate manual step after
 * you review the report.
 *
 * Run with the same server env as the app (so DATA_BACKEND / Supabase creds are
 * present), e.g.:  npx tsx scripts/audit-razorpay-credits.ts
 */
import { dbGet } from "../src/lib/telegram.server";
import { razorpayConfig } from "../src/lib/razorpay.server";

type CreditRecord = {
  uid?: string;
  usd?: number;
  inr?: number;
  status?: string;
  paymentId?: string;
  linkId?: string;
  date?: string;
};

type LinkRecord = { uid?: string; usd?: number; inr?: number };

type Finding = {
  key: string;
  uid: string;
  paymentId: string;
  linkId: string;
  creditedUsd: number;
  recordedInr: number;
  expectedInr: number;
  fairUsd: number;
  overcreditUsd: number;
  reasons: string[];
  date: string;
};

async function main() {
  const conf = await razorpayConfig();
  const rate = Number(conf.inrPerDollar) > 0 ? Number(conf.inrPerDollar) : 100;

  const payments = (await dbGet<Record<string, CreditRecord>>("razorpayPayments")) || {};
  const links = (await dbGet<Record<string, LinkRecord>>("razorpayLinks")) || {};

  const findings: Finding[] = [];

  for (const [key, rec] of Object.entries(payments)) {
    if (!rec || typeof rec !== "object") continue;
    const uid = String(rec.uid || "");
    const creditedUsd = Number(rec.usd) || 0;
    const recordedInr = Number(rec.inr) || 0;
    const linkId = String(rec.linkId || "").replace(/[.#$/[\]]/g, "_");
    const link = linkId ? links[linkId] : undefined;
    const expectedInr = Number(link?.inr) || 0;

    // The honest dollar value of the rupees we actually have a record of.
    const fairUsd = Math.round((recordedInr / rate) * 100) / 100;
    const reasons: string[] = [];

    // 1) Credited USD exceeds what the recorded rupees are worth (> ₹1 slack).
    if (creditedUsd - fairUsd > 0.01 && recordedInr * 0.01 < creditedUsd - fairUsd) {
      reasons.push(`credited $${creditedUsd} but ₹${recordedInr} is only worth $${fairUsd}`);
    }
    // 2) Captured INR far below the link's expected charge (underpayment attack).
    if (expectedInr > 0 && recordedInr + Math.max(1, expectedInr * 0.01) < expectedInr) {
      reasons.push(`captured ₹${recordedInr} below expected ₹${expectedInr}`);
    }
    // 3) Big dollar credit backed by a tiny rupee record.
    if (creditedUsd >= 10 && recordedInr > 0 && recordedInr < creditedUsd * rate * 0.5) {
      reasons.push(`₹${recordedInr} is implausibly small for a $${creditedUsd} credit`);
    }
    // 4) Credit with no rupee record at all.
    if (creditedUsd > 0 && recordedInr <= 0) {
      reasons.push(`credited $${creditedUsd} with no recorded INR`);
    }

    if (reasons.length) {
      const overcreditUsd = Math.round(Math.max(0, creditedUsd - fairUsd) * 100) / 100;
      findings.push({
        key,
        uid,
        paymentId: String(rec.paymentId || ""),
        linkId: String(rec.linkId || ""),
        creditedUsd,
        recordedInr,
        expectedInr,
        fairUsd,
        overcreditUsd,
        reasons,
        date: String(rec.date || ""),
      });
    }
  }

  // Report.
  const totalRecords = Object.keys(payments).length;
  console.log(`\nRazorpay credit audit — rate ₹${rate}/$1`);
  console.log(`Scanned ${totalRecords} credit record(s); ${findings.length} suspicious.\n`);

  if (!findings.length) {
    console.log("No suspicious credits found. ✅");
    return;
  }

  const byUser = new Map<string, number>();
  for (const f of findings) {
    byUser.set(f.uid, Math.round(((byUser.get(f.uid) || 0) + f.overcreditUsd) * 100) / 100);
    console.log(
      [
        `• ${f.date || "(no date)"}  user=${f.uid}`,
        `  payment=${f.paymentId} link=${f.linkId}`,
        `  credited=$${f.creditedUsd}  recordedINR=₹${f.recordedInr}  expectedINR=₹${f.expectedInr}  fair=$${f.fairUsd}  over=$${f.overcreditUsd}`,
        `  reasons: ${f.reasons.join("; ")}`,
      ].join("\n"),
    );
  }

  console.log(`\nSuggested clawback per user (over-credited USD):`);
  for (const [uid, total] of [...byUser.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${uid}: $${total}`);
  }
  const grand = Math.round([...byUser.values()].reduce((s, n) => s + n, 0) * 100) / 100;
  console.log(`\nTotal suspected over-credit: $${grand}\n`);
  console.log("Review each line, then reverse manually (e.g. an admin wallet adjustment).");
}

main().catch((e) => {
  console.error("Audit failed:", e);
  process.exitCode = 1;
});
