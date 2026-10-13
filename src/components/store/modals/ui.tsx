import type { ReactNode } from "react";

import { ResponsiveDialog } from "@/components/ui/responsive-dialog";

/**
 * Backwards-compatible modal shell. Older modals call this with
 * `<Sheet onClose title>...</Sheet>`; it now renders the accessible
 * ResponsiveDialog (bottom Drawer on phones, centered Dialog on desktop) so
 * every modal gets focus trapping, Esc-to-close and aria-modal for free.
 */
export function Sheet({
  onClose,
  children,
  title,
  description,
}: {
  onClose: () => void;
  children: ReactNode;
  title?: string;
  description?: string;
}) {
  return (
    <ResponsiveDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={title ?? "Dialog"}
      hideHeader={!title}
      {...(description ? { description } : {})}
      className="sm:max-w-md"
    >
      {children}
    </ResponsiveDialog>
  );
}

/** Shared input styling, aligned with the ui/input component. */
export const inputCls =
  "flex h-10 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50";
