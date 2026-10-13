import { Outlet, createFileRoute } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";

import { useStore } from "@/context/StoreContext";
import { AdminShell } from "@/components/admin/AdminShell";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/admin")({ component: AdminLayout });

function AdminLayout() {
  const { ready, user, isAdmin, openModal } = useStore();

  if (!ready) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-24 rounded-2xl" />
          <Skeleton className="h-24 rounded-2xl" />
          <Skeleton className="h-24 rounded-2xl" />
        </div>
      </div>
    );
  }

  if (!user || !isAdmin) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="Admin only"
        description="Sign in with an admin account to open this area."
        action={!user ? <Button onClick={() => openModal("auth")}>Login</Button> : undefined}
      />
    );
  }

  return (
    <AdminShell>
      <Outlet />
    </AdminShell>
  );
}
