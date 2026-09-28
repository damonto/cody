import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { connectionSchema } from "../../../../src/providers/oauth/schema";
import { CopyButton, ErrorNotice, Status } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  useAuthorization,
  type AuthorizationOptions,
} from "@/features/oauth-accounts/use-authorization";
import { planLabel } from "./plan";

type Flow = "device" | "pkce";

export function Authorization({
  rowId,
  occupied,
  ...options
}: AuthorizationOptions & {
  rowId: string;
  occupied: string[];
}) {
  const { accountRef, connection } = options;
  const [flow, setFlow] = useState<Flow>("device");
  const {
    callback,
    setCallback,
    disconnect,
    setDisconnect,
    session,
    account,
    available,
    start,
    submit,
    retry,
    cancel,
    refresh,
    adopt,
    authorization,
    view,
    active,
    error,
  } = useAuthorization(options);
  const failedAdoption = adopt.error ? adopt.variables : undefined;
  const reusable = available.data?.filter(
    (value) =>
      value.account_ref !== accountRef && !occupied.includes(value.account_ref),
  );
  const pending = authorization?.status === "pending";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Status value={view?.status ?? "not authorized"} />
        {view?.email && <span>{view.email}</span>}
        {view?.codex && (
          <span className="text-xs text-muted-foreground">
            {planLabel(view.codex.plan_type)}
          </span>
        )}
      </div>
      <Tabs
        value={flow}
        onValueChange={(value) => {
          if (value === "device" || value === "pkce") setFlow(value);
        }}
      >
        <TabsList>
          <TabsTrigger value="device" disabled={!!active}>
            Device code
          </TabsTrigger>
          <TabsTrigger value="pkce" disabled={!!active}>
            Paste callback URL
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <p className="text-xs text-muted-foreground">
        {flow === "device"
          ? "Sign in on any device and enter a one-time code. Enable device code authorization in ChatGPT security settings first."
          : "Sign in in this browser, then paste the localhost address the browser was sent to."}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={
            !!active ||
            start.isPending ||
            adopt.isPending ||
            !connectionSchema.safeParse(connection).success
          }
          onClick={() => {
            submit.reset();
            retry.reset();
            cancel.reset();
            start.mutate(flow);
          }}
        >
          {start.isPending
            ? "Creating authorization…"
            : accountRef
              ? "Reauthorize account"
              : "Authorize with ChatGPT"}
        </Button>
        {accountRef && (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={view?.status !== "ready" || refresh.isPending}
              onClick={() =>
                refresh.mutate({ ref: accountRef, kind: "models" })
              }
            >
              Discover models
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={view?.status !== "ready" || refresh.isPending}
              onClick={() => refresh.mutate({ ref: accountRef, kind: "quota" })}
            >
              Refresh quota
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={
                refresh.isPending || !!active || view?.status === "disconnected"
              }
              onClick={() => setDisconnect(true)}
            >
              Disconnect
            </Button>
          </>
        )}
      </div>
      {reusable?.length ? (
        <div className="space-y-2">
          <Label htmlFor={`reuse-${rowId}`}>
            Use an existing account for this provider
          </Label>
          <Select
            value=""
            onValueChange={(ref) => {
              const selected = reusable.find(
                (value) => value.account_ref === ref,
              );
              if (!selected) return;
              adopt.mutate({ account: selected, discover: false });
            }}
            disabled={active || adopt.isPending}
          >
            <SelectTrigger id={`reuse-${rowId}`}>
              <SelectValue placeholder="Recover an account from an earlier authorization" />
            </SelectTrigger>
            <SelectContent>
              {reusable.map((value) => (
                <SelectItem key={value.account_ref} value={value.account_ref}>
                  {value.email ?? value.account_ref} · {value.status}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {authorization && (
        <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
          <p className="text-sm font-medium">
            Authorization: {authorization.status}
          </p>
          {pending && authorization.flow === "device" && (
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
                Enter the code on the sign-in page. This page updates
                automatically after approval; the code lasts fifteen minutes.
              </p>
            </>
          )}
          {pending && authorization.flow === "pkce" && authorization.url && (
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
                Localhost callback URL
              </Label>
              <Input
                id={`callback-${rowId}`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={callback}
                onChange={(event) => setCallback(event.target.value)}
                placeholder="http://localhost:1455/auth/callback?code=…&state=…"
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
          {authorization.status === "exchanging" && (
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
      )}
      {error && (
        <ErrorNotice
          error={error}
          retry={
            failedAdoption ? () => adopt.mutate(failedAdoption) : undefined
          }
        />
      )}
      {session.error && (
        <ErrorNotice
          error={session.error}
          retry={() => void session.refetch()}
        />
      )}
      {account.error && (
        <ErrorNotice
          error={account.error}
          retry={() => void account.refetch()}
        />
      )}
      {available.error && (
        <ErrorNotice
          error={available.error}
          retry={() => void available.refetch()}
        />
      )}
      {view?.error && (
        <p role="alert" className="text-xs text-destructive">
          {view.error}
        </p>
      )}
      {view?.models_error && (
        <p role="alert" className="text-xs text-destructive">
          Model discovery: {view.models_error}
        </p>
      )}
      <AlertDialog open={disconnect} onOpenChange={setDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect this account?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes its local tokens immediately, including for published
              configurations. It does not sign the account out of ChatGPT. You
              can reauthorize the same account later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {refresh.error && <ErrorNotice error={refresh.error} />}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={refresh.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={refresh.isPending}
              onClick={(event) => {
                event.preventDefault();
                refresh.mutate({ ref: accountRef, kind: "disconnect" });
              }}
            >
              Disconnect account
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
