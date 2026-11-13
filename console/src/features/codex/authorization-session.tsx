import { ExternalLink } from "lucide-react";
import {
  OAuthFlow,
  OAuthSessionStatus,
} from "../../../../src/providers/oauth/values.ts";
import { CopyButton } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { useAuthorization } from "../oauth-accounts/use-authorization";

type SessionControls = Pick<
  ReturnType<typeof useAuthorization>,
  | "authorization"
  | "callback"
  | "setCallback"
  | "submit"
  | "retry"
  | "cancel"
  | "active"
>;

/** Codex native and SIWC grants share the callback, retry and cancellation UI. */
export function AuthorizationSession({
  rowId,
  controls,
}: {
  rowId: string;
  controls: SessionControls;
}) {
  const {
    authorization,
    callback,
    setCallback,
    submit,
    retry,
    cancel,
    active,
  } = controls;
  if (!authorization) return null;
  const pending = authorization.status === OAuthSessionStatus.Pending;
  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <p className="text-sm font-medium">
        Authorization: {authorization.status}
      </p>
      {pending && authorization.flow === OAuthFlow.Device && (
        <>
          {authorization.user_code && (
            <div className="flex items-center gap-2">
              <code
                className="rounded-md border bg-background px-3 py-1.5 font-mono text-lg tracking-widest"
                aria-label="Device code"
              >
                {authorization.user_code}
              </code>
              <CopyButton
                value={authorization.user_code}
                title="Copy device code"
              />
            </div>
          )}
          {authorization.verification_uri && (
            <Button asChild type="button" variant="outline">
              <a
                href={authorization.verification_uri}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open ChatGPT device sign-in
                <ExternalLink />
              </a>
            </Button>
          )}
          <p className="text-xs text-muted-foreground">
            Enter the code on the sign-in page. This page updates automatically
            after approval; the code lasts fifteen minutes.
          </p>
        </>
      )}
      {pending &&
        authorization.flow !== OAuthFlow.Device &&
        authorization.url && (
          <>
            <Button asChild type="button" variant="outline">
              <a
                href={authorization.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open ChatGPT authorization
                <ExternalLink />
              </a>
            </Button>
            <p className="text-xs text-muted-foreground">
              After approval the browser opens a localhost page that may not
              load. Copy its complete URL from the address bar and paste it
              below. This session lasts ten minutes.
            </p>
            <Label htmlFor={`callback-${rowId}`}>
              {authorization.flow === OAuthFlow.Siwc
                ? "127.0.0.1 callback URL"
                : "Localhost callback URL"}
            </Label>
            <Input
              id={`callback-${rowId}`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={callback}
              onChange={(event) => setCallback(event.target.value)}
              placeholder={
                authorization.flow === OAuthFlow.Siwc
                  ? "http://127.0.0.1:1455/auth/callback?code=…&state=…&client_id=…"
                  : "http://localhost:1455/auth/callback?code=…&state=…"
              }
            />
            <Button
              type="button"
              disabled={!callback.trim() || submit.isPending}
              onClick={() => submit.mutate()}
            >
              Complete authorization
            </Button>
          </>
        )}
      {authorization.status === OAuthSessionStatus.Exchanging && (
        <p className="text-xs">Exchanging the authorization code…</p>
      )}
      {authorization.error && (
        <p role="alert" className="text-sm text-destructive">
          {authorization.error}
        </p>
      )}
      {authorization.can_retry && (
        <Button
          type="button"
          variant="outline"
          disabled={retry.isPending}
          onClick={() => retry.mutate()}
        >
          Retry account initialization
        </Button>
      )}
      {(active || authorization.can_retry) && (
        <Button
          type="button"
          variant="ghost"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate()}
        >
          Cancel authorization
        </Button>
      )}
    </div>
  );
}
