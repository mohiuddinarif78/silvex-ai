import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { get, onValue, push, ref, remove, set, update } from "@/lib/fb/database";
import { useStore, isOwnerEmail, type Product, type Category } from "@/context/StoreContext";
import { fileToCompressedDataUrl } from "@/lib/image-upload";
import { exportOrdersCsv, exportOrdersPdf, type ExportRow } from "@/lib/export-orders";
import { sendSmtpMail } from "@/lib/mail.functions";
import { deliveryBlock, emailShell, sendMail } from "@/lib/mailer";
import { notifyTelegramOrder } from "@/lib/telegram.functions";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";


export const input =
  "flex h-10 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50";
export const SECTIONS = {
  Analysis: ["Dashboard", "Orders"],
  Management: ["Requests", "Products", "API shops", "Coupons", "Users", "Bot buttons", "Hosting", "Settings"],
} as const;
export type Section = keyof typeof SECTIONS;
export type Tab = (typeof SECTIONS)[Section][number];

export type OrderRow = {
  orderId: string;
  uid: string;
  email: string;
  total: number;
  status: string;
  phone?: string;
  note?: string;
  date: string;
  deliveryNote?: string;
  delivered?: Array<{ title: string; content: string }>;
  items?: Array<{ id?: string; title: string; qty: number; price?: number }>;
};



export type RequestRow = {
  id: string;
  uid: string;
  name?: string;
  email?: string;
  type: "Deposit" | "Withdraw";
  amount: number;
  utr?: string;
  upi?: string;
  status: string;
  date: string;
};

export function Stat({
  label,
  value,
  sub,
  icon: Icon,
  delta,
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: LucideIcon;
  /** Percent change vs previous period; positive = up (green). */
  delta?: number;
}) {
  const hasDelta = typeof delta === "number" && Number.isFinite(delta);
  const up = (delta ?? 0) >= 0;
  return (
    <Card className="gap-0 py-0">
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          {Icon ? (
            <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon className="size-4" />
            </span>
          ) : null}
        </div>
        <p className="mt-1.5 font-display text-2xl font-bold tabular-nums">{value}</p>
        <div className="mt-0.5 flex items-center gap-1.5">
          {hasDelta ? (
            <span
              className={cn(
                "inline-flex items-center gap-0.5 text-xs font-medium",
                up ? "text-success" : "text-destructive",
              )}
            >
              {up ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
              {Math.abs(delta!).toFixed(0)}%
            </span>
          ) : null}
          {sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function Empty({ text }: { text: string }) {
  return <EmptyState title={text} className="py-10" />;
}

export function ImageField({
  value,
  onChange,
  label,
  productImage = false,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  productImage?: boolean;
}) {
  const { notify } = useStore();
  const [busy, setBusy] = useState(false);

  return (
    <div className="space-y-2 rounded-xl border border-dashed border-border p-3">
      <p className="text-xs font-bold text-muted-foreground">{label}</p>
      {value ? (
        <div className="flex items-center gap-3">
          <img
            src={value}
            alt=""
            className={productImage ? "aspect-video w-28 rounded-lg object-cover" : "h-14 w-14 rounded-lg object-cover"}
          />
          <button onClick={() => onChange("")} className="text-xs font-bold text-destructive">
            Remove
          </button>
        </div>
      ) : null}
      <input
        className={input}
        placeholder="Paste an image link"
        value={value.startsWith("data:") ? "" : value}
        onChange={(e) => onChange(e.target.value)}
      />
      {productImage ? (
        <p className="text-[10px] text-muted-foreground">
          16:9 · Recommended 1280 × 720 · Minimum width 640 px · JPG, PNG or GIF
        </p>
      ) : null}
      <label className="block cursor-pointer rounded-xl bg-muted py-2 text-center text-xs font-bold">
        {busy ? "Uploading…" : "📷 Upload photo from device"}
        <input
          type="file"
          accept={productImage ? "image/jpeg,image/png,image/gif" : "image/*"}
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            setBusy(true);
            try {
              onChange(await fileToCompressedDataUrl(file, productImage ? 1280 : 800, { productImage }));
            } catch (err) {
              notify(err instanceof Error ? err.message : "Upload failed");
            } finally {
              setBusy(false);
            }
          }}
        />
      </label>
    </div>
  );
}

export const emptyProduct = {
  id: "",
  type: "Service",
  title: "",
  desc: "",
  price: "",
  logo: "",
  link: "",
  delivery: "manual" as "manual" | "auto" | "repeat" | "supplier",
  supplierId: "",
  markup: "130",
};


