import {
  createExecutionContext,
  evictDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { sessionAffinityIdentity } from "../../src/affinity.ts";
import { clearConfigCacheForTests, parseConfig } from "../../src/config.ts";
import { MAX_CONTEXT_MANAGEMENT_BODY_BYTES } from "../../src/context-management.ts";
import {
  getServiceAvailability,
  recordServiceFailure,
} from "../../src/health.ts";
import worker from "../../src/index.ts";
import { clearModelsCacheForTests } from "../../src/models.ts";
import { CONTEXT_MANAGEMENT_PATHS } from "../../src/protocol.ts";
import type { GatewayConfig } from "../../src/types.ts";

function config(): GatewayConfig {
  const suffix = crypto.randomUUID();
  const services = ["primary", "secondary"].map((name, index) => ({
    id: `${name}-${suffix}`,
    base_url: `https://${name}.example/v1`,
    keys: [
      { id: "key", api_key: `${name}-secret`, priority: 100, disabled: false },
    ],
    models: ["upstream-astra"],
    priority: 100 - index,
    disabled: false,
    supports_websocket: true,
    supports_context_management: true,
  }));
  return parseConfig({
    services,
    api_keys: [
      {
        id: `client-${suffix}`,
        api_key: "client-secret",
        services: services.map(({ id }) => id),
      },
      {
        id: `other-${suffix}`,
        api_key: "other-secret",
        services: services.map(({ id }) => id),
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
  await env.CODY_CONFIG_KV.put("gateway-config", JSON.stringify(config));
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

function toolPayload(sessionId: string) {
  return { context: { session_id: sessionId, current_agent_name: "/root" } };
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

test("all native endpoints preserve bodies, query strings, encryption headers and responses", async () => {
  const settings = config();
  const session = crypto.randomUUID();
  const body = ` { "context": {"session_id":"${session}","current_agent_name":"/root"}, "text":"ciphertext", "future":true } `;
  const result =
    ' { "encrypted_output":"opaque", "images":[{"mime_type":"image/png","data":"opaque-image"}] } ';
  const captured: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      captured.push(request);
      return new Response(result, {
        status: 207,
        headers: {
          "content-type": "application/json",
          "x-upstream": "retained",
        },
      });
    }),
  );
  for (const prefix of ["/", "/v1/"]) {
    for (const path of CONTEXT_MANAGEMENT_PATHS) {
      const response = await call(
        settings,
        `${prefix}${path}?trace=a%2Fb`,
        body,
        {
          "x-api-key": "client-secret",
          "x-forwarded-for": "192.0.2.1",
          "x-openai-encrypted-tool-arguments": "true",
          "x-openai-tool-output-truncation-policy":
            '{"mode":"bytes","limit":4000}',
          "session-id": session,
        },
      );
      expect(response.status).toBe(207);
      expect(await response.text()).toBe(result);
      expect(response.headers.get("x-upstream")).toBe("retained");
      const request = captured.at(-1)!;
      expect(request.url).toBe(
        `https://primary.example/v1/${path}?trace=a%2Fb`,
      );
      expect(await request.text()).toBe(body);
      expect(request.headers.get("authorization")).toBe(
        "Bearer primary-secret",
      );
      expect(request.headers.has("x-api-key")).toBe(false);
      expect(request.headers.has("x-forwarded-for")).toBe(false);
      expect(request.headers.get("x-openai-encrypted-tool-arguments")).toBe(
        "true",
      );
      expect(
        request.headers.get("x-openai-tool-output-truncation-policy"),
      ).toBe('{"mode":"bytes","limit":4000}');
    }
  }
});

test("native endpoints enforce opt-in, authentication, methods and the path whitelist", async () => {
  const settings = config();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const path = "/v1/alpha/notes/v2/thread_hint";
  const body = toolPayload(crypto.randomUUID());
  expect(
    (await call(settings, path, body, { authorization: "Bearer unknown" }))
      .status,
  ).toBe(401);
  expect((await call(settings, path)).status).toBe(405);
  expect(
    (await call(settings, "/alpha/notes/v2/delete_file", body)).status,
  ).toBe(404);
  settings.services.forEach((service) => {
    service.supports_context_management = false;
  });
  expect((await call(settings, path, body)).status).toBe(404);
  expect(fetch).not.toHaveBeenCalled();
});

test("invalid identities and oversized native bodies are rejected before contacting upstream", async () => {
  const settings = config();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const path = "/alpha/notes/v2/write_file";
  for (const body of [
    "not-json",
    "null",
    "{}",
    { context: { session_id: "id" } },
  ]) {
    expect((await call(settings, path, body)).status).toBe(400);
  }
  expect(
    (await call(settings, path, toolPayload("one"), { "session-id": "two" }))
      .status,
  ).toBe(400);
  expect(
    (
      await call(settings, path, {
        ...toolPayload("large"),
        text: "x".repeat(MAX_CONTEXT_MANAGEMENT_BODY_BYTES),
      })
    ).status,
  ).toBe(413);
  expect(fetch).not.toHaveBeenCalled();
});

test("a first thread hint pins subsequent inference and notes across priority changes and eviction", async () => {
  const settings = config();
  settings.services[0].supports_context_management = false;
  const session = crypto.randomUUID();
  const captured: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      captured.push(request);
      return Response.json({ text: "checkpoint" });
    }),
  );
  expect(
    (await call(settings, "/alpha/notes/v2/thread_hint", toolPayload(session)))
      .status,
  ).toBe(200);
  const identity = await sessionAffinityIdentity(
    settings.api_keys[0].id,
    session,
  );
  const stub = env.SESSION_AFFINITY.getByName(identity.object_name);
  const original = await stub.getStatus();
  expect(original).toMatchObject({
    service_id: settings.services[1].id,
    context_management: true,
  });
  await evictDurableObject(stub);
  settings.services[0].supports_context_management = true;
  settings.services[1].keys.push({
    id: "new-key",
    api_key: "new-secret",
    priority: 200,
    disabled: false,
  });
  const payload = inferencePayload(session);
  const canonicalPayload = {
    ...payload,
    client_metadata: {
      "x-codex-turn-metadata": payload.client_metadata["x-codex-turn-metadata"],
    },
  };
  expect((await call(settings, "/v1/responses", canonicalPayload)).status).toBe(
    200,
  );
  expect(
    (await call(settings, "/v1/responses", inferencePayload(session, false)))
      .status,
  ).toBe(200);
  expect(
    (await call(settings, "/alpha/history/v2/read_item", toolPayload(session)))
      .status,
  ).toBe(200);
  expect(captured.map((request) => new URL(request.url).hostname)).toEqual(
    Array(4).fill("secondary.example"),
  );
  expect(
    captured.map((request) => request.headers.get("authorization")),
  ).toEqual(Array(4).fill("Bearer secondary-secret"));
  expect(await captured[1].json()).toMatchObject({
    model: "upstream-astra",
    client_metadata: canonicalPayload.client_metadata,
  });
  expect((await stub.getStatus())?.binding_id).toBe(original?.binding_id);
});

test("ordinary sessions retain their binding when enabling context management after credential rotation", async () => {
  const settings = config();
  for (const service of settings.services) {
    service.supports_context_management = false;
  }
  const session = crypto.randomUUID();
  const hosts: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      hosts.push(new URL(request.url).hostname);
      return Response.json({ output: [] });
    }),
  );
  expect(
    (await call(settings, "/responses", inferencePayload(session, false)))
      .status,
  ).toBe(200);
  const identity = await sessionAffinityIdentity(
    settings.api_keys[0].id,
    session,
  );
  const affinity = env.SESSION_AFFINITY.getByName(identity.object_name);
  const original = await affinity.getStatus();

  settings.api_keys[0].api_key = "rotated-client-secret";
  for (const service of settings.services) {
    service.supports_context_management = true;
  }
  settings.services[1].priority = 200;
  expect(
    (
      await call(
        settings,
        "/alpha/notes/v2/thread_hint",
        toolPayload(session),
        {
          authorization: "Bearer rotated-client-secret",
        },
      )
    ).status,
  ).toBe(200);
  expect(await affinity.getStatus()).toMatchObject({
    binding_id: original?.binding_id,
    context_management: true,
  });
  expect(hosts).toEqual(["primary.example", "primary.example"]);
});

