import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { get, onValue, push, ref, remove, set, update } from "@/lib/fb/database";
import { useStore, isOwnerEmail, type Product, type Category } from "@/context/StoreContext";
import { fileToCompressedDataUrl } from "@/lib/image-upload";
import { exportOrdersCsv, exportOrdersPdf, type ExportRow } from "@/lib/export-orders";
import { sendSmtpMail } from "@/lib/mail.functions";
import { deliveryBlock, emailShell, sendMail } from "@/lib/mailer";
import { notifyTelegramOrder } from "@/lib/telegram.functions";
import { connectTelegramBot } from "@/lib/bot-setup.functions";
import { broadcastProductEvent } from "@/lib/broadcast.functions";
import { sendNoticePush } from "@/lib/push.functions";


import { input, Stat, Empty, ImageField, type OrderRow } from "@/components/admin/shared";
import { SmtpAdmin } from "@/components/admin/SmtpAdmin";

export function SettingsAdmin({
  config,
  banner,
}: {
  config: {
    qr?: string;
    fee?: number;
    marquee?: string;
    siteName?: string;
    siteTagline?: string;
    depositAddress?: string;
    supportLink?: string;
    supportTelegram?: string;
    messageEffect?: string;
    minOrder?: number;
    categories?: Category[];
    siteUrl?: string;
    botUsername?: string;
    botToken?: string;
    referralRate?: number;
    referralCap?: number;
    ownerEmails?: string;
    telegramOwners?: string;
    notifyGroup?: string;
    supplierApiUrl?: string;
    supplierApiKey?: string;
    razorpayKeyId?: string;
    razorpayKeySecret?: string;
    razorpayWebhookSecret?: string;
    inrPerDollar?: number;
    binanceApiKey?: string;
    binanceApiSecret?: string;
    binanceAddress?: string;
    binancePayId?: string;
    binanceNetwork?: string;
    binanceCoins?: string;

  };
  banner: { title?: string; desc?: string; link?: string };
}) {
  const { db, user, products, notify, categories: liveCategories } = useStore();
  const [cfg, setCfg] = useState({
    qr: config.qr ?? "",
    fee: String(config.fee ?? 25),
    marquee: config.marquee ?? "",
    siteName: config.siteName ?? "Silvex AI",
    siteTagline: config.siteTagline ?? "",
    depositAddress: config.depositAddress ?? "",
    supportLink: config.supportLink ?? "",
    supportTelegram: config.supportTelegram ?? "",
    messageEffect: config.messageEffect ?? "random",
    minOrder: String(config.minOrder ?? 0),
    lowStockAlert: String((config as { lowStockAlert?: number }).lowStockAlert ?? 5),
    siteUrl: config.siteUrl ?? "",
    botUsername: config.botUsername ?? "",
    botToken: config.botToken ?? "",
    referralRate: String(config.referralRate ?? 2),
    referralCap: String(config.referralCap ?? 201),
    ownerEmails: config.ownerEmails ?? "",
    telegramOwners: config.telegramOwners ?? "",
    notifyGroup: config.notifyGroup ?? "",
    supplierApiUrl: config.supplierApiUrl ?? "",
    supplierApiKey: config.supplierApiKey ?? "",
    razorpayKeyId: config.razorpayKeyId ?? "",
    razorpayKeySecret: config.razorpayKeySecret ?? "",
    razorpayWebhookSecret: config.razorpayWebhookSecret ?? "",
    inrPerDollar: String(config.inrPerDollar ?? 100),
    binanceApiKey: config.binanceApiKey ?? "",
    binanceApiSecret: config.binanceApiSecret ?? "",
    binanceAddress: config.binanceAddress ?? "",
    binancePayId: config.binancePayId ?? "",
    binanceNetwork: config.binanceNetwork ?? "BSC",
    binanceCoins: config.binanceCoins ?? "USDT,USDC",

  });
  const [cats, setCats] = useState<Category[]>(liveCategories);
  const [bn, setBn] = useState({
    title: banner.title ?? "",
    desc: banner.desc ?? "",
    link: banner.link ?? "",
  });
  const [notice, setNotice] = useState("");
  const [fs, setFs] = useState({ pid: "", price: "", hours: "2" });

  const [connecting, setConnecting] = useState(false);

  async function connectBot() {
    setConnecting(true);
    try {
      await saveConfig();
      const res = await connectTelegramBot({
        data: { token: cfg.botToken.trim(), siteUrl: cfg.siteUrl.trim() },
      });
      notify(res.ok ? `Bot @${res.username} connected` : res.error);
    } catch (e) {
      notify((e as Error)?.message || "Could not connect the bot");
    } finally {
      setConnecting(false);
    }
  }

  async function saveConfig(extra: Record<string, unknown> = {}) {
    if (!db) return;
    await update(ref(db, "site_settings/config"), {
      qr: cfg.qr,
      fee: Number(cfg.fee || 0),
      marquee: cfg.marquee,
      siteName: cfg.siteName,
      siteTagline: cfg.siteTagline,
      depositAddress: cfg.depositAddress.trim(),
      supportLink: cfg.supportLink,
      supportTelegram: cfg.supportTelegram.trim(),
      messageEffect: cfg.messageEffect.trim().toLowerCase(),
      minOrder: Number(cfg.minOrder || 0),
      lowStockAlert: Number(cfg.lowStockAlert || 0),
      siteUrl: cfg.siteUrl.trim(),
      botUsername: cfg.botUsername.trim().replace(/^@/, ""),
      botToken: cfg.botToken.trim(),
      referralRate: Number(cfg.referralRate || 0),
      referralCap: Number(cfg.referralCap || 0),
      ownerEmails: cfg.ownerEmails.trim(),
      telegramOwners: cfg.telegramOwners.trim(),
      notifyGroup: cfg.notifyGroup.trim(),
      supplierApiUrl: cfg.supplierApiUrl.trim().replace(/\/+$/, ""),
      supplierApiKey: cfg.supplierApiKey.trim(),
      razorpayKeyId: cfg.razorpayKeyId.trim(),
      razorpayKeySecret: cfg.razorpayKeySecret.trim(),
      razorpayWebhookSecret: cfg.razorpayWebhookSecret.trim(),
      inrPerDollar: Number(cfg.inrPerDollar || 100),
      binanceApiKey: cfg.binanceApiKey.trim(),
      binanceApiSecret: cfg.binanceApiSecret.trim(),
    binanceAddress: cfg.binanceAddress.trim(),
      binancePayId: (cfg.binancePayId || "").trim(),
      binanceNetwork: cfg.binanceNetwork.trim().toUpperCase(),
      binanceCoins: cfg.binanceCoins.trim().toUpperCase(),
      ...extra,
    });
    notify("Settings saved");
  }

  const webhookUrl = `${(cfg.siteUrl || "").trim().replace(/\/+$/, "") || "https://your-site.com"}/api/public/razorpay/webhook`;

  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-2xl border border-border bg-card p-4">
        <h2 className="text-sm font-black">Binance deposits (automatic)</h2>
        <p className="text-[11px] text-muted-foreground">
          Customers send USDT/USDC to your Binance address and paste the transaction id. We ask
          Binance directly and top up the balance on its own (1 USDT = $1). Use a read-only API key
          and allow only your server IP address in Binance.
        </p>
        <input
          className={input}
          placeholder="Binance API key"
          value={cfg.binanceApiKey}
          onChange={(e) => setCfg({ ...cfg, binanceApiKey: e.target.value })}
        />
        <input
          className={input}
          placeholder="Binance API secret"
          value={cfg.binanceApiSecret}
          onChange={(e) => setCfg({ ...cfg, binanceApiSecret: e.target.value })}
        />
        <input
          className={input}
          placeholder="Binance deposit address (leave empty to fetch it automatically)"
          value={cfg.binanceAddress}
          onChange={(e) => setCfg({ ...cfg, binanceAddress: e.target.value })}
        />
        <input
          className={input}
          placeholder="Network (BSC, TRX, MATIC…)"
          value={cfg.binanceNetwork}
          onChange={(e) => setCfg({ ...cfg, binanceNetwork: e.target.value })}
        />
        <input
          className={input}
          placeholder="Binance ID / Pay ID (internal transfers, no blockchain)"
          value={cfg.binancePayId || ""}
          onChange={(e) => setCfg({ ...cfg, binancePayId: e.target.value })}
        />
        <input
          className={input}
          placeholder="Coins accepted (USDT,USDC)"
          value={cfg.binanceCoins}
          onChange={(e) => setCfg({ ...cfg, binanceCoins: e.target.value })}
        />
        <button
          onClick={() => void saveConfig()}
          className="w-full rounded-xl bg-primary py-2 text-xs font-bold text-primary-foreground"
        >
          Save Binance settings
        </button>
      </div>

      <div className="space-y-2 rounded-2xl border border-border bg-card p-4">
        <h2 className="text-sm font-black">Card / UPI deposits (Razorpay)</h2>
        <p className="text-[11px] text-muted-foreground">
          Every top-up gets its own payment link. Paid money lands in the customer's balance on its
          own — nobody has to approve it.
        </p>
        <input
          className={input}
          placeholder="Razorpay Key ID (rzp_live_...)"
          value={cfg.razorpayKeyId}
          onChange={(e) => setCfg({ ...cfg, razorpayKeyId: e.target.value })}
        />
        <input
          className={input}
          placeholder="Razorpay Key Secret"
          value={cfg.razorpayKeySecret}
          onChange={(e) => setCfg({ ...cfg, razorpayKeySecret: e.target.value })}
        />
        <input
          className={input}
          placeholder="Webhook secret (same one you type in Razorpay)"
          value={cfg.razorpayWebhookSecret}
          onChange={(e) => setCfg({ ...cfg, razorpayWebhookSecret: e.target.value })}
        />
        <input
          className={input}
          placeholder="Rupees per $1 (default 100)"
          value={cfg.inrPerDollar}
          onChange={(e) => setCfg({ ...cfg, inrPerDollar: e.target.value })}
        />

        <div className="rounded-xl border border-dashed border-border bg-muted/50 p-3">
          <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
            Webhook address
          </p>
          <p className="break-all font-mono text-[11px] font-bold">{webhookUrl}</p>
          <button
            onClick={() => {
              navigator.clipboard?.writeText(webhookUrl);
              notify("Webhook address copied");
            }}
            className="mt-2 rounded-lg bg-foreground px-3 py-1 text-[11px] font-bold text-background"
          >
            Copy
          </button>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Paste it in Razorpay → Settings → Webhooks, tick payment_link.paid and
            payment.captured, and use the same webhook secret above.
          </p>
        </div>
        <button
          onClick={() => saveConfig()}
          className="rounded-xl bg-primary px-4 py-2 text-xs font-bold text-primary-foreground"
        >
          Save payment settings
        </button>
      </div>

      <div className="space-y-2 rounded-2xl border border-border bg-card p-4">

        <h2 className="text-sm font-black">Supplier shop (reseller API)</h2>
        <p className="text-[11px] text-muted-foreground">
          Link another shop's reseller API. Products set to "Supplier shop" keep their price and
          stock in sync and are bought and delivered automatically.
        </p>
        <input
          className={input}
          placeholder="Supplier API address (https://.../api)"
          value={cfg.supplierApiUrl}
          onChange={(e) => setCfg({ ...cfg, supplierApiUrl: e.target.value })}
        />
        <input
          className={input}
          placeholder="Supplier API key"
          value={cfg.supplierApiKey}
          onChange={(e) => setCfg({ ...cfg, supplierApiKey: e.target.value })}
        />
      </div>

      <div className="space-y-2 rounded-2xl border border-border bg-card p-4">
        <h2 className="text-sm font-black">Store identity</h2>
        <input
          className={input}
          placeholder="Website name"
          value={cfg.siteName}
          onChange={(e) => setCfg({ ...cfg, siteName: e.target.value })}
        />
        <input
          className={input}
          placeholder="Tagline"
          value={cfg.siteTagline}
          onChange={(e) => setCfg({ ...cfg, siteTagline: e.target.value })}
        />
        <input
          className={input}
          placeholder="Support / WhatsApp link"
          value={cfg.supportLink}
          onChange={(e) => setCfg({ ...cfg, supportLink: e.target.value })}
        />
        <input
          className={input}
          placeholder="Telegram support (@username)"
          value={cfg.supportTelegram}
          onChange={(e) => setCfg({ ...cfg, supportTelegram: e.target.value })}
        />
        <select
          className={input}
          value={cfg.messageEffect}
          onChange={(e) => setCfg({ ...cfg, messageEffect: e.target.value })}
        >
          <option value="random">Bot message effect: 🎲 Random (different each time)</option>
          <option value="fire">Bot message effect: 🔥 Fire</option>
          <option value="party">Bot message effect: 🎉 Party</option>
          <option value="heart">Bot message effect: ❤️ Heart</option>
          <option value="like">Bot message effect: 👍 Like</option>
          <option value="none">Bot message effect: off</option>
        </select>
        <input
          className={input}
          placeholder="Scrolling notice text"
          value={cfg.marquee}
          onChange={(e) => setCfg({ ...cfg, marquee: e.target.value })}
        />
        <button
          onClick={() => saveConfig()}
          className="btn-grad w-full rounded-xl py-2.5 text-sm font-bold"
        >
          Save identity
        </button>
      </div>

      <div className="space-y-2 rounded-2xl border border-border bg-card p-4">
        <h2 className="text-sm font-black">Payments</h2>
        <input
          className={`${input} font-mono text-xs`}
          placeholder="Crypto deposit address (0x...; empty = DEPOSIT_ADDRESS env)"
          value={cfg.depositAddress}
          onChange={(e) => setCfg({ ...cfg, depositAddress: e.target.value })}
        />
        <input
          className={input}
          placeholder="Withdraw fee (%)"
          value={cfg.fee}
          onChange={(e) => setCfg({ ...cfg, fee: e.target.value })}
        />
        <input
          className={input}
          placeholder="Minimum order ($)"
          value={cfg.minOrder}
          onChange={(e) => setCfg({ ...cfg, minOrder: e.target.value })}
        />
        <input
          className={input}
          placeholder="Low stock alert at (units left)"
          value={cfg.lowStockAlert}
          onChange={(e) => setCfg({ ...cfg, lowStockAlert: e.target.value })}
        />
        <ImageField
          label="Payment QR photo"
          value={cfg.qr}
          onChange={(qr) => setCfg({ ...cfg, qr })}
        />
        <button
          onClick={async () => {
            const addr = cfg.depositAddress.trim();
            if (addr && !/^0x[0-9a-fA-F]{40}$/.test(addr))
              return notify("That deposit address does not look right");
            await saveConfig();
          }}
          className="btn-grad w-full rounded-xl py-2.5 text-sm font-bold"
        >
          Save payment settings
        </button>
      </div>

      <div className="space-y-2 rounded-2xl border border-border bg-card p-4">
        <h2 className="text-sm font-black">Links, referral &amp; owners</h2>
        <p className="text-[11px] text-muted-foreground">
          Used by the website, the Telegram bot and the reseller API.
        </p>
        <input
          className={input}
          placeholder="Website address (https://your-site.com)"
          value={cfg.siteUrl}
          onChange={(e) => setCfg({ ...cfg, siteUrl: e.target.value })}
        />
        <input
          className={input}
          placeholder="Telegram bot username (without @)"
          value={cfg.botUsername}
          onChange={(e) => setCfg({ ...cfg, botUsername: e.target.value })}
        />
        <input
          className={input}
          placeholder="Telegram bot token from BotFather"
          value={cfg.botToken}
          onChange={(e) => setCfg({ ...cfg, botToken: e.target.value })}
        />
        <button
          onClick={connectBot}
          disabled={connecting}
          className="w-full rounded-xl bg-muted py-2.5 text-sm font-bold disabled:opacity-60"
        >
          {connecting ? "Connecting bot…" : "Save & connect Telegram bot"}
        </button>
        <div className="flex gap-2">
          <input
            className={input}
            placeholder="Referral commission (%)"
            value={cfg.referralRate}
            onChange={(e) => setCfg({ ...cfg, referralRate: e.target.value })}
          />
          <input
            className={input}
            placeholder="Max per friend ($)"
            value={cfg.referralCap}
            onChange={(e) => setCfg({ ...cfg, referralCap: e.target.value })}
          />
        </div>
        <div>
          <input
            className={`${input} opacity-60`}
            placeholder="Owner emails (comma separated)"
            value={cfg.ownerEmails}
            disabled
            readOnly
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            Owner emails are locked — permanent owners cannot be changed or added.
          </p>
        </div>
        <input
          className={input}
          placeholder="Telegram owner IDs (comma separated; empty = TELEGRAM_OWNER_IDS env)"
          value={cfg.telegramOwners}
          onChange={(e) => setCfg({ ...cfg, telegramOwners: e.target.value })}
        />
        <input
          className={input}
          placeholder="Notification group ID (e.g. -1001234567890; empty = TELEGRAM_NOTIFY_GROUP env)"
          value={cfg.notifyGroup}
          onChange={(e) => setCfg({ ...cfg, notifyGroup: e.target.value })}
        />
        <button
          onClick={() => saveConfig()}
          className="btn-grad w-full rounded-xl py-2.5 text-sm font-bold"
        >
          Save links &amp; referral
        </button>
      </div>

      <SmtpAdmin siteName={cfg.siteName} />

      <div className="space-y-2 rounded-2xl border border-border bg-card p-4">
        <h2 className="text-sm font-black">Categories</h2>
        {cats.map((c, i) => (
          <div key={i} className="flex gap-2">
            <input
              className={`${input} w-16 text-center`}
              value={c.icon ?? ""}
              placeholder="🙂"
              onChange={(e) =>
                setCats(cats.map((x, xi) => (xi === i ? { ...x, icon: e.target.value } : x)))
              }
            />
            <input
              className={input}
              value={c.label}
              placeholder="Name"
              onChange={(e) =>
                setCats(cats.map((x, xi) => (xi === i ? { ...x, label: e.target.value } : x)))
              }
            />
            <button
              onClick={() => setCats(cats.filter((_, xi) => xi !== i))}
              className="rounded-xl bg-destructive/10 px-3 text-xs font-bold text-destructive"
            >
              ✕
            </button>
          </div>
        ))}
        <button
          onClick={() => setCats([...cats, { label: "", icon: "✨" }])}
          className="w-full rounded-xl bg-muted py-2 text-xs font-bold"
        >
          + Add category
        </button>
        <button
          onClick={() =>
            saveConfig({ categories: cats.filter((c) => c.label.trim()) })
          }
          className="btn-grad w-full rounded-xl py-2.5 text-sm font-bold"
        >
          Save categories
        </button>
      </div>


      <div className="space-y-2 rounded-2xl border border-border bg-card p-4">
        <h2 className="text-sm font-black">Home banner</h2>
        <input
          className={input}
          placeholder="Title"
          value={bn.title}
          onChange={(e) => setBn({ ...bn, title: e.target.value })}
        />
        <input
          className={input}
          placeholder="Description"
          value={bn.desc}
          onChange={(e) => setBn({ ...bn, desc: e.target.value })}
        />
        <button
          onClick={async () => {
            if (!db) return;
            await set(ref(db, "site_settings/banner"), bn);
            notify("Banner updated");
          }}
          className="btn-grad w-full rounded-xl py-2.5 text-sm font-bold"
        >
          Update banner
        </button>
      </div>

      <div className="space-y-2 rounded-2xl border border-border bg-card p-4">
        <h2 className="text-sm font-black">Maintenance mode</h2>
        <p className="text-xs text-muted-foreground">
          Pauses the website and the bot for regular users. You and other admins keep full access.
        </p>
        <input
          className={input}
          placeholder="Message shown to visitors (optional)"
          value={(config as { maintenanceText?: string }).maintenanceText || ""}
          onChange={async (e) => {
            if (!db) return;
            await update(ref(db, "site_settings/config"), { maintenanceText: e.target.value });
          }}
        />
        <button
          onClick={async () => {
            if (!db) return;
            const on = (config as { maintenanceMode?: boolean }).maintenanceMode === true;
            await update(ref(db, "site_settings/config"), { maintenanceMode: !on });
            notify(on ? "Maintenance mode off" : "Maintenance mode ON — users paused");
          }}
          className={`w-full rounded-xl py-2.5 text-sm font-bold ${
            (config as { maintenanceMode?: boolean }).maintenanceMode === true
              ? "bg-emerald-500/10 text-emerald-600"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {(config as { maintenanceMode?: boolean }).maintenanceMode === true
            ? "Maintenance ON"
            : "Maintenance OFF"}
        </button>
      </div>

      <div className="space-y-2 rounded-2xl border border-border bg-card p-4">
        <h2 className="text-sm font-black">Bot announcements</h2>
        <p className="text-xs text-muted-foreground">
          Send a message with Buy now / Browse / Website buttons to every bot user when a product is
          added, restocked or put on flash sale.
        </p>
        <button
          onClick={async () => {
            if (!db) return;
            const on = (config as { broadcasts?: boolean }).broadcasts !== false;
            await update(ref(db, "site_settings/config"), { broadcasts: !on });
            notify(on ? "Announcements turned off" : "Announcements turned on");
          }}
          className={`w-full rounded-xl py-2.5 text-sm font-bold ${
            (config as { broadcasts?: boolean }).broadcasts !== false
              ? "bg-emerald-500/10 text-emerald-600"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {(config as { broadcasts?: boolean }).broadcasts !== false
            ? "Announcements ON"
            : "Announcements OFF"}
        </button>
      </div>

      <div className="space-y-2 rounded-2xl border border-border bg-card p-4">
        <h2 className="text-sm font-black">Fast broadcast (paid)</h2>
        <p className="text-xs text-muted-foreground">
          Telegram allows ~30 free messages per second. Turn this on to send ~120/second (1000 users in about
          9 seconds). Telegram charges 0.1 Telegram Stars per message above the free limit — keep Stars in the bot's balance.
        </p>
        <button
          onClick={async () => {
            if (!db) return;
            const on = (config as { paidBroadcast?: boolean }).paidBroadcast === true;
            await update(ref(db, "site_settings/config"), { paidBroadcast: !on });
            notify(on ? "Fast broadcast off" : "Fast broadcast on");
          }}
          className={`w-full rounded-xl py-2.5 text-sm font-bold ${
            (config as { paidBroadcast?: boolean }).paidBroadcast === true
              ? "bg-emerald-500/10 text-emerald-600"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {(config as { paidBroadcast?: boolean }).paidBroadcast === true ? "Fast broadcast ON" : "Fast broadcast OFF"}
        </button>
      </div>

      <div className="space-y-2 rounded-2xl border border-border bg-card p-4">
        <h2 className="text-sm font-black">Flash sale</h2>
        <select
          className={input}
          value={fs.pid}
          onChange={(e) => setFs({ ...fs, pid: e.target.value })}
        >
          <option value="">Select product</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title} (${p.price})
            </option>
          ))}
        </select>
        <input
          className={input}
          placeholder="Sale price"
          value={fs.price}
          onChange={(e) => setFs({ ...fs, price: e.target.value })}
        />
        <input
          className={input}
          placeholder="Duration (hours)"
          value={fs.hours}
          onChange={(e) => setFs({ ...fs, hours: e.target.value })}
        />
        <div className="flex gap-2">
          <button
            onClick={async () => {
              if (!db || !fs.pid || !fs.price) return notify("Pick a product and price");
              const endTime = Date.now() + Number(fs.hours || 1) * 3600000;
              await set(ref(db, "site_settings/flash_sale"), {
                pid: fs.pid,
                price: Number(fs.price),
                endTime,
              });
              notify("Flash sale started");
              const r = await broadcastProductEvent({
                data: { kind: "flash", productId: fs.pid, price: Number(fs.price), ends: endTime },
              });
              if (r.ok) notify(`📣 Sale announced to ${r.sent} bot users`);
            }}
            className="flex-1 rounded-xl bg-destructive py-2.5 text-sm font-bold text-destructive-foreground"
          >
            Start sale
          </button>
          <button
            onClick={async () => db && (await remove(ref(db, "site_settings/flash_sale")))}
            className="rounded-xl bg-muted px-4 text-sm font-bold"
          >
            Stop
          </button>
        </div>
      </div>

      <div className="space-y-2 rounded-2xl border border-border bg-card p-4">
        <h2 className="text-sm font-black">Send notification</h2>
        <input
          className={input}
          placeholder="Message..."
          value={notice}
          onChange={(e) => setNotice(e.target.value)}
        />
        <button
          onClick={async () => {
            if (!db || !notice) return;
            await push(ref(db, "notifications"), { msg: notice, date: new Date().toISOString() });
            const msg = notice;
            setNotice("");
            const idToken = await user?.getIdToken().catch(() => "");
            const r = idToken ? await sendNoticePush({ data: { idToken, msg } }).catch(() => null) : null;
            notify(r && r.ok ? `Notification sent • pop-up on ${r.sent} device${r.sent === 1 ? "" : "s"}` : "Notification saved (pop-up not sent)");
          }}
          className="btn-grad w-full rounded-xl py-2.5 text-sm font-bold"
        >
          Send to everyone
        </button>
      </div>
    </div>
  );
}
