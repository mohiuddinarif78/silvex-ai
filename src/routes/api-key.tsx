import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ref, update, set } from "@/lib/fb/database";
import { Check, Copy, Download, Eye, EyeOff, KeyRound, RefreshCw } from "lucide-react";
import { useStore } from "@/context/StoreContext";
import { websiteUrl } from "@/lib/referral";
import { downloadTextFile, resellerApiDocs } from "@/lib/reseller-docs";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export const Route = createFileRoute("/api-key")({
  head: () => ({
    meta: [
      { title: "Reseller API Key — Silvex AI" },
      { name: "description", content: "Get your personal API key to resell products automatically." },
      { property: "og:title", content: "Reseller API Key — Silvex AI" },
      { property: "og:description", content: "Get your personal API key to resell products automatically." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ApiKeyPage,
});

function newKey() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return "sk_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl border border-border bg-muted p-3 font-mono text-[11px] leading-relaxed">
      {children}
    </pre>
  );
}

function ApiKeyPage() {
  const { db, user, profile, config, openModal, showSuccess, notify } = useStore();
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState(false);
  const key = (profile as { apiKey?: string } | null)?.apiKey;

  if (!user) {
    return (
      <div className="fade-in">
        <EmptyState
          icon={KeyRound}
          title="Log in to get your API key"
          description="Resell products from your own site or bot, paid from your wallet."
          action={<Button onClick={() => openModal("auth")}>Login</Button>}
        />
      </div>
    );
  }

  async function generate() {
    if (!db || !user) return;
    setBusy(true);
    try {
      const k = newKey();
      if (key) await set(ref(db, `apiKeys/${key}`), null);
      await set(ref(db, `apiKeys/${k}`), user.uid);
      await update(ref(db, `users/${user.uid}`), { apiKey: k, apiEnabled: true });
      showSuccess("API key ready", "Keep it private — it spends your wallet balance.");
    } finally {
      setBusy(false);
    }
  }

  const copyKey = () => {
    if (!key) return;
    navigator.clipboard.writeText(key);
    setCopied(true);
    notify("API key copied");
    setTimeout(() => setCopied(false), 1500);
  };

  const base = `${(config.siteUrl || websiteUrl()).replace(/\/+$/, "")}/api/public/reseller`;
  const masked = key ? `${key.slice(0, 6)}${"•".repeat(20)}` : "";

  return (
    <div className="fade-in mx-auto max-w-3xl">
      <div className="mb-5">
        <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">Reseller API</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Sell our products from your own site or bot. The same key works for your website and
          Telegram account, and orders are paid from your wallet balance.
        </p>
      </div>

      {/* Key card */}
      <Card className="mb-5">
        <CardHeader>
          <CardTitle className="text-base">Your personal key</CardTitle>
          <CardDescription>Keep it private — anyone with it can spend your wallet.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2 rounded-xl border border-border bg-muted p-3">
            <code className="min-w-0 flex-1 break-all font-mono text-xs">
              {key ? (reveal ? key : masked) : "No key yet — generate one below."}
            </code>
            {key ? (
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8 shrink-0"
                  aria-label={reveal ? "Hide key" : "Reveal key"}
                  onClick={() => setReveal((v) => !v)}
                >
                  {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8 shrink-0"
                  aria-label="Copy key"
                  onClick={copyKey}
                >
                  {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
                </Button>
              </>
            ) : null}
          </div>

          {key ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" disabled={busy}>
                  <RefreshCw className="size-4" />
                  Generate new key
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Generate a new key?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Your current key stops working immediately. Any integrations using it must be
                    updated with the new key.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={generate}>Generate new key</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <Button onClick={generate} disabled={busy}>
              <KeyRound className="size-4" />
              {busy ? "Generating…" : "Generate key"}
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Docs */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Documentation</CardTitle>
          <CardDescription>
            Base URL <code className="break-all">{base}</code>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <Button
            className="w-full"
            onClick={() => {
              downloadTextFile("silent-seller-reseller-api.txt", resellerApiDocs(base, key));
              notify("API documentation downloaded");
            }}
          >
            <Download className="size-4" />
            Download full API documentation
          </Button>

          <Alert>
            <KeyRound />
            <AlertDescription>
              Send your key on every request in the <code>x-api-key</code> header. All prices and
              balances are in dollars.
            </AlertDescription>
          </Alert>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Endpoints
            </p>
            <CodeBlock>{`GET  ${base}/me
GET  ${base}/balance
GET  ${base}/products
GET  ${base}/orders
GET  ${base}/orders/ORDER_ID
POST ${base}/order
     { "productId": "ID", "qty": 1 }`}</CodeBlock>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Example order
            </p>
            <CodeBlock>{`curl -X POST ${base}/order \\
  -H "x-api-key: ${key || "YOUR_KEY"}" \\
  -H "content-type: application/json" \\
  -d '{"productId":"ID","qty":1}'`}</CodeBlock>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Response
            </p>
            <CodeBlock>{`{
  "ok": true,
  "orderId": "...",
  "status": "Completed",
  "total": 4.5,
  "balance": 20.5,
  "delivered": [{ "title": "...", "content": "..." }]
}`}</CodeBlock>
            <p className="mt-2 text-xs text-muted-foreground">
              Instant items are delivered inside the order response. Manual items come back as{" "}
              <code>pending</code> and are delivered by us — check <code>/orders/ORDER_ID</code> or
              your orders page.
            </p>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Errors
            </p>
            <p className="text-xs text-muted-foreground">
              <code>401</code> wrong or missing key · <code>404</code> unknown product or order ·{" "}
              <code>400</code> not enough balance or stock.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
