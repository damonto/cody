import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { read, rpc } from "@/lib/api";
import {
  connectionSchema,
  sessionViewSchema,
  type AccountView,
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
  connection: ProviderConnection & { provider_id: "antigravity" };
  version: number;
  draftVersion: number;
  onAuthorized: (ref: string) => void;
}

const pendingStatuses: readonly SessionView["status"][] = [
  "pending",
  "exchanging",
  "initializing",
];

/** Owns the remote authorization lifecycle; the form only stores the stable account reference. */
export function useAuthorization({
  accountRef,
  connection,
  version,
  draftVersion,
  onAuthorized,
}: AuthorizationOptions) {
  const cache = useQueryClient();
  const [id, setId] = useState("");
  const [callback, setCallback] = useState("");
  const [disconnect, setDisconnect] = useState(false);
  const completed = useRef("");
  const session = useQuery({
    ...sessionOptions(id),
    refetchInterval: (query) =>
      query.state.data && pendingStatuses.includes(query.state.data.status)
        ? 2000
        : false,
  });
  const account = useQuery(accountOptions(accountRef));
  const available = useQuery(accountsOptions(connection.provider_id));
  const putSession = (value: SessionView) => {
    cache.setQueryData(sessionOptions(value.id).queryKey, value);
    setId(value.id);
  };
  const start = useMutation({
    mutationFn: async () => {
      if (version !== draftVersion)
        throw new Error(
          "The draft changed. Your form is retained; reopen it from the latest draft before starting authorization.",
        );
      const parsed = connectionSchema.parse(connection);
      return sessionViewSchema.parse(
        await read(
          rpc.oauth.sessions.$post({
            json: {
              ...parsed,
              provider_id: connection.provider_id,
              version,
              ...(accountRef ? { account_ref: accountRef } : {}),
            },
          }),
        ),
      );
    },
    onSuccess: (value) => {
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
      putSession(value);
      setCallback("");
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
      putSession(value);
      setCallback("");
    },
  });
  const refresh = useMutation({
    mutationFn: ({
      ref,
      kind,
    }: {
      ref: string;
      kind: "models" | "quota" | "disconnect";
    }) =>
      kind === "models"
        ? refreshModels(ref)
        : kind === "quota"
          ? refreshQuota(ref, true)
          : disconnectAccount(ref),
    onSuccess: async (value, { kind }) => {
      await cacheAccounts(cache, [value]);
      if (kind === "disconnect") setDisconnect(false);
    },
  });
  const adopt = useMutation({
    mutationFn: async ({
      account,
    }: {
      account: AccountView;
      discover: boolean;
    }) => {
      await cacheAccounts(cache, [account]);
      return account;
    },
    onSuccess: (value, { discover }) => {
      submit.reset();
      retry.reset();
      cancel.reset();
      onAuthorized(value.account_ref);
      if (discover) refresh.mutate({ ref: value.account_ref, kind: "models" });
    },
  });
  // Completion arrives through polling, not necessarily through a local button click.
  const onCompleted = useEffectEvent((value: SessionView) => {
    adopt.mutate({ account: value.account, discover: true });
  });
  const authorization = session.data;
  useEffect(() => {
    if (
      authorization?.status !== "complete" ||
      completed.current === authorization.id
    )
      return;
    completed.current = authorization.id;
    onCompleted(authorization);
  }, [authorization]);

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
    error:
      start.error ??
      submit.error ??
      retry.error ??
      cancel.error ??
      refresh.error ??
      adopt.error,
  };
}
