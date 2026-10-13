import type { ReactNode } from "react";
import { Header } from "./Header";
import { BottomNav } from "./BottomNav";
import { Modals } from "./Modals";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:pb-0">
      <Header />
      <main className="mx-auto w-full max-w-7xl px-4 py-5 md:px-6 md:py-8 lg:px-8">
        {children}
      </main>
      <BottomNav />
      <Modals />
    </div>
  );
}
