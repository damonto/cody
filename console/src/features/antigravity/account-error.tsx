import type { AntigravityVerification } from "../../../../src/shared/antigravity-verification";
import { Button } from "@/components/ui/button";

export function AccountError({
  error,
  verification,
}: {
  error: string | null | undefined;
  verification?: AntigravityVerification[];
}) {
  if (!verification?.length)
    return error ? (
      <p role="alert" className="text-destructive">
        {error}
      </p>
    ) : null;
  return (
    <div className="space-y-2">
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {verification.map((item, index) => (
        <div key={`${item.reason}-${index}`} className="space-y-1">
          {!error?.includes(item.message) && (
            <p role="alert" className="text-destructive">
              {item.message}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {item.url && (
              <Button variant="outline" size="sm" asChild>
                <a href={item.url} target="_blank" rel="noopener noreferrer">
                  {item.reason === "RESTRICTED_AGE"
                    ? "Verify age"
                    : "Verify account"}
                </a>
              </Button>
            )}
            {item.learn_more_url && (
              <Button variant="link" size="sm" asChild>
                <a
                  href={item.learn_more_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Learn more
                </a>
              </Button>
            )}
          </div>
        </div>
      ))}
      <p className="text-muted-foreground">
        Complete verification with this Google account, then retry.
        {verification.some((item) => !item.url) &&
          " Open the official Antigravity app to continue when no verification link is available."}
      </p>
    </div>
  );
}
