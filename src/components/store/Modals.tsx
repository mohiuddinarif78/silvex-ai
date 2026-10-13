import { lazy, Suspense } from "react";
import { Check } from "lucide-react";
import { useStore } from "@/context/StoreContext";
import { ResponsiveDialog } from "@/components/ui/responsive-dialog";
import { Button } from "@/components/ui/button";

export function SuccessOverlay() {
  const { success, closeSuccess } = useStore();
  return (
    <ResponsiveDialog
      open={Boolean(success)}
      onOpenChange={(open) => {
        if (!open) closeSuccess();
      }}
      title={success?.title ?? "Success"}
      hideHeader
      className="sm:max-w-sm"
      footer={
        <Button className="w-full" onClick={closeSuccess}>
          Continue
        </Button>
      }
    >
      <div className="flex flex-col items-center py-4 text-center">
        <div className="mb-5 flex size-16 items-center justify-center rounded-full bg-success text-success-foreground motion-safe:animate-in motion-safe:zoom-in-75">
          <Check className="size-8" strokeWidth={3} aria-hidden />
        </div>
        <h2 className="font-display text-xl font-bold">{success?.title}</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">{success?.desc}</p>
      </div>
    </ResponsiveDialog>
  );
}


const AuthModal = lazy(() => import("./modals/AuthModal").then((m) => ({ default: m.AuthModal })));
const ProfileModal = lazy(() => import("./modals/ProfileModal").then((m) => ({ default: m.ProfileModal })));
const WalletModal = lazy(() => import("./modals/WalletModal").then((m) => ({ default: m.WalletModal })));
const ProductModal = lazy(() => import("./modals/ProductModal").then((m) => ({ default: m.ProductModal })));
const NotificationsModal = lazy(() => import("./modals/MiscModals").then((m) => ({ default: m.NotificationsModal })));
const SuggestionModal = lazy(() => import("./modals/MiscModals").then((m) => ({ default: m.SuggestionModal })));

export function Modals() {
  const { modal } = useStore();
  return (
    <Suspense fallback={null}>
      {modal === "auth" ? <AuthModal /> : null}
      {modal === "profile" ? <ProfileModal /> : null}
      {modal === "wallet" ? <WalletModal /> : null}
      {modal === "product" ? <ProductModal /> : null}
      {modal === "notifications" ? <NotificationsModal /> : null}
      {modal === "suggestion" ? <SuggestionModal /> : null}
      <SuccessOverlay />
    </Suspense>
  );
}
