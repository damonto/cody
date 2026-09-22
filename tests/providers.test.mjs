import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../src/config/store.ts";
import {
  prepareProviderRequest,
  providerSupportsEndpoint,
} from "../src/providers/index.ts";

function configuration() {
  return parseConfig({
    providers: [
      {
        id: "upstream",
        type: "ai_gateway",
        base_url: "https://upstream.example/v1",
        models: ["real"],
        priority: 10,
        disabled: false,
        credentials: [
          {
            id: "primary",
            auth: { type: "api_key", api_key: "private-upstream" },
            priority: 5,
            disabled: false,
          },
        ],
      },
    ],
    api_keys: [
      { id: "client", api_key: "private-client", providers: ["upstream"] },
    ],
  });
}

test("only implemented provider and credential types are accepted", () => {
  assert.throws(() => parseConfig({ services: [], api_keys: [] }));
  for (const mutate of [
    (value) => (value.services = []),
    (value) => (value.providers[0].type = "codex"),
    (value) => (value.providers[0].protocol = "anthropic"),
    (value) => (value.providers[0].keys = []),
    (value) =>
      (value.providers[0].credentials[0].auth = {
        type: "oauth",
        account_ref: "future",
      }),
  ]) {
    const value = configuration();
    mutate(value);
    assert.throws(() => parseConfig(value));
  }
});

test("AI Gateway adapter supports both request dialects and strips client credentials", async () => {
  const config = configuration(),
    provider = config.providers[0],
    credential = provider.credentials[0];
  for (const endpoint of ["responses", "messages", "models"]) {
    const request = new Request(
      `https://gateway.example/v1/${endpoint}?trace=1`,
      {
        headers: {
          authorization: "Bearer private-client",
          "x-api-key": "private-client",
          "x-custom": "keep",
          "anthropic-version": "2023-06-01",
        },
      },
    );
    const prepared = await prepareProviderRequest(provider, credential, {
      request,
      endpoint,
      transport: "http",
      protocol: "anthropic",
    });
    assert.equal(
      prepared.url,
      `https://upstream.example/v1/${endpoint}?trace=1`,
    );
    assert.equal(
      prepared.headers.get("authorization"),
      "Bearer private-upstream",
    );
    assert.equal(prepared.headers.get("x-api-key"), null);
    assert.equal(prepared.headers.get("x-custom"), "keep");
    assert.equal(prepared.headers.get("anthropic-version"), "2023-06-01");
  }
  assert.equal(
    providerSupportsEndpoint(provider, "responses", "websocket"),
    false,
  );
  assert.equal(
    providerSupportsEndpoint(provider, "alpha/notes/v2/read_file"),
    false,
  );
  assert.equal(
    providerSupportsEndpoint(
      { ...provider, supports_websocket: true },
      "responses",
      "websocket",
    ),
    true,
  );
  assert.equal(
    providerSupportsEndpoint(
      { ...provider, supports_context_management: true },
      "alpha/notes/v2/read_file",
    ),
    true,
  );
});

test("AI Gateway adapter merges the 1M context beta only into Anthropic inference requests", async () => {
  const config = configuration();
  const provider = { ...config.providers[0], anthropic_1m_context: true };
  const credential = provider.credentials[0];
  const payload = { model: "claude-opus-5", max_tokens: 8 };
  const prepare = (protocol, headers = {}, endpoint = "messages") =>
    prepareProviderRequest(provider, credential, {
      request: new Request(`https://gateway.example/v1/${endpoint}`, {
        headers: { digest: "keep", ...headers },
      }),
      endpoint,
      transport: "http",
      protocol,
      payload,
      model: payload.model,
    });

  // The body is never rewritten, so the model name and digests stay intact.
  const anthropic = await prepare("anthropic");
  assert.equal(anthropic.body, undefined);
  assert.equal(
    anthropic.headers.get("anthropic-beta"),
    "context-1m-2025-08-07",
  );
  assert.equal(anthropic.headers.get("digest"), "keep");

  // Claude Code's own betas are preserved and the 1M beta is never duplicated.
  const merged = await prepare("anthropic", {
    "anthropic-beta": "claude-code-20250219,context-1m-2025-08-07",
  });
  assert.equal(
    merged.headers.get("anthropic-beta"),
    "claude-code-20250219,context-1m-2025-08-07",
  );
  const appended = await prepare("anthropic", {
    "anthropic-beta": "claude-code-20250219",
  });
  assert.equal(
    appended.headers.get("anthropic-beta"),
    "claude-code-20250219,context-1m-2025-08-07",
  );

  const openai = await prepare("openai", {}, "responses");
  assert.equal(openai.headers.get("anthropic-beta"), null);
  const catalog = await prepare("anthropic", {}, "models");
  assert.equal(catalog.headers.get("anthropic-beta"), null);
  const counted = await prepare("anthropic", {}, "messages/count_tokens");
  assert.equal(counted.headers.get("anthropic-beta"), "context-1m-2025-08-07");

  const disabled = await prepareProviderRequest(
    config.providers[0],
    credential,
    {
      request: new Request("https://gateway.example/v1/messages", {
        headers: { "anthropic-beta": "claude-code-20250219" },
      }),
      endpoint: "messages",
      transport: "http",
      protocol: "anthropic",
      payload,
      model: payload.model,
    },
  );
  assert.equal(disabled.body, undefined);
  assert.equal(disabled.headers.get("anthropic-beta"), "claude-code-20250219");
});
