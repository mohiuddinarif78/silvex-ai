import { Link } from "@tanstack/react-router";
import { House, PackageCheck, ShoppingBag, ShoppingCart, UserRound } from "lucide-react";

import { useStore } from "@/context/StoreContext";
import { cn } from "@/lib/utils";

const items = [
  { to: "/", label: "Home", icon: House },
  { to: "/products", label: "Shop", icon: ShoppingBag },
  { to: "/cart", label: "Cart", icon: ShoppingCart },
  { to: "/orders", label: "Orders", icon: PackageCheck },
  { to: "/profile", label: "Profile", icon: UserRound },
] as const;

export function BottomNav() {
  const { cartCount } = useStore();

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-background/95 backdrop-blur-md md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      aria-label="Primary"
    >
      <div className="mx-auto flex w-full max-w-md items-stretch justify-around px-1 py-1.5">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.to === "/" }}
              className="group relative flex min-h-[52px] min-w-[56px] flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-1 py-1 text-[11px] font-medium text-muted-foreground transition-colors duration-200 active:scale-95 motion-reduce:active:scale-100"
              activeProps={{ className: "text-primary" }}
            >
              {({ isActive }) => (
                <>
                  <span className="relative">
                    <Icon
                      aria-hidden
                      strokeWidth={isActive ? 2.4 : 2}
                      className={cn("size-6 transition-transform", isActive && "scale-105")}
                    />
                    {item.to === "/cart" && cartCount > 0 ? (
                      <span className="absolute -right-2.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-bold text-destructive-foreground">
                        {cartCount > 9 ? "9+" : cartCount}
                      </span>
                    ) : null}
                  </span>
                  <span>{item.label}</span>
                  {isActive ? (
                    <span className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-primary" aria-hidden />
                  ) : null}
                </>
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
