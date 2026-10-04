import { resourceKeys } from "@/lib/resources";
import type {
  AiGatewayProviderConfig,
  OAuthProviderConfig,
  OAuthCredentialConfig,
} from "../../../../src/config/types";
import { rpc, read } from "@/lib/api";
import {
  useConfigurationMutation,
  withoutId,
} from "@/lib/configuration-mutation";

export function useSaveProvider() {
  return useConfigurationMutation<{
    version: number;
    id: string | null;
    provider: AiGatewayProviderConfig;
  }>(
    [resourceKeys.providers, resourceKeys.prices, ["entity-names"]],
    (input) => {
      const json = {
        version: input.version,
        operation_id: input.operation_id,
        provider: withoutId(input.provider),
      };
      return input.id === null
        ? read(rpc.providers.$post({ json }))
        : read(rpc.providers[":id"].$put({ param: { id: input.id }, json }));
    },
  );
}
export function useDeleteProvider() {
  return useConfigurationMutation<{ version: number; id: string }>(
    [
      resourceKeys.providers,
      resourceKeys.prices,
      resourceKeys.clients,
      resourceKeys.routes,
      ["entity-names"],
    ],
    ({ id, version, operation_id }) =>
      read(
        rpc.providers[":id"].$delete({
          param: { id },
          json: { version, operation_id },
        }),
      ),
  );
}

type NativeChange = { version: number } & (
  | { action: "settings"; provider: OAuthProviderConfig }
  | {
      action: "create-credential";
      providerId: string;
      credential: OAuthCredentialConfig;
    }
  | {
      action: "update-credential";
      providerId: string;
      credential: OAuthCredentialConfig;
    }
  | { action: "delete-credential"; providerId: string; credentialId: string }
  | { action: "reorder-credentials"; providerId: string; ids: string[] }
);
export function useNativeProviderMutation(type: OAuthProviderConfig["type"]) {
  return useConfigurationMutation<NativeChange>(
    (input) => [
      resourceKeys.providers,
      [...resourceKeys.native, type],
      ["entity-names"],
      ...(input.action === "settings" ? [resourceKeys.prices] : []),
    ],
    (input) => {
      const operation = {
        version: input.version,
        operation_id: input.operation_id,
      };
      if (input.action === "settings") {
        const {
          id: _id,
          credentials: _credentials,
          ...settings
        } = input.provider;
        return read(
          rpc["native-providers"][":type"].$put({
            param: { type: settings.type },
            json: { ...operation, settings },
          }),
        );
      }
      const provider = rpc.providers[":id"];
      const param = { id: input.providerId };
      if (input.action === "reorder-credentials")
        return read(
          provider.credentials.order.$put({
            param,
            json: { ...operation, ids: input.ids },
          }),
        );
      if (input.action === "delete-credential")
        return read(
          provider.credentials[":credentialId"].$delete({
            param: { ...param, credentialId: input.credentialId },
            json: operation,
          }),
        );
      const json = { ...operation, credential: withoutId(input.credential) };
      return input.action === "create-credential"
        ? read(provider.credentials.$post({ param, json }))
        : read(
            provider.credentials[":credentialId"].$put({
              param: { ...param, credentialId: input.credential.id },
              json,
            }),
          );
    },
  );
}
export function useSaveModelSettings() {
  return useConfigurationMutation<{
    version: number;
    providerId: string;
    modelId: string;
    family?: boolean;
    context_window: number | null;
  }>(
    [resourceKeys.providers, resourceKeys.native],
    ({
      version,
      operation_id,
      providerId,
      modelId,
      context_window,
      family,
    }) => {
      const model = rpc.providers[":id"].models[":modelId"];
      const resource = family ? model.family : model;
      return read(
        resource.$put({
          param: { id: providerId, modelId },
          json: { version, operation_id, settings: { context_window } },
        }),
      );
    },
  );
}