test("disabled bound keys or capabilities never switch a context session to another target", async () => {
  const settings = config();
  const session = crypto.randomUUID();
  const fetch = vi.fn(async () => Response.json({ text: "ok" }));
  vi.stubGlobal("fetch", fetch);
  await call(settings, "/responses", inferencePayload(session));
  settings.services[0].keys[0].disabled = true;
  expect(
    (await call(settings, "/alpha/notes/v2/read_file", toolPayload(session)))
      .status,
  ).toBe(503);
  expect(
    (await call(settings, "/responses", inferencePayload(session))).status,
  ).toBe(503);
  settings.services[0].keys[0].disabled = false;
  settings.services[0].supports_context_management = false;
  expect(
    (await call(settings, "/responses", inferencePayload(session))).status,
  ).toBe(503);
  expect(fetch).toHaveBeenCalledTimes(1);
  settings.services[0].supports_context_management = true;
  expect(
    (await call(settings, "/alpha/notes/v2/read_file", toolPayload(session)))
      .status,
  ).toBe(200);
});

test("capability removal cannot bypass an existing context binding through ordinary inference", async () => {
  const settings = config();
  const session = crypto.randomUUID();
  const fetch = vi.fn(async () => Response.json({ output: [] }));
  vi.stubGlobal("fetch", fetch);
  expect(
    (await call(settings, "/responses", inferencePayload(session))).status,
  ).toBe(200);

  for (const service of settings.services) {
    service.supports_context_management = false;
  }
  const revoked = await call(
    settings,
    "/responses",
    inferencePayload(session, false),
  );
  expect(revoked.status).toBe(503);
  expect(await revoked.json()).toMatchObject({
    error: { code: "context_session_unavailable" },
  });

  settings.services[0].supports_context_management = true;
  settings.model_routes["gpt-6-astra"].services = [settings.services[1].id];
  expect(
    (await call(settings, "/responses", inferencePayload(session, false)))
      .status,
  ).toBe(503);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("context requests fail closed when the affinity store is unavailable", async () => {
  const settings = config();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(env.SESSION_AFFINITY, "getByName").mockImplementation(() => {
    throw new Error("unavailable");
  });
  expect(
    (
      await call(
        settings,
        "/alpha/notes/v2/thread_hint",
        toolPayload(crypto.randomUUID()),
      )
    ).status,
  ).toBe(503);
  expect(
    (await call(settings, "/responses", inferencePayload(crypto.randomUUID())))
      .status,
  ).toBe(503);
  expect(fetch).not.toHaveBeenCalled();
});

test("native bootstrap honors Astra route restrictions before selecting a service", async () => {
  const settings = config();
  settings.model_routes["gpt-6-astra"].services = [settings.services[1].id];
  const session = crypto.randomUUID();
  const hosts: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      hosts.push(new URL(request.url).hostname);
      return Response.json({ text: "ok" });
    }),
  );
  expect(
    (await call(settings, "/alpha/notes/v2/thread_hint", toolPayload(session)))
      .status,
  ).toBe(200);
  expect(
    (await call(settings, "/responses", inferencePayload(session))).status,
  ).toBe(200);
  expect(hosts).toEqual(["secondary.example", "secondary.example"]);
});

