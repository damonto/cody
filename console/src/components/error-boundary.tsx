import type { ErrorInfo, ReactNode } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";

function reportRenderError(error: unknown, info: ErrorInfo): void {
  console.error({
    event: "console.render.failed",
    name: error instanceof Error ? error.name : "UnknownError",
    component_stack: info.componentStack,
  });
}

function Recovery({ application = false }: { application?: boolean }) {
  return (
    <div
      role="alert"
      className={
        application ? "flex min-h-svh items-center justify-center p-6" : "py-16"
      }
    >
      <div className="mx-auto max-w-md space-y-4 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          {application
            ? "Cody Console could not start"
            : "Could not open this page"}
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {application
            ? "Reload the console to try again."
            : "Reload to try again, or choose another page from the navigation."}
        </p>
        <Button onClick={() => window.location.reload()}>Reload page</Button>
      </div>
    </div>
  );
}

export function ApplicationErrorBoundary({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <ErrorBoundary
      fallback={<Recovery application />}
      onError={reportRenderError}
    >
      {children}
    </ErrorBoundary>
  );
}

export function PageErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  return (
    <ErrorBoundary
      fallback={<Recovery />}
      onError={reportRenderError}
      resetKeys={[location.pathname]}
    >
      {children}
    </ErrorBoundary>
  );
}
