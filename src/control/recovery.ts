import type { GatewayConfig } from "../config/types.ts";
import { ControlInputError } from "./errors.ts";

/** Restoring settings never revives historical credentials or OAuth token state. */
export function preserveCurrentSecrets(
  config: GatewayConfig,
  current: GatewayConfig,
): void {
  // A configuration restore never rotates an existing credential back to an old secret.
  for (const client of config.api_keys) {
    const latest = current.api_keys.find((item) => item.id === client.id);
    if (!latest)
      throw new ControlInputError(
        "Cannot restore a configuration that references deleted clients",
      );
    client.api_key = latest.api_key;
  }
  for (const provider of config.providers)
    for (const credential of provider.credentials) {
      const latest = current.providers
        .find((p) => p.id === provider.id)
        ?.credentials.find((c) => c.id === credential.id);
      if (!latest)
        throw new ControlInputError(
          "Cannot restore a configuration that references deleted credentials",
        );
      credential.auth = latest.auth;
    }
  for (const group of config.proxy_groups)
    for (const node of group.proxies) {
      const latest = current.proxy_groups
        .find((item) => item.id === group.id)
        ?.proxies.find((item) => item.id === node.id);
      if (!latest)
        throw new ControlInputError(
          "Cannot restore a configuration that references deleted proxy nodes",
        );
      if (latest.password === undefined) delete node.password;
      else node.password = latest.password;
    }
  // Search credentials are provider-specific and may have changed since this version.
  if (config.web_search.mode !== "proxy") {
    if (config.web_search.mode !== current.web_search.mode)
      throw new ControlInputError(
        "Configure the current search provider before restoring its settings",
      );
    config.web_search.api_key = current.web_search.api_key;
  }
}