test("context inference rejects conflicting wire identities and requires a session", async () => {
  const settings = config();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const payload = inferencePayload(crypto.randomUUID());
  expect(
    (await call(settings, "/responses", payload, { "session-id": "different" }))
      .status,
  ).toBe(400);
  payload.client_metadata["x-codex-turn-metadata"] = JSON.stringify({
    history_ingest_requested: true,
    session_id: "different",
  });
  expect((await call(settings, "/responses", payload)).status).toBe(400);
  expect(
    (
      await call(settings, "/responses", {
        model: "gpt-6-astra",
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({
            history_ingest_requested: true,
          }),
        },
      })
    ).status,
  ).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});

test("native calls never replay writes or alter inference failure streaks", async () => {
  const settings = config();
  settings.services[0].retry = { status_codes: [503], delays_ms: [0, 0] };
  const session = crypto.randomUUID();
  await recordServiceFailure(env, settings.services[0].id, "seed");
  const before = await getServiceAvailability(env, settings.services[0].id);
  const fetch = vi.fn(
    async () => new Response("upstream error", { status: 503 }),
  );
  vi.stubGlobal("fetch", fetch);
  expect(
    (
      await call(
        settings,
        "/alpha/notes/v2/append_to_file",
        toolPayload(session),
      )
    ).status,
  ).toBe(503);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await getServiceAvailability(env, settings.services[0].id)).toEqual(
    before,
  );
  fetch.mockImplementation(async () => new Response("ok"));
  await call(settings, "/alpha/notes/v2/read_file", toolPayload(session));
  expect(await getServiceAvailability(env, settings.services[0].id)).toEqual(
    before,
  );
});

