import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { Loading } from "@/components/common";
import { Shell } from "@/components/shell";
import { ApiError } from "@/lib/api";
import { PageErrorBoundary } from "@/components/error-boundary";

const Overview = lazy(() => import("@/pages/overview"));
const Requests = lazy(() => import("@/pages/requests"));
const Providers = lazy(() => import("@/pages/providers"));
const Proxies = lazy(() => import("@/pages/proxies"));
const Clients = lazy(() => import("@/pages/clients"));
const Pricing = lazy(() => import("@/pages/pricing"));
const Routing = lazy(() => import("@/pages/routing"));
const Settings = lazy(() => import("@/pages/settings"));
const Runtime = lazy(() => import("@/pages/runtime"));
const pages = [
  ["overview", Overview],
  ["requests", Requests],
  ["providers", Providers],
  ["proxies", Proxies],
  ["clients", Clients],
  ["pricing", Pricing],
  ["routing", Routing],
  ["settings", Settings],
  ["runtime", Runtime],
] as const;
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: (count, error) =>
        count < 2 && !(error instanceof ApiError && error.status < 500),
    },
    mutations: { retry: false },
  },
});

export function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <BrowserRouter basename={import.meta.env.BASE_URL}>
            <Routes>
              <Route element={<Shell />}>
                <Route index element={<Navigate to="/overview" replace />} />
                {pages.map(([path, Page]) => {
                  return (
                    <Route
                      key={path}
                      path={path}
                      element={
                        <PageErrorBoundary>
                          <Suspense fallback={<Loading />}>
                            <Page />
                          </Suspense>
                        </PageErrorBoundary>
                      }
                    />
                  );
                })}
                <Route path="*" element={<Navigate to="/overview" replace />} />
              </Route>
            </Routes>
          </BrowserRouter>
          <Toaster richColors position="bottom-right" />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
