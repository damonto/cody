import { useState } from "react";
import type { CodexProviderConfig } from "../../../../src/config/types";
import type { AccountView } from "../../../../src/providers/oauth/schema";
import {
  OAuthAccountViewStatus,
  OAuthFlow,
} from "../../../../src/providers/oauth/values.ts";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAuthorization } from "../oauth-accounts/use-authorization";
import { AuthorizationSession } from "./authorization-session";

/** A card action binds its own account immediately; routing remains a separate saved setting. */
export function SiwcAuthorization({
  provider,
  credential,
  account,
  version,
  pending,
}: {
  provider: CodexProviderConfig;
  credential: CodexProviderConfig["credentials"][number];
  account: AccountView | undefined;
  version: number;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [welcome, setWelcome] = useState(false);
  const ref = credential.auth.account_ref;
  const authorization = useAuthorization({
    accountRef: ref,
    connection: {
      provider_id: provider.id,
      provider_type: provider.type,
      credential_id: credential.id,
      provider_proxy_group: provider.proxy_group,
      credential_proxy_group: credential.proxy_group,
    },
    version,
    configurationVersion: version,
    loadAccounts: false,
    onAuthorized: (value) => {
      setOpen(false);
      if (value.siwc?.plan_usage_enabled) {
        try {
          if (!localStorage.getItem(`cody:siwc-welcome:${ref}`))
            setWelcome(true);
        } catch {
          setWelcome(true);
        }
      }
    },
  });
  const nativeReady = account?.status === OAuthAccountViewStatus.Ready;
  const bound =
    account?.siwc?.status === OAuthAccountViewStatus.Ready &&
    account.siwc.plan_usage_enabled;
  const busy =
    pending || authorization.start.isPending || authorization.adopt.isPending;
  const begin = (requestConsent = false) => {
    setOpen(true);
    if (authorization.active || authorization.start.isPending) return;
    authorization.submit.reset();
    authorization.retry.reset();
    authorization.cancel.reset();
    authorization.start.mutate({ flow: OAuthFlow.Siwc, requestConsent });
  };
  const dismissWelcome = () => {
    try {
      localStorage.setItem(`cody:siwc-welcome:${ref}`, "seen");
    } catch {
      /* Preferences may be unavailable in private browsing. */
    }
    setWelcome(false);
  };
  let signInLabel = "Sign in with ChatGPT";
  if (authorization.start.isPending) signInLabel = "Creating authorization…";
  else if (authorization.active) signInLabel = "Continue SIWC sign-in";

  return (
    <>
      {bound ? (
        <Badge variant="secondary" title="Signed in with ChatGPT">
          SIWC
        </Badge>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={busy || (!nativeReady && !authorization.active)}
          onClick={() =>
            begin(!!account?.siwc && !account.siwc.plan_usage_enabled)
          }
        >
          {signInLabel}
        </Button>
      )}
      {!open && authorization.authorizationError && (
        <ErrorNotice error={authorization.authorizationError} />
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Sign in with ChatGPT</DialogTitle>
            <DialogDescription>
              Sign in to bind SIWC to{" "}
              {account?.email ?? credential.name ?? "this account"}. Binding is
              saved immediately. Codex clients always use native authorization;
              control SIWC for other clients in Codex settings.
            </DialogDescription>
          </DialogHeader>
          {authorization.start.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              Creating authorization…
            </p>
          ) : (
            <AuthorizationSession
              rowId={`siwc-${credential.id}`}
              controls={authorization}
            />
          )}
          {authorization.authorizationError && (
            <ErrorNotice
              error={authorization.authorizationError}
              retry={
                authorization.start.error
                  ? () =>
                      authorization.start.mutate(
                        authorization.start.variables ?? OAuthFlow.Siwc,
                      )
                  : undefined
              }
            />
          )}
          {authorization.session.error && (
            <ErrorNotice
              error={authorization.session.error}
              retry={() => void authorization.session.refetch()}
            />
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={welcome}
        onOpenChange={(value) => {
          if (!value) dismissWelcome();
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
    </>
  );
}
