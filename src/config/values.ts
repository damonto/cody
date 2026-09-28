/** Stable wire values shared by runtime schemas and consumers. */

export const ProviderType = {
  AiGateway: "ai_gateway",
  Antigravity: "antigravity",
  Codex: "codex",
} as const;

export type ProviderType = (typeof ProviderType)[keyof typeof ProviderType];

export const CredentialAuthType = {
  ApiKey: "api_key",
  OAuth: "oauth",
} as const;

export type CredentialAuthType =
  (typeof CredentialAuthType)[keyof typeof CredentialAuthType];

export const ProxyStrategy = {
  Random: "random",
  Sticky: "sticky",
  Priority: "priority",
} as const;

export type ProxyStrategy = (typeof ProxyStrategy)[keyof typeof ProxyStrategy];

export const CodexAccountSelection = {
  RoundRobin: "round_robin",
  SessionAffinity: "session_affinity",
} as const;

export type CodexAccountSelection =
  (typeof CodexAccountSelection)[keyof typeof CodexAccountSelection];
