import {
  OAuthFlow,
  OAuthSessionStatus,
  OAuthAccountViewStatus,
} from "../../../../src/providers/oauth/values.ts";

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

const flowDescriptions = {
  [OAuthFlow.Device]:
    "Sign in on any device and enter a one-time code. Enable device code authorization in ChatGPT security settings first.",
  [OAuthFlow.Pkce]:
    "Sign in in this browser, then paste the localhost address the browser was sent to.",
  [OAuthFlow.Siwc]:
    "Use your ChatGPT plan in Cody through Sign in with ChatGPT.",
} satisfies Record<OAuthFlow, string>;

export function Authorization({
  rowId,
  occupied,
  ...options
}: AuthorizationOptions & {
  rowId: string;
  occupied: string[];
}) {
  const { accountRef, connection } = options;
  const [welcome, setWelcome] = useState(false);
  const [flow, setFlow] = useState<OAuthFlow>(OAuthFlow.Device);
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
  } = useAuthorization({
    ...options,
    onAuthorized: (account) => {
      options.onAuthorized(account);
      if (account.codex?.mode === "siwc" && account.codex.plan_usage_enabled) {
        try {
          if (!localStorage.getItem(`cody:siwc-welcome:${account.account_ref}`))
            setWelcome(true);
        } catch {
          setWelcome(true);
        }
      }
    },
  });
  const failedAdoption = adopt.error ? adopt.variables : undefined;
  const reusable = available.data?.filter(
    (value) =>
      value.account_ref !== accountRef && !occupied.includes(value.account_ref),
  );
  const siwc = view?.codex?.mode === "siwc";
  let selectedFlow = flow;
  if (accountRef && view?.codex) {
    if (siwc) selectedFlow = OAuthFlow.Siwc;
    else if (flow === OAuthFlow.Siwc) selectedFlow = OAuthFlow.Device;
  }
  const dismissWelcome = () => {
    try {
      if (view?.account_ref)
        localStorage.setItem(`cody:siwc-welcome:${view.account_ref}`, "seen");
    } catch {
      /* Preferences may be unavailable in private browsing. */
    }
    setWelcome(false);
  };
  const pending = authorization?.status === OAuthSessionStatus.Pending;
  let authorizeLabel: string;
  if (start.isPending) authorizeLabel = "Creating authorization…";
  else if (selectedFlow === OAuthFlow.Siwc)
    authorizeLabel = "Continue with ChatGPT";
  else if (accountRef) authorizeLabel = "Reauthorize account";
  else authorizeLabel = "Authorize with ChatGPT";

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
        value={selectedFlow}
        onValueChange={(value) => {
          if (
            value === OAuthFlow.Device ||
            value === OAuthFlow.Pkce ||
            value === OAuthFlow.Siwc
          )
            setFlow(value);
        }}
      >
        <TabsList className="grid h-auto w-full grid-cols-3">
          <TabsTrigger value={OAuthFlow.Device} disabled={!!active || !!siwc}>
            Device code
          </TabsTrigger>
          <TabsTrigger value={OAuthFlow.Pkce} disabled={!!active || !!siwc}>
            Paste callback URL
          </TabsTrigger>
          <TabsTrigger
            value={OAuthFlow.Siwc}
            disabled={!!active || (!!accountRef && !!view?.codex && !siwc)}
          >
            Sign in with ChatGPT
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <p className="text-xs text-muted-foreground">
        {flowDescriptions[selectedFlow]}
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
            start.mutate(selectedFlow);
          }}
        >
          {authorizeLabel}
        </Button>
        {accountRef && (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={
                view?.status !== OAuthAccountViewStatus.Ready ||
                (siwc && !view?.codex?.plan_usage_enabled) ||
                refresh.isPending
              }
              onClick={() =>
                refresh.mutate({ ref: accountRef, kind: "models" })
              }
            >
              Discover models
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={
                view?.status !== OAuthAccountViewStatus.Ready ||
                (siwc && !view?.codex?.plan_usage_enabled) ||
                refresh.isPending
              }
              onClick={() => refresh.mutate({ ref: accountRef, kind: "quota" })}
            >
              Refresh
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={
                refresh.isPending ||
                !!active ||
                view?.status === OAuthAccountViewStatus.Disconnected
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
            Add a previously authorized account
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
              <SelectValue placeholder="Select a previously authorized account" />
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
                Enter the code on the sign-in page. This page updates
                automatically after approval; the code lasts fifteen minutes.
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
      )}
      {siwc && (
        <div className="space-y-2 text-xs text-muted-foreground">
          <p>
            {view?.codex?.plan_usage_enabled
              ? "ChatGPT plan usage enabled"
              : "ChatGPT plan usage disabled"}
          </p>
          <a
            className="underline"
            href="https://chatgpt.com/settings/usage"
            target="_blank"
            rel="noopener noreferrer"
          >
            Manage ChatGPT usage
          </a>
          {!view?.codex?.plan_usage_enabled && (
            <Button
              type="button"
              variant="outline"
              disabled={!!active || start.isPending}
              onClick={() =>
                start.mutate({ flow: OAuthFlow.Siwc, requestConsent: true })
              }
            >
              Enable ChatGPT plan usage
            </Button>
          )}
        </div>
      )}
      <AlertDialog
        open={welcome}
        onOpenChange={(open) => {
          if (!open) dismissWelcome();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>You’re using your ChatGPT plan</AlertDialogTitle>
            <AlertDialogDescription>
              Eligible requests in Cody use your ChatGPT plan. Manage usage and
              app access in ChatGPT Settings.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction>Got it</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
              This deletes its local tokens immediately, including for active
              configurations.{" "}
              {siwc
                ? "Remote session revocation will be attempted. Unconfirmed revocation is reported here."
                : "It does not sign the account out of ChatGPT."}{" "}
              You can reauthorize the same account later.
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