test("a shared upstream session cannot be accessed by another gateway client", async () => {
  const settings = config();
  const session = crypto.randomUUID();
  const fetch = vi.fn(async () => Response.json({ text: "private" }));
  vi.stubGlobal("fetch", fetch);
  await call(settings, "/alpha/notes/v2/write_file", toolPayload(session));
  const other = { authorization: "Bearer other-secret" };
  expect(
    (
      await call(
        settings,
        "/alpha/history/v2/read_item",
        toolPayload(session),
        other,
      )
    ).status,
  ).toBe(403);
  expect(
    (await call(settings, "/responses", inferencePayload(session), other))
      .status,
  ).toBe(403);
  expect(fetch).toHaveBeenCalledTimes(1);
  settings.api_keys[0].api_key = "rotated-secret";
  expect(
    (
      await call(settings, "/alpha/notes/v2/read_file", toolPayload(session), {
        authorization: "Bearer rotated-secret",
      })
    ).status,
  ).toBe(200);
});

test("context bindings use the stable client id across credential rotation", async () => {
  const settings = config();
  const session = crypto.randomUUID();
  const hosts: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      hosts.push(new URL(request.url).hostname);
      return Response.json({ text: "ok" });
    }),
  );
  settings.services[0].supports_context_management = false;
  expect(
    (await call(settings, "/alpha/notes/v2/thread_hint", toolPayload(session)))
      .status,
  ).toBe(200);
  settings.services[0].supports_context_management = true;
  settings.api_keys[0].api_key = "rotated-client-secret";
  expect(
    (
      await call(
        settings,
        "/alpha/history/v2/read_item",
        toolPayload(session),
        {
          authorization: "Bearer rotated-client-secret",
        },
      )
    ).status,
  ).toBe(200);
  expect(hosts).toEqual(["secondary.example", "secondary.example"]);
});

test("session management lists and clears native context sessions across credential rotation", async () => {
  const settings = config();
  const session = crypto.randomUUID();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ text: "ok" })),
  );
  expect(
    (await call(settings, "/alpha/notes/v2/thread_hint", toolPayload(session)))
      .status,
  ).toBe(200);

  settings.api_keys[0].api_key = "rotated-client-secret";
  const listed = await call(settings, "/v1/sessions", undefined, {
    authorization: "Bearer rotated-client-secret",
  });
  expect(await listed.json()).toMatchObject({
    object: "list",
    data: [expect.objectContaining({ session_id: session })],
    next_cursor: null,
  });

  const cleared = await call(
    settings,
    "/sessions",
    undefined,
    { authorization: "Bearer rotated-client-secret" },
    "DELETE",
  );
  expect(await cleared.json()).toEqual({ deleted: 1 });
  const empty = await call(settings, "/sessions", undefined, {
    authorization: "Bearer rotated-client-secret",
  });
  expect(await empty.json()).toMatchObject({ data: [] });
});

