import * as React from "react";

import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";

type ResponsiveDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Hide the title visually but keep it for screen readers (required for a11y). */
  hideHeader?: boolean;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Content classes applied to the scrollable body wrapper. */
  bodyClassName?: string;
};

/**
 * One dialog that becomes a bottom Drawer on phones (<640px) and a centered
 * Dialog on larger screens. Both variants trap focus, close on Esc and are
 * announced as modals, so every modal in the app gets accessible behaviour.
 */
export function ResponsiveDialog({
  open,
  onOpenChange,
  title,
  description,
  hideHeader,
  footer,
  children,
  className,
  bodyClassName,
}: ResponsiveDialogProps) {
  const isDesktop = useMediaQuery("(min-width: 640px)");

  const header =
    title || description ? (
      isDesktop ? (
        <DialogHeader className={cn(hideHeader && "sr-only")}>
          {title ? <DialogTitle>{title}</DialogTitle> : null}
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
      ) : (
        <DrawerHeader className={cn("text-left", hideHeader && "sr-only")}>
          {title ? <DrawerTitle>{title}</DrawerTitle> : null}
          {description ? <DrawerDescription>{description}</DrawerDescription> : null}
        </DrawerHeader>
      )
    ) : null;

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className={cn("gap-4", className)}>
          {header}
          <div className={cn("min-h-0", bodyClassName)}>{children}</div>
          {footer ? <DialogFooter>{footer}</DialogFooter> : null}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className={className}>
        {header}
        <div className={cn("overflow-y-auto px-4 pb-4", bodyClassName)}>{children}</div>
        {footer ? <DrawerFooter className="pt-0">{footer}</DrawerFooter> : null}
      </DrawerContent>
    </Drawer>
  );
}
