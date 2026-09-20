import { ExternalLink } from "lucide-react";
import { ErrorNotice, Status } from "@/components/common";
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
import { connectionSchema } from "../../../../src/providers/oauth/schema";
import { AccountQuota } from "./quota";
import {
  useAuthorization,
  type AuthorizationOptions,
} from "./use-authorization";

export function Authorization({
  rowId,
  occupied,
  ...options
}: AuthorizationOptions & {
  rowId: string;
  occupied: string[];
}) {
  const { accountRef, connection } = options;
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
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Status value={view?.status ?? "not authorized"} />
        {view?.email && <span>{view.email}</span>}
        {view?.project_id && (
          <span className="text-xs text-muted-foreground">
            Project: {view.project_id}
          </span>
        )}
      </div>
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
            start.mutate();
          }}
        >
          {start.isPending
            ? "Creating authorization…"
            : accountRef
              ? "Reauthorize account"
              : "Authorize with Google"}
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
          {authorization.url && (
            <>
              <Button asChild type="button" variant="outline">
                <a
                  href={authorization.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open Google authorization
                  <ExternalLink />
                </a>
              </Button>
              <p className="text-xs text-muted-foreground">
                Google sign-in uses your browser network. After approval, the
                localhost page may not load: copy its complete URL from the
                address bar and paste it below. This session lasts ten minutes.
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
                placeholder="http://localhost:51121/oauth-callback?code=…&state=…"
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
          {authorization.status === "initializing" && (
            <p className="text-xs">
              Tokens are saved. Discovering the account and initializing its
              project…
            </p>
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
              Retry project initialization
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
      {view && <AccountQuota account={view} />}
      <AlertDialog open={disconnect} onOpenChange={setDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect this account?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes its local tokens immediately, including for published
              configurations. It does not revoke your Google grant. You can
              reauthorize the same account later.
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
