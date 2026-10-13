import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

export type Crumb = { label: string; to?: string; search?: Record<string, string> };

/** Simple breadcrumb trail for admin pages. The last crumb is the current page. */
export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={cn("flex items-center text-sm text-muted-foreground", className)}>
      <ol className="flex flex-wrap items-center gap-1">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${c.label}-${i}`} className="flex items-center gap-1">
              {c.to && !last ? (
                <Link
                  to={c.to}
                  search={c.search as never}
                  className="transition-colors hover:text-foreground"
                >
                  {c.label}
                </Link>
              ) : (
                <span className={cn(last && "font-medium text-foreground")} aria-current={last ? "page" : undefined}>
                  {c.label}
                </span>
              )}
              {!last ? <ChevronRight className="size-3.5 shrink-0" /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
