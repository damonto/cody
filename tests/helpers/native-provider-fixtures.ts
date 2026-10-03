import {
  CodexAccountSelection,
  ProviderType,
} from "../../src/config/values.ts";
import type {
  AntigravityProviderConfig,
  CodexProviderConfig,
  ClaudeProviderConfig,
  XaiProviderConfig,
} from "../../src/config/types.ts";

// Fixtures mirror native providers initialized by database migrations.
export function newAntigravityProvider(): AntigravityProviderConfig {
  return {
    type: ProviderType.Antigravity,
    id: crypto.randomUUID(),
    name: "Antigravity",
    account_selection: CodexAccountSelection.RoundRobin,
    priority: 100,
    disabled: true,
    models: [],
    credentials: [],
    supports_websocket: false,
    supports_context_management: false,
    supports_web_search: false,
    anthropic_1m_context: false,
    emulate_claude_code: false,
  };
}

export function newCodexProvider(): CodexProviderConfig {
  return {
    type: ProviderType.Codex,
    id: crypto.randomUUID(),
    name: "Codex",
    priority: 100,
    disabled: true,
    models: [],
    credentials: [],
    supports_websocket: true,
    supports_context_management: false,
    supports_web_search: true,
    anthropic_1m_context: false,
    emulate_claude_code: false,
    account_selection: CodexAccountSelection.RoundRobin,
    auto_consume_resets: false,
  };
}

export function newClaudeProvider(): ClaudeProviderConfig {
  return {
    type: ProviderType.Claude,
    id: crypto.randomUUID(),
    name: "Claude",
    priority: 100,
    disabled: true,
    models: [],
    credentials: [],
    supports_websocket: false,
    supports_context_management: false,
    supports_web_search: false,
    anthropic_1m_context: false,
    emulate_claude_code: false,
    account_selection: CodexAccountSelection.RoundRobin,
    allow_extra_usage: false,
  };
}

export function newXaiProvider(): XaiProviderConfig {
  return {
    type: ProviderType.Xai,
    id: crypto.randomUUID(),
    name: "Xai",
    priority: 100,
    disabled: true,
    models: [],
    credentials: [],
    supports_websocket: false,
    supports_context_management: false,
    supports_web_search: false,
    anthropic_1m_context: false,
    emulate_claude_code: false,
    account_selection: CodexAccountSelection.RoundRobin,
    allow_extra_usage: false,
    inject_x_search: false,
  };
}
