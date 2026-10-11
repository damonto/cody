import { setTestConfiguration } from "../helpers/worker-configuration.ts";
import {
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
  type D1Migration,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { sessionAffinityIdentity } from "../../src/gateway/routing/affinity.ts";
import {
  clearConfigCacheForTests,
  parseConfig,
} from "../../src/config/store.ts";
import { gatewayApp as worker } from "../../src/gateway/app.ts";
import { clearModelsCacheForTests } from "../../src/gateway/catalog/models.ts";
import type { GatewayConfig } from "../../src/config/types.ts";

beforeAll(async () => {
  const bindings = env as Env & { TEST_MIGRATIONS: D1Migration[] };
  await applyD1Migrations(bindings.CODY_DB, bindings.TEST_MIGRATIONS);
});

function config(): GatewayConfig {
  const suffix = crypto.randomUUID();
  const providers = ["primary", "secondary"].map((name, index) => ({
    type: "ai_gateway",
    id: `${name}-${suffix}`,
    base_url: `https://${name}.example/v1`,
    credentials: [
      {
        id: "key",
        auth: { type: "api_key", api_key: `${name}-secret` },
        priority: 100,
        disabled: false,
      },
    ],
    models: ["upstream-astra"],
    priority: 100 - index,
    disabled: false,
    supports_websocket: true,
  }));
  return parseConfig({
    providers,
    api_keys: [
      {
        id: `client-${suffix}`,
        api_key: "client-secret",
        providers: providers.map(({ id }) => id),
      },
      {
        id: `other-${suffix}`,
        api_key: "other-secret",
        providers: providers.map(({ id }) => id),
      },
    ],
    model_routes: { "gpt-6-astra": { model: "upstream-astra" } },
  });
}

async function call(
  config: GatewayConfig,
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {},
  method = payload === undefined ? "GET" : "POST",
): Promise<Response> {
  clearConfigCacheForTests();
  await setTestConfiguration(
    env.CODY_DB,
    "gateway-config",
    JSON.stringify(config),
  );
  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://gateway.example${path}`, {
      method,
      headers: {
        authorization: "Bearer client-secret",
        "content-type": "application/json",
        ...headers,
      },
      ...(payload === undefined
        ? {}
        : {
            body:
              typeof payload === "string" ? payload : JSON.stringify(payload),
          }),
    }),
    env,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

function inferencePayload(sessionId: string, ingest = true) {
  return {
    model: "gpt-6-astra",
    input: [],
    client_metadata: {
      session_id: sessionId,
      "x-codex-turn-metadata": JSON.stringify({
        session_id: sessionId,
        history_ingest_requested: ingest,
        context_window_id: "window",
      }),
    },
  };
}

beforeEach(() => {
  clearConfigCacheForTests();
  clearModelsCacheForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("HTTP model switches and aliases retain independent bindings across client key rotation", async () => {
  const settings = config();
  settings.providers[1].models = ["other-model"];
  settings.model_routes = {
    "gpt-6-astra": { model: "upstream-astra" },
    alias: { model: "upstream-astra" },
  };
  const sessionId = crypto.randomUUID();
  const hosts: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      hosts.push(new URL(request.url).hostname);
      return Response.json({ output: [] });
    }),
  );
  for (const model of ["gpt-6-astra", "other-model", "alias", "gpt-6-astra"]) {
    expect(
      (
        await call(settings, "/responses", {
          ...inferencePayload(sessionId, false),
          model,
        })
      ).status,
    ).toBe(200);
  }
  expect(hosts).toEqual([
    "primary.example",
    "secondary.example",
    "primary.example",
    "primary.example",
  ]);
  settings.api_keys[0].api_key = "rotated-key";
  const response = await call(settings, "/sessions", undefined, {
    authorization: "Bearer rotated-key",
  });
  const list = await response.json<{
    data: { session_id: string; model: string }[];
  }>();
  expect(list.data.map((entry) => entry.model).sort()).toEqual([
    "alias",
    "gpt-6-astra",
    "other-model",
  ]);
  expect(list.data.every((entry) => entry.session_id === sessionId)).toBe(true);
});

test("history and notes endpoints are not exposed or forwarded", async () => {
  const settings = config();
  const upstream = vi.fn();
  vi.stubGlobal("fetch", upstream);
  for (const path of [
    "alpha/history/v2/read_item",
    "alpha/notes/v2/thread_hint",
    "alpha/notes/v2/write_file",
  ]) {
    for (const prefix of ["/", "/v1/"]) {
      expect(
        (
          await call(settings, prefix + path, {
            context: { session_id: "session", current_agent_name: "/root" },
          })
        ).status,
      ).toBe(404);
    }
  }
  expect(upstream).not.toHaveBeenCalled();
});

test("history ingestion metadata preserves the request without creating a context pin", async () => {
  const settings = config();
  const session = crypto.randomUUID();
  const bodies: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      bodies.push(await request.json());
      return Response.json({ output: [] });
    }),
  );
  const payload = inferencePayload(session);
  expect((await call(settings, "/responses", payload)).status).toBe(200);
  expect(bodies).toEqual([{ ...payload, model: "upstream-astra" }]);
  const identity = await sessionAffinityIdentity(
    settings.api_keys[0]!.id,
    session,
    "gpt-6-astra",
  );
  const stub = env.SESSION_AFFINITY.getByName(identity.object_name);
  expect(await stub.getStatus()).toBeNull();
  expect(await stub.getStatus(identity.session_digest)).toMatchObject({
    model: "gpt-6-astra",
  });
});
