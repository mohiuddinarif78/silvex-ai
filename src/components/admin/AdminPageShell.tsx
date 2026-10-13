import type { ReactNode } from "react";

import { Breadcrumbs } from "@/components/admin/Breadcrumbs";

export function AdminPageShell({
  title,
  description,
  children,
  actions,
}: {
  title: string;
  description: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="fade-in space-y-5">
      <Breadcrumbs
        items={[
          { label: "Admin", to: "/admin", search: { view: "analysis" } },
          { label: title },
        ]}
      />
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}
