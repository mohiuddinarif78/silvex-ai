import * as React from "react";
import { X } from "lucide-react";

import { useStore } from "@/context/StoreContext";

const KEY = "marquee-dismissed-v1";

/** Slim, dismissible announcement bar driven by config.marquee. */
export function MarqueeBar() {
  const { config } = useStore();
  const msg = config.marquee || "Welcome to Silvex AI! Get the best deals here.";
  const [open, setOpen] = React.useState(true);

  React.useEffect(() => {
    try {
      if (sessionStorage.getItem(KEY) === msg) setOpen(false);
    } catch {
      /* ignore */
    }
  }, [msg]);

  if (!open || !msg) return null;

  return (
    <div className="relative mb-5 flex items-center gap-2 overflow-hidden rounded-xl border border-primary/15 bg-primary/5 py-2 pl-3 pr-9 text-xs font-medium text-foreground">
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="marquee whitespace-nowrap">{msg}</div>
      </div>
      <button
        type="button"
        aria-label="Dismiss announcement"
        onClick={() => {
          setOpen(false);
          try {
            sessionStorage.setItem(KEY, msg);
          } catch {
            /* ignore */
          }
        }}
        className="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