test("ownership release is explicit, owner-only and survives client key rotation", async () => {
  const settings = config();
  const session = crypto.randomUUID();
  const fetch = vi.fn(async () => Response.json({ text: "ok" }));
  vi.stubGlobal("fetch", fetch);
  expect(
    (await call(settings, "/alpha/notes/v2/thread_hint", toolPayload(session)))
      .status,
  ).toBe(200);
  const releasePath = `/sessions/${session}?release_context_ownership=true`;
  const other = { authorization: "Bearer other-secret" };
  expect(
    (await call(settings, releasePath, undefined, other, "DELETE")).status,
  ).toBe(403);
  const clear = await call(
    settings,
    `/sessions/${session}`,
    undefined,
    {},
    "DELETE",
  );
  expect(await clear.json()).toEqual({ session_id: session, deleted: 1 });
  expect(
    (
      await call(
        settings,
        "/alpha/notes/v2/read_file",
        toolPayload(session),
        other,
      )
    ).status,
  ).toBe(403);

  settings.api_keys[0].api_key = "rotated-client-secret";
  const rotated = { authorization: "Bearer rotated-client-secret" };
  const released = await call(
    settings,
    releasePath,
    undefined,
    rotated,
    "DELETE",
  );
  expect(await released.json()).toEqual({
    session_id: session,
    deleted: 0,
    ownership_released: true,
  });
  const repeated = await call(
    settings,
    releasePath,
    undefined,
    rotated,
    "DELETE",
  );
  expect(await repeated.json()).toEqual({
    session_id: session,
    deleted: 0,
    ownership_released: false,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(
    (
      await call(
        settings,
        "/alpha/notes/v2/thread_hint",
        toolPayload(session),
        other,
      )
    ).status,
  ).toBe(200);
});

test("ownership release rejects ambiguous query values and bulk release", async () => {
  const settings = config();
  const affinity = vi.spyOn(env.SESSION_AFFINITY, "getByName");
  for (const path of [
    "/sessions?release_context_ownership=true",
    "/sessions/example?release_context_ownership=",
    "/sessions/example?release_context_ownership=yes",
    "/sessions/example?release_context_ownership=true&release_context_ownership=false",
    "/sessions/example?release_context_ownership=false&release_context_ownership=true",
    "/sessions/example?release_context_ownership=true&release_context_ownership=true",
    "/sessions/example?release_context_ownership=false&release_context_ownership=false",
  ]) {
    const response = await call(settings, path, undefined, {}, "DELETE");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_session_release_query" },
    });
  }
  expect(affinity).not.toHaveBeenCalled();
});

test("requests without a session bypass affinity but session requests fail closed", async () => {
  const settings = config();
  for (const service of settings.services) {
    service.supports_context_management = false;
  }
  const fetch = vi.fn(async () => Response.json({ output: [] }));
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(env.SESSION_AFFINITY, "getByName").mockImplementation(() => {
    throw new Error("affinity unavailable");
  });
  expect(
    (await call(settings, "/responses", { model: "gpt-6-astra", input: [] }))
      .status,
  ).toBe(200);
  const unavailable = await call(settings, "/responses", {
    model: "gpt-6-astra",
    input: [],
    client_metadata: { session_id: crypto.randomUUID() },
  });
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toMatchObject({
    error: { code: "session_affinity_unavailable" },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("conflicting context identities are rejected before creating a binding", async () => {
  const settings = config();
  const bodySession = crypto.randomUUID();
  const headerSession = crypto.randomUUID();
  vi.stubGlobal("fetch", vi.fn());
  expect(
    (
      await call(settings, "/responses", inferencePayload(bodySession), {
        "session-id": headerSession,
      })
    ).status,
  ).toBe(400);
  const identity = await sessionAffinityIdentity(
    settings.api_keys[0].id,
    bodySession,
  );
  expect(
    await env.SESSION_AFFINITY.getByName(identity.object_name).getStatus(),
  ).toBeNull();
});

test("astra catalog defaults follow accessible capable model routes without changing other clients", async () => {
  const settings = config();
  settings.api_keys[1].services = [settings.services[1].id];
  settings.services[1].supports_context_management = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ data: [{ id: "upstream-astra" }] })),
  );
  const enabled = await call(settings, "/v1/models", undefined, {
    "user-agent": "codex",
  });
  const enabledBody = await enabled.json<{
    models: {
      supports_experimental_context: boolean;
      model_messages: {
        token_budget: {
          enabled: boolean;
          use_history_notes_extension: boolean;
        };
      };
    }[];
  }>();
  expect(enabledBody.models[0].supports_experimental_context).toBe(true);
  expect(enabledBody.models[0].model_messages.token_budget).toMatchObject({
    enabled: true,
    use_history_notes_extension: true,
  });
  const disabled = await call(settings, "/v1/models", undefined, {
    "user-agent": "codex",
    authorization: "Bearer other-secret",
  });
  const disabledBody = await disabled.json<typeof enabledBody>();
  expect(disabledBody.models[0].supports_experimental_context).toBe(false);
  expect(disabledBody.models[0].model_messages.token_budget).toMatchObject({
    enabled: false,
    use_history_notes_extension: false,
  });
  settings.model_routes["gpt-6-astra"].services = [settings.services[1].id];
  const restricted = await call(settings, "/v1/models", undefined, {
    "user-agent": "codex",
  });
  const restrictedBody = await restricted.json<typeof enabledBody>();
  expect(restrictedBody.models[0].supports_experimental_context).toBe(false);
  expect(restrictedBody.models[0].model_messages.token_budget.enabled).toBe(
    false,
  );
});
