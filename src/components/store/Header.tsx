import { Link, useNavigate } from "@tanstack/react-router";
import {
  Bell,
  History as HistoryIcon,
  KeyRound,
  LogOut,
  PackageCheck,
  Search,
  ShieldCheck,
  UserRound,
  Wallet,
} from "lucide-react";

import { useStore } from "@/context/StoreContext";
import logoUrl from "@/assets/silvex-logo.jpg";
import { useReadNotices } from "@/lib/notice-read";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ThemeMenu } from "@/components/theme-toggle";
import { CommandSearch, useCommandSearch } from "@/components/store/CommandSearch";

const NAV = [
  { to: "/", label: "Home" },
  { to: "/products", label: "Shop" },
  { to: "/orders", label: "Orders" },
  { to: "/history", label: "History" },
] as const;

export function Header() {
  const { user, profile, isAdmin, notices, openModal, siteName, auth } = useStore();
  const balance = Number(profile?.wallet ?? 0);
  const read = useReadNotices();
  const unread = notices.filter((n) => !read.has(n.id)).length;
  const search = useCommandSearch();
  const navigate = useNavigate();

  const logout = async () => {
    if (!auth) return;
    const { signOut } = await import("@/lib/fb/auth");
    await signOut(auth);
    navigate({ to: "/" });
  };

  return (
    <header className="glass sticky top-0 z-50">
      <div className="mx-auto flex w-full max-w-7xl items-center gap-2 px-4 py-3 md:px-6 lg:px-8">
        {/* Brand */}
        <Link to="/" className="flex min-w-0 shrink-0 items-center gap-2.5">
          <img
            src={logoUrl}
            alt={`${siteName} logo`}
            decoding="async"
            className="size-9 rounded-xl object-cover ring-1 ring-border transition-transform active:scale-95"
          />
          <span className="font-display hidden truncate text-base font-bold tracking-tight sm:block">
            {siteName}
          </span>
        </Link>

        {/* Desktop nav */}
        <nav className="ml-2 hidden items-center gap-1 md:flex">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.to === "/" }}
              className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              activeProps={{ className: "text-foreground bg-accent/60" }}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* Search */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => search.setOpen(true)}
            className="hidden h-9 w-48 justify-start gap-2 px-3 text-muted-foreground lg:flex"
          >
            <Search className="size-4" />
            <span className="flex-1 text-left">Search…</span>
            <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-0.5 rounded border border-border bg-muted px-1.5 font-mono text-[10px] font-medium">
              ⌘K
            </kbd>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Search products"
            className="lg:hidden"
            onClick={() => search.setOpen(true)}
          >
            <Search className="size-5" />
          </Button>

          {/* Wallet pill */}
          {user ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => openModal("wallet")}
              aria-label="Wallet balance, add funds"
              className="h-9 gap-1.5 bg-primary/10 px-3 text-primary hover:bg-primary/15"
            >
              <Wallet className="size-4" />
              <span className="font-display font-bold tabular-nums">${balance.toFixed(2)}</span>
            </Button>
          ) : null}

          {/* Notifications */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
                onClick={() => openModal("notifications")}
                className="relative"
              >
                <Bell className="size-5" />
                {unread > 0 ? (
                  <span className="absolute right-1.5 top-1.5 flex size-4 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-bold text-destructive-foreground">
                    {unread > 9 ? "9+" : unread}
                  </span>
                ) : null}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Notifications</TooltipContent>
          </Tooltip>

          {/* Admin */}
          {isAdmin ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" asChild className="text-primary">
                  <Link to="/admin" search={{ view: "analysis" }} aria-label="Admin panel">
                    <ShieldCheck className="size-5" />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Admin panel</TooltipContent>
            </Tooltip>
          ) : null}

          {/* Theme */}
          <ThemeMenu />

          {/* Account */}
          {user ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  aria-label="Account menu"
                  className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Avatar className="size-9 ring-1 ring-border">
                    {user.photoURL ? <AvatarImage src={user.photoURL} alt="" /> : null}
                    <AvatarFallback>{(profile?.name || user.email || "U").slice(0, 1)}</AvatarFallback>
                  </Avatar>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="flex flex-col gap-0.5">
                  <span className="truncate font-semibold">{profile?.name || "Account"}</span>
                  <span className="truncate text-xs font-normal text-muted-foreground">{user.email}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/profile">
                    <UserRound /> Profile
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/orders">
                    <PackageCheck /> Orders
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/history">
                    <HistoryIcon /> Wallet history
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/api-key">
                    <KeyRound /> API key
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={logout}>
                  <LogOut /> Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button size="sm" onClick={() => openModal("auth")}>
              Login
            </Button>
          )}
        </div>
      </div>

      <CommandSearch open={search.open} onOpenChange={search.setOpen} />
    </header>
  );
}
