import { Bot, Boxes, Cloud, Plug, Settings, TicketPercent, Users, WalletCards } from "lucide-react";
import { Link } from "@tanstack/react-router";

const items = [
  { to: "/admin/requests", label: "Requests", detail: "Deposits and withdrawals", icon: WalletCards },
  { to: "/admin/products", label: "Products", detail: "Products, prices and stock", icon: Boxes },
  { to: "/admin/api-shops", label: "API shops", detail: "Suppliers and imported items", icon: Plug },
  { to: "/admin/coupons", label: "Coupons", detail: "Discount codes and limits", icon: TicketPercent },
  { to: "/admin/users", label: "Users", detail: "Customers and access", icon: Users },
  { to: "/admin/bot-buttons", label: "Bot buttons", detail: "Telegram button colours", icon: Bot },
  { to: "/admin/hosting", label: "Hosting", detail: "Railway deployment", icon: Cloud },
  { to: "/admin/settings", label: "Settings", detail: "Store, payments and bot", icon: Settings },
] as const;

export function ManagementHub() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {items.map(({ to, label, detail, icon: Icon }) => (
        <Link
          key={to}
          to={to}
          className="group flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm transition-all hover:border-primary/40 hover:shadow-md"
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
            <Icon className="size-5" />
          </span>
          <span className="min-w-0">
            <span className="font-display block text-sm font-semibold">{label}</span>
            <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{detail}</span>
          </span>
        </Link>
      ))}
    </div>
  );
}
