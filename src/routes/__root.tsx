import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  type ErrorComponentProps,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { StoreProvider } from "@/context/StoreContext";
import { AppShell } from "@/components/store/AppShell";
import { MaintenanceGate } from "@/components/store/MaintenanceGate";
import { Toaster } from "@/components/ui/sonner";
import { PushPrompt } from "@/components/store/PushPrompt";
import { ThemeProvider, themeInitScript } from "@/components/theme-provider";
import { getStoreSnapshot } from "@/lib/store-snapshot.functions";
import { primeStoreSnapshot } from "@/context/store-prime";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: ErrorComponentProps) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    const msg = String((error as Error)?.message ?? error);
    if (/dynamically imported module|Importing a module script failed|error loading dynamically/i.test(msg)) {
      // A new version was deployed; old chunk files are gone. Reload once.
      const key = "chunkReload:" + location.pathname;
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, "1");
        location.reload();
        return;
      }
    }
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "theme-color", content: "#6366f1" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { title: "Silvex AI" },
      { name: "description", content: "Premium digital products at the cheapest rates." },
      { property: "og:title", content: "Silvex AI" },
      { property: "og:description", content: "Premium digital products at the cheapest rates." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Space+Grotesk:wght@500;600;700&display=swap",
      },
      { rel: "icon", href: "/favicon.png", type: "image/png" },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/favicon.png" },
    ],
  }),
  loader: async () => {
    const snapshot = await getStoreSnapshot().catch(() => null);
    return { snapshot };
  },
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  useEffect(() => {
    const onPreloadError = (e: Event) => {
      const key = "chunkReload:" + location.pathname;
      if (sessionStorage.getItem(key)) return;
      e.preventDefault();
      sessionStorage.setItem(key, "1");
      location.reload();
    };
    const clear = setTimeout(() => sessionStorage.removeItem("chunkReload:" + location.pathname), 10000);
    window.addEventListener("vite:preloadError", onPreloadError);
    return () => {
      clearTimeout(clear);
      window.removeEventListener("vite:preloadError", onPreloadError);
    };
  }, []);
  // Settings and shop data travel with the page, so the store shows instantly.
  const data = Route.useLoaderData();
  primeStoreSnapshot(data?.snapshot);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <StoreProvider>
          <AppShell>
            <MaintenanceGate>
              {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
              <Outlet />
            </MaintenanceGate>
          </AppShell>
          <PushPrompt />
          <Toaster position="top-center" />
        </StoreProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
