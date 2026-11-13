import {
  OAuthFlow,
  OAuthAccountViewStatus,
} from "../../../../src/providers/oauth/values.ts";

import { useState } from "react";
import { connectionSchema } from "../../../../src/providers/oauth/schema";
import { ErrorNotice, Status } from "@/components/common";
import { Button } from "@/components/ui/button";
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
import { AuthorizationSession } from "./authorization-session";

type NativeFlow = typeof OAuthFlow.Device | typeof OAuthFlow.Pkce;

const flowDescriptions = {
  [OAuthFlow.Device]:
    "Sign in on any device and enter a one-time code. Enable device code authorization in ChatGPT security settings first.",
  [OAuthFlow.Pkce]:
    "Sign in in this browser, then paste the localhost address the browser was sent to.",
} satisfies Record<NativeFlow, string>;

export function Authorization({
  rowId,
  occupied,
  ...options
}: AuthorizationOptions & {
  rowId: string;
  occupied: string[];
}) {
  const { accountRef, connection } = options;
  const [flow, setFlow] = useState<NativeFlow>(OAuthFlow.Device);
  const controls = useAuthorization(options);
  const {
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
    view,
    active,
    error,
  } = controls;
  const failedAdoption = adopt.error ? adopt.variables : undefined;
  const reusable = available.data?.filter(
    (value) =>
      value.account_ref !== accountRef && !occupied.includes(value.account_ref),
  );
  const selectedFlow = flow;
  const ready = view?.status === OAuthAccountViewStatus.Ready;
  let authorizeLabel: string;
  if (start.isPending) authorizeLabel = "Creating authorization…";
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
          if (value === OAuthFlow.Device || value === OAuthFlow.Pkce)
            setFlow(value);
        }}
      >
        <TabsList className="grid h-auto w-full grid-cols-2">
          <TabsTrigger value={OAuthFlow.Device} disabled={!!active}>
            Device code
          </TabsTrigger>
          <TabsTrigger value={OAuthFlow.Pkce} disabled={!!active}>
            Paste callback URL
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
              disabled={!ready || refresh.isPending}
              onClick={() =>
                refresh.mutate({
                  ref: accountRef,
                  kind: "models",
                  mode: "native",
                })
              }
            >
              Discover models
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!ready || refresh.isPending}
              onClick={() =>
                refresh.mutate({
                  ref: accountRef,
                  kind: "quota",
                  mode: "native",
                })
              }
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
      <AuthorizationSession rowId={rowId} controls={controls} />
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
              configurations. Any SIWC binding is also cleared, with remote
              revocation attempted. You can reauthorize the same account later.
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
