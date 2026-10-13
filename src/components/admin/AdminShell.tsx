import * as React from "react";
import { Link, useLocation } from "@tanstack/react-router";
import {
  Bot,
  Boxes,
  ChevronLeft,
  Cloud,
  LayoutDashboard,
  Menu,
  PackageCheck,
  Plug,
  Settings,
  Store,
  TicketPercent,
  Users,
  WalletCards,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type NavItem = {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  search?: Record<string, string>;
};

const NAV: NavItem[] = [
  { to: "/admin", label: "Dashboard", icon: LayoutDashboard, search: { view: "analysis" } },
  { to: "/admin", label: "Orders", icon: PackageCheck, search: { view: "orders" } },
  { to: "/admin/requests", label: "Requests", icon: WalletCards },
  { to: "/admin/products", label: "Products", icon: Boxes },
  { to: "/admin/api-shops", label: "API shops", icon: Plug },
  { to: "/admin/coupons", label: "Coupons", icon: TicketPercent },
  { to: "/admin/users", label: "Users", icon: Users },
  { to: "/admin/bot-buttons", label: "Bot buttons", icon: Bot },
  { to: "/admin/hosting", label: "Hosting", icon: Cloud },
  { to: "/admin/settings", label: "Settings", icon: Settings },
];

const COLLAPSE_KEY = "admin-sidebar-collapsed";

function isActive(item: NavItem, pathname: string, search: string): boolean {
  if (item.to === "/admin") {
    if (pathname !== "/admin") return false;
    const view = item.search?.["view"] ?? "analysis";
    if (view === "analysis") return !search.includes("view=orders") && !search.includes("view=management");
    return search.includes(`view=${view}`);
  }
  return pathname === item.to || pathname.startsWith(item.to + "/");
}

function NavLinks({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const location = useLocation();
  const pathname = location.pathname;
  const search = location.searchStr ?? "";

  return (
    <nav className="flex flex-col gap-1 p-2">
      {NAV.map((item) => {
        const Icon = item.icon;
        const active = isActive(item, pathname, search);
        const link = (
          <Link
            key={item.label}
            to={item.to}
            search={item.search as never}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
              active
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
              collapsed && "justify-center px-2",
            )}
            aria-label={item.label}
          >
            <Icon className="size-5 shrink-0" />
            {!collapsed ? <span className="truncate">{item.label}</span> : null}
          </Link>
        );
        if (collapsed) {
          return (
            <Tooltip key={item.label}>
              <TooltipTrigger asChild>{link}</TooltipTrigger>
              <TooltipContent side="right">{item.label}</TooltipContent>
            </Tooltip>
          );
        }
        return link;
      })}
    </nav>
  );
}

export function AdminShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = React.useState(false);
  const [mobileOpen, setMobileOpen] = React.useState(false);

  React.useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      /* ignore */
    }
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  return (
    <div className="flex gap-0 md:gap-6">
      {/* Desktop sidebar */}
      <aside
        className={cn(
          "sticky top-20 hidden h-[calc(100vh-6rem)] shrink-0 flex-col rounded-2xl border border-border bg-card shadow-sm transition-[width] duration-200 md:flex",
          collapsed ? "w-16" : "w-60",
        )}
      >
        <div className={cn("flex items-center gap-2 p-3", collapsed && "justify-center")}>
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Store className="size-5" />
          </span>
          {!collapsed ? <span className="font-display text-sm font-bold">Admin</span> : null}
        </div>
        <ScrollArea className="flex-1">
          <NavLinks collapsed={collapsed} />
        </ScrollArea>
        <div className="border-t border-border p-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleCollapsed}
            className="w-full justify-center text-muted-foreground"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <ChevronLeft className={cn("size-4 transition-transform", collapsed && "rotate-180")} />
            {!collapsed ? "Collapse" : null}
          </Button>
        </div>
      </aside>

      {/* Content */}
      <div className="min-w-0 flex-1">
        {/* Mobile menu trigger */}
        <div className="mb-4 md:hidden">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="sm">
                <Menu className="size-4" />
                Menu
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 p-0">
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Store className="size-4" />
                  </span>
                  Admin
                </SheetTitle>
              </SheetHeader>
              <ScrollArea className="h-[calc(100vh-5rem)]">
                <NavLinks collapsed={false} onNavigate={() => setMobileOpen(false)} />
              </ScrollArea>
            </SheetContent>
          </Sheet>
        </div>
        {children}
      </div>
    </div>
  );
}

export type { NavItem };
export { NAV as ADMIN_NAV };
