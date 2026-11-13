import {
  OAuthFlow,
  OAuthSessionStatus,
  OAuthAccountViewStatus,
} from "../../../../src/providers/oauth/values.ts";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { read, rpc } from "@/lib/api";
import {
  connectionSchema,
  sessionViewSchema,
  type AccountView,
  type OAuthProviderType,
  type ProviderConnection,
  type SessionView,
} from "../../../../src/providers/oauth/schema";
import {
  accountOptions,
  accountsOptions,
  cacheAccounts,
  disconnectAccount,
  refreshModels,
  refreshQuota,
  sessionOptions,
} from "./api";

export interface AuthorizationOptions {
  accountRef: string;
  connection: ProviderConnection & { provider_type: OAuthProviderType };
  version: number;
  configurationVersion: number;
  onAuthorized: (account: AccountView) => void;
}

const pendingStatuses: readonly SessionView["status"][] = [
  OAuthSessionStatus.Pending,
  OAuthSessionStatus.Exchanging,
  OAuthSessionStatus.Initializing,
];

/** Owns the remote authorization lifecycle; the form only stores the stable account reference. */
export function useAuthorization({
  accountRef,
  connection,
  version,
  configurationVersion,
  onAuthorized,
  loadAccounts = true,
}: AuthorizationOptions & { loadAccounts?: boolean }) {
  const cache = useQueryClient();
  const [id, setId] = useState("");
  const [callback, setCallback] = useState("");
  const [disconnect, setDisconnect] = useState(false);
  const completed = useRef("");
  const currentSessionId = useRef("");
  const session = useQuery({
    ...sessionOptions(id),
    refetchInterval: (query) =>
      query.state.data && pendingStatuses.includes(query.state.data.status)
        ? 2000
        : false,
  });
  const account = useQuery({
    ...accountOptions(accountRef),
    enabled: loadAccounts && !!accountRef,
  });
  const availableOptions = accountsOptions(connection.provider_id);
  const available = useQuery({
    ...availableOptions,
    enabled: loadAccounts && availableOptions.enabled,
  });
  const putSession = (value: SessionView) => {
    if (value.id !== currentSessionId.current) return false;
    cache.setQueryData(sessionOptions(value.id).queryKey, value);
    setId(value.id);
    return true;
  };
  const start = useMutation({
    mutationFn: async (
      selection:
        | OAuthFlow
        | { flow: OAuthFlow; requestConsent: boolean } = OAuthFlow.Pkce,
    ) => {
      const flow = typeof selection === "string" ? selection : selection.flow;
      if (version !== configurationVersion)
        throw new Error(
          "The configuration changed. Your form is retained; reopen it from the latest configuration before starting authorization.",
        );
      const parsed = connectionSchema.parse(connection);
      return sessionViewSchema.parse(
        await read(
          rpc.oauth.sessions.$post({
            json: {
              ...parsed,
              provider_id: connection.provider_id,
              provider_type: connection.provider_type,
              version,
              flow,
              ...(typeof selection !== "string" && selection.requestConsent
                ? { request_consent: true }
                : {}),
              ...(accountRef ? { account_ref: accountRef } : {}),
            },
          }),
        ),
      );
    },
    onSuccess: (value) => {
      currentSessionId.current = value.id;
      putSession(value);
      setCallback("");
    },
  });
  const submit = useMutation({
    mutationFn: async () =>
      sessionViewSchema.parse(
        await read(
          rpc.oauth.sessions[":id"].callback.$post({
            param: { id },
            json: { redirect_url: callback },
          }),
        ),
      ),
    onSuccess: (value) => {
      if (putSession(value)) setCallback("");
    },
  });
  const retry = useMutation({
    mutationFn: async () =>
      sessionViewSchema.parse(
        await read(
          rpc.oauth.sessions[":id"].retry.$post({ param: { id }, json: {} }),
        ),
      ),
    onSuccess: putSession,
  });
  const cancel = useMutation({
    mutationFn: async () =>
      sessionViewSchema.parse(
        await read(
          rpc.oauth.sessions[":id"].$delete({ param: { id }, json: {} }),
        ),
      ),
    onSuccess: (value) => {
      if (putSession(value)) setCallback("");
    },
  });
  const refresh = useMutation({
    mutationFn: ({
      ref,
      kind,
      mode,
    }: {
      ref: string;
      kind: "models" | "quota" | "disconnect";
      mode?: "native" | "siwc";
    }) => {
      switch (kind) {
        case "models":
          return refreshModels(ref, mode);
        case "quota":
          return refreshQuota(ref, true);
        case "disconnect":
          return disconnectAccount(ref);
      }
    },
    onSuccess: async (value, { kind }) => {
      await cacheAccounts(cache, [value]);
      if (kind === "disconnect") setDisconnect(false);
    },
    onError: (_error, { ref }) => {
      // The remote change may have committed before its response was lost.
      void cache.invalidateQueries({ queryKey: accountOptions(ref).queryKey });
      void cache.invalidateQueries({
        queryKey: accountsOptions(connection.provider_id).queryKey,
      });
    },
  });
  const adopt = useMutation({
    mutationFn: async ({
      account,
    }: {
      account: AccountView;
      discover: boolean;
      mode?: "native" | "siwc";
    }) => {
      await cacheAccounts(cache, [account]);
      return account;
    },
    onSuccess: (value, { discover, mode }) => {
      submit.reset();
      retry.reset();
      cancel.reset();
      onAuthorized(value);
      if (discover)
        refresh.mutate({
          ref: value.account_ref,
          kind: "models",
          ...(mode ? { mode } : {}),
        });
    },
  });
  // Completion arrives through polling, not necessarily through a local button click.
  const onCompleted = useEffectEvent((value: SessionView) => {
    adopt.mutate({
      account: value.account,
      discover:
        value.flow === OAuthFlow.Siwc
          ? !!value.account.siwc?.plan_usage_enabled
          : value.account.status === OAuthAccountViewStatus.Ready,
      mode: value.flow === OAuthFlow.Siwc ? "siwc" : "native",
    });
  });
  const authorization = session.data;
  useEffect(() => {
    if (
      authorization?.status !== OAuthSessionStatus.Complete ||
      authorization.id !== currentSessionId.current ||
      completed.current === authorization.id
    )
      return;
    completed.current = authorization.id;
    onCompleted(authorization);
  }, [authorization]);

  const authorizationError =
    start.error ?? submit.error ?? retry.error ?? cancel.error ?? adopt.error;

  return {
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
    view: account.data ?? authorization?.account,
    active: !!authorization && pendingStatuses.includes(authorization.status),
    authorizationError,
    error: authorizationError ?? refresh.error,
  };
}
