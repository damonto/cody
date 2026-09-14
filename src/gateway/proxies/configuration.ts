import type {
  GatewayConfig,
  ProviderConfig,
  ProviderCredentialConfig,
  ProxyGroupConfig,
} from "../../config/types.ts";
import type { ProxyGroupSnapshot, ProxyOwner } from "./schema.ts";

export interface ProxyGroupReference {
  readonly groupId: string;
  readonly owner: ProxyOwner;
}

export function effectiveProxyGroup(
  provider: Pick<ProviderConfig, "id" | "proxy_group">,
  credential: Pick<ProviderCredentialConfig, "id" | "proxy_group">,
): ProxyGroupReference | undefined {
  const inherited = credential.proxy_group === undefined;
  const groupId = inherited ? provider.proxy_group : credential.proxy_group;
  if (!groupId) {
    return undefined;
  }
  return {
    groupId,
    owner: {
      provider_id: provider.id,
      ...(inherited ? {} : { credential_id: credential.id }),
    },
  };
}

/** Send connection fingerprints to coordination storage without sending credentials. */
export async function proxyGroupSnapshot(
  config: Pick<GatewayConfig, "revision">,
  group: ProxyGroupConfig,
): Promise<ProxyGroupSnapshot> {
  const encoder = new TextEncoder();
  return {
    id: group.id,
    revision: config.revision ?? 0,
    strategy: group.strategy,
    proxies: await Promise.all(
      group.proxies.map(async (node) => {
        const bytes = encoder.encode(
          JSON.stringify([
            node.url,
            node.username ?? null,
            node.password ?? null,
          ]),
        );
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return {
          id: node.id,
          priority: node.priority,
          disabled: node.disabled,
          fingerprint: [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join(""),
        };
      }),
    ),
  };
}
