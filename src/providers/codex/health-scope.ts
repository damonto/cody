import type { CodexMode } from "./account-schema.ts";

/** Native keeps its deployed health address; SIWC has an independent backend and credential scope. */
export function codexHealthProviderId(
  providerId: string,
  mode?: CodexMode,
): string {
  return mode === "siwc" ? `${providerId}:siwc` : providerId;
}
