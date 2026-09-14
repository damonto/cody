import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { parseConfig } from "../../src/config/store.ts";
import { handleInference } from "../../src/gateway/http/proxy.ts";
import { handleModels } from "../../src/gateway/catalog/models.ts";
import { handleContextManagement } from "../../src/gateway/sessions/context-management.ts";
import { socksFetch } from "../../src/gateway/transport/socks-fetch.ts";
import { SocksProxyError } from "../../src/gateway/proxies/errors.ts";
import { proxyGroupSnapshot } from "../../src/gateway/proxies/configuration.ts";

vi.mock(
  import("../../src/gateway/transport/socks-fetch.ts"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    socksFetch: vi.fn<typeof socksFetch>(),
  }),
);
afterEach(() => vi.resetAllMocks());

function fixture() {
  const id = crypto.randomUUID();
  return parseConfig({
    proxy_groups: [
      {
        id,
        strategy: "priority",
        proxies: ["a", "b"].map((node, index) => ({
          id: node,
          url: `socks5://${node}.test:1080`,
          priority: 100 - index,
          disabled: false,
        })),
      },
    ],
    providers: [
      {
        type: "ai_gateway",
        id,
        base_url: "https://upstream.test/v1",
        proxy_group: id,
        credentials: [
          {
            id: "key",
            auth: { type: "api_key", api_key: "upstream-secret" },
            priority: 100,
            disabled: false,
          },
        ],
        models: ["model"],
        priority: 100,
        disabled: false,
        supports_context_management: true,
      },
    ],
    api_keys: [{ id, api_key: "client-secret", providers: [id] }],
    model_routes: { "gpt-6-astra": { model: "model" } },
  });
}
const request = (endpoint: string, body: unknown = { model: "model" }) =>
  new Request(`https://gateway.test/v1/${endpoint}`, {
    method: "POST",
    headers: {
      authorization: "Bearer client-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

for (const endpoint of ["responses", "messages"] as const) {
  test(`${endpoint} proxy failures cool only proxy nodes and unavailable groups return protocol-shaped 503`, async () => {
    const config = fixture();
    vi.mocked(socksFetch).mockRejectedValue(
      new SocksProxyError("SOCKS5 authentication failed"),
    );
    for (let index = 0; index < 3; index++) {
      const context = createExecutionContext();
      const response = await handleInference(
        request(endpoint),
        env,
        config,
        config.api_keys[0],
        endpoint,
        `request-${index}`,
        context,
      );
      expect(response.status).toBe(502);
      await waitOnExecutionContext(context);
    }
    expect(socksFetch).toHaveBeenCalledTimes(6);
    expect(
      (await env.HEALTH.getByName(config.providers[0].id).getStatus()).failures,
    ).toBe(0);
    const response = await handleInference(
      request(endpoint),
      env,
      config,
      config.api_keys[0],
      endpoint,
    );
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject(
      endpoint === "messages"
        ? { type: "error", error: { type: "overloaded_error" } }
        : { error: { code: "proxy_group_unavailable" } },
    );
    expect(socksFetch).toHaveBeenCalledTimes(6);
  });
}

test("catalog transport failures share proxy cooldown with inference while provider health stays separate", async () => {
  const config = fixture();
  vi.mocked(socksFetch).mockRejectedValue(
    new SocksProxyError("SOCKS5 connection failed"),
  );
  for (let index = 0; index < 3; index++) {
    const context = createExecutionContext();
    const response = await handleModels(
      new Request("https://gateway.test/v1/models"),
      env,
      config,
      config.api_keys[0],
      `catalog-${index}`,
      context,
    );
    expect(response.status).toBe(502);
    await waitOnExecutionContext(context);
  }
  const provider = config.providers[0].id;
  expect((await env.HEALTH.getByName(provider).getStatus()).failures).toBe(0);
  expect(
    (await env.HEALTH.getByName(`${provider}:catalog`).getStatus()).failures,
  ).toBe(0);
  expect(
    (
      await handleInference(
        request("responses"),
        env,
        config,
        config.api_keys[0],
        "responses",
      )
    ).status,
  ).toBe(503);
});

test("catalog's total deadline during proxy setup is attributed to the proxy", async () => {
  const config = fixture();
  vi.mocked(socksFetch).mockImplementation(async (request, _node, options) => {
    options?.onStage?.("proxy");
    await new Promise<never>((_resolve, reject) => {
      request.signal.addEventListener(
        "abort",
        () => reject(new SocksProxyError("SOCKS5 connection timed out")),
        { once: true },
      );
    });
    throw new Error("unreachable");
  });
  const context = createExecutionContext();
  const started = Date.now();
  const response = await handleModels(
    new Request("https://gateway.test/v1/models"),
    env,
    config,
    config.api_keys[0],
    "catalog-timeout",
    context,
  );
  expect(response.status).toBe(502);
  expect(Date.now() - started).toBeLessThan(4500);
  await waitOnExecutionContext(context);
  expect(socksFetch).toHaveBeenCalledTimes(1);
  expect(
    (
      await env.HEALTH.getByName(
        `${config.providers[0].id}:catalog`,
      ).getStatus()
    ).failures,
  ).toBe(0);
  const status = await env.PROXY_GROUP.getByName(
    config.proxy_groups[0].id,
  ).getStatus(await proxyGroupSnapshot(config, config.proxy_groups[0]));
  expect(status.proxies[0].failures).toBe(1);
});

test("native notes switch only before sending and never reset inference provider health", async () => {
  const config = fixture();
  const health = env.HEALTH.getByName(config.providers[0].id);
  await health.recordFailure();
  await health.recordFailure();
  const body = {
    context: { session_id: crypto.randomUUID(), current_agent_name: "/root" },
    encrypted: "opaque-ciphertext",
  };
  const writes: string[] = [];
  vi.mocked(socksFetch).mockImplementation(async (request, node, options) => {
    options?.onStage?.("proxy");
    if (node.url.includes("a.test"))
      throw new SocksProxyError("SOCKS5 connection failed");
    options?.onTunnelEstablished?.();
    options?.onStage?.("request");
    expect(request.headers.get("authorization")).toBe("Bearer upstream-secret");
    writes.push(await request.text());
    return new Response("encrypted-result", {
      headers: { "x-context-truncated": "true" },
    });
  });
  const context = createExecutionContext();
  const response = await handleContextManagement(
    request("alpha/notes/v2/thread_hint", body),
    env,
    config,
    config.api_keys[0],
    "alpha/notes/v2/thread_hint",
    "notes-request",
    undefined,
    context,
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("encrypted-result");
  expect(response.headers.get("x-context-truncated")).toBe("true");
  expect(writes).toEqual([JSON.stringify(body)]);
  await waitOnExecutionContext(context);
  expect((await health.getStatus()).failures).toBe(2);
});
