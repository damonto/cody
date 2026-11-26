import {
  accountReply,
  accountReadinessSchema,
} from "../../providers/oauth/schema.ts";
import {
  codexRequestMode,
  isCodexClientRequest,
} from "../../shared/codex-client.ts";
import { codexHealthProviderId } from "../../providers/codex/health-scope.ts";
import { MAX_MODEL_CATALOG_BODY_BYTES } from "../../shared/payload-limits.ts";
import {
  fetchWithConfiguredRetries,
  type UpstreamRetryOptions,
} from "../http/upstream-retry.ts";
import {
  ProviderAvailabilityReason,
  HealthFailureScope,
  HealthScope,
} from "../health/values.ts";

import { ProviderType } from "../../config/values.ts";
import { ProviderTransport } from "../../providers/transport-values.ts";
import { ApiProtocol } from "../protocol-values.ts";

import type {
  ClientApiKeyConfig,
  GatewayConfig,
  ModelRouteConfig,
  ProviderConfig,
} from "../../config/types.ts";
import {
  prepareProviderRequest,
  providerSupportsEndpoint,
} from "../../providers/index.ts";
import { OAuthError } from "../../providers/oauth/schema.ts";
import type { PreparedProviderRequest } from "../../providers/types.ts";
import {
  mapWithConcurrency,
  PROVIDER_FAN_OUT_CONCURRENCY,
} from "../../shared/concurrency.ts";
import {
  elapsedMs,
  errorMessage,
  type LogFields,
  type RequestLogContext,
} from "../../shared/log.ts";
import {
  healthFailureScope,
  recordCredentialFailure,
  recordProviderFailure,
  recordProviderSuccess,
  scheduleHealthUpdate,
  type HealthExecutionContext,
} from "../health/health.ts";
import { discardBody, readBodyWithinLimit } from "../http/body.ts";
import {
  apiError,
  jsonResponse,
  shouldStripRequestHeader,
} from "../http/http.ts";
import {
  hasJsonUpstreamError,
  upstreamErrorStatusFields,
  upstreamResponseLogFields,
} from "../http/upstream-log.ts";
import { requestProtocol } from "../protocol.ts";
import type { ProxyFailure } from "../proxies/errors.ts";
import { upstreamSecretValues } from "../routing/credentials.ts";
import {
  allowedProviderCandidates,
  modelRoutesByProvider,
  selectAvailableCatalogTargetsWithDetails,
  type ProviderTarget,
  type RoutedProvider,
} from "../routing/routing.ts";
import type { UpstreamFetch } from "../transport/index.ts";
import type { Bindings } from "../../platform/bindings.ts";
import { modelMetadata, MODEL_TEMPLATES_CACHE_IDENTITY } from "./metadata.ts";
import {
  anthropicModelInfo,
  CODEX_AUTO_REVIEW_MODEL,
  codexModelInfo,
} from "./templates.ts";
import {
  isObject,
  type JsonObject,
  parseUpstreamModels,
  type UpstreamModel,
} from "./upstream.ts";

const MODEL_CATALOG_TIMEOUT_MS = 10_000;
export const MODEL_CATALOG_CONCURRENCY = PROVIDER_FAN_OUT_CONCURRENCY;
const DEFAULT_MODELS_CACHE_TTL_SECONDS = 30;
const MAX_MODELS_CACHE_TTL_SECONDS = 300;

export type ModelsFormat = "openai" | "codex" | "anthropic";
const nativeCatalogProviders = {
  codex: ProviderType.Codex,
  anthropic: ProviderType.Claude,
};

interface ProviderModelsResult {
  provider: ProviderConfig;
  success: boolean;
  models: UpstreamModel[];
  upstream?: LogFields;
  // Always present on a failed result, possibly undefined when the error body
  // was not JSON. Success results omit it.
  upstreamError?: Promise<LogFields> | undefined;
  proxyError?: ProxyFailure | undefined;
}

interface ModelsCacheEntry {
  expiresAt: number;
  payload: JsonObject;
}

class ModelsCache {
  private readonly entries = new Map<string, ModelsCacheEntry>();

  constructor(private readonly maxEntries = 128) {}

  read(key: string, now = Date.now()): JsonObject | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.payload;
  }

  write(
    key: string,
    payload: JsonObject,
    ttlMs: number,
    now = Date.now(),
  ): void {
    if (ttlMs <= 0) {
      return;
    }
    for (const [entryKey, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(entryKey);
      }
    }
    if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (typeof oldestKey === "string") {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(key, { expiresAt: now + ttlMs, payload });
  }

  clear(): void {
    this.entries.clear();
  }
}

interface ModelsCollectionResult {
  payload: JsonObject;
  partialSuccess: boolean;
}

class ModelsRequestError extends Error {
  constructor(
    readonly status: number,
    readonly messageText: string,
    readonly type: string,
    readonly code: string,
  ) {
    super(messageText);
    this.name = "ModelsRequestError";
  }
}

const modelsCache = new ModelsCache();

function timeoutError(): Error {
  return new Error(
    `model catalog request timed out after ${MODEL_CATALOG_TIMEOUT_MS}ms`,
  );
}

async function fetchCatalogResponse(
  url: string,
  init: RequestInit,
  send: UpstreamFetch,
  timeoutMs = MODEL_CATALOG_TIMEOUT_MS,
  hooks: Pick<
    UpstreamRetryOptions,
    "recoverUnauthorized" | "observeResponse"
  > = {},
): Promise<{ response: Response; body?: unknown }> {
  const controller = new AbortController();
  const signal = init.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = (async () => {
    const result = await fetchWithConfiguredRetries(
      () => new Request(url, { ...init, signal }),
      undefined,
      { send, ...hooks, deadline: Date.now() + timeoutMs },
    );
    if (!result.response) throw result.error;
    const response = result.response;
    if (!response.ok) {
      return { response };
    }
    const rawBody = await readBodyWithinLimit(
      response.body,
      MAX_MODEL_CATALOG_BODY_BYTES,
      response.headers.get("content-length"),
      undefined,
      signal,
    );
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(rawBody)) as unknown;
    } catch {
      throw new Error("model catalog response must be valid JSON");
    }
    return {
      response,
      body,
    };
  })();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function prepareCatalogWithinDeadline(
  operation: Promise<PreparedProviderRequest>,
  signal: AbortSignal,
): Promise<PreparedProviderRequest> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    abort = () =>
      reject(signal.reason ?? new Error("Catalog request cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    timer = setTimeout(() => reject(timeoutError()), MODEL_CATALOG_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}

async function fetchProviderModels(
  request: Request,
  env: Bindings,
  config: GatewayConfig,
  target: ProviderTarget,
  requestId: string,
  context?: HealthExecutionContext,
  requestLog?: RequestLogContext,
): Promise<ProviderModelsResult> {
  const { provider, credential: key } = target;
  // /v1/models is dialect-neutral, so this resolves from the client's identity.
  // A provider may serve either dialect, so it cannot declare one.
  const protocol = requestProtocol(request, "models");
  const startedAt = performance.now();
  let prepared: PreparedProviderRequest | undefined;
  try {
    prepared = await prepareCatalogWithinDeadline(
      prepareProviderRequest(
        provider,
        key,
        {
          request,
          endpoint: "models",
          transport: ProviderTransport.Http,
          protocol,
        },
        { config, env, context, requestLog, requestId },
      ),
      request.signal,
    );
    const result = await fetchCatalogResponse(
      prepared.url,
      {
        method: prepared.method ?? "GET",
        ...(prepared.body === undefined ? {} : { body: prepared.body }),
        headers: prepared.headers,
        redirect: "manual",
        signal: request.signal,
      },
      prepared.send,
      Math.max(1, MODEL_CATALOG_TIMEOUT_MS - (performance.now() - startedAt)),
      {
        recoverUnauthorized: prepared.recoverUnauthorized,
        observeResponse: prepared.observeResponse,
      },
    );
    const durationMs = elapsedMs(startedAt);
    if (!result.response.ok) {
      const upstream = {
        provider_id: provider.id,
        credential_id: key.id,
        outcome: "http_error",
        duration_ms: durationMs,
        ...upstreamErrorStatusFields(result.response),
      };
      const upstreamError =
        requestLog && hasJsonUpstreamError(result.response)
          ? upstreamResponseLogFields(result.response, false)
          : undefined;
      if (!upstreamError) {
        await discardBody(result.response.body);
      }
      const failureScope = healthFailureScope(
        result.response.status,
        protocol,
        provider.type,
      );
      if (failureScope === HealthFailureScope.Provider) {
        await scheduleHealthUpdate(
          context,
          recordProviderFailure(
            env,
            codexHealthProviderId(provider.id, prepared?.codexMode),
            requestId,
            HealthScope.Catalog,
          ),
        );
      } else if (failureScope === HealthFailureScope.Credential) {
        await scheduleHealthUpdate(
          context,
          recordCredentialFailure(
            env,
            codexHealthProviderId(provider.id, prepared?.codexMode),
            key.id,
            requestId,
            HealthScope.Catalog,
          ),
        );
      }
      return {
        provider,
        success: false,
        models: [],
        upstream,
        upstreamError,
      };
    }
    const models = parseUpstreamModels(
      prepared.parseModels ? prepared.parseModels(result.body) : result.body,
      provider.type === ProviderType.Codex,
    );
    if (!models) {
      const upstream = {
        provider_id: provider.id,
        credential_id: key.id,
        outcome: "invalid_response",
        duration_ms: durationMs,
        ...upstreamErrorStatusFields(result.response),
      };
      await scheduleHealthUpdate(
        context,
        recordProviderFailure(
          env,
          codexHealthProviderId(provider.id, prepared?.codexMode),
          requestId,
          HealthScope.Catalog,
        ),
      );
      return { provider, success: false, models: [], upstream };
    }
    const allowedModels = new Set(provider.models);
    const filteredModels = models.filter(({ id }) => allowedModels.has(id));
    await scheduleHealthUpdate(
      context,
      recordProviderSuccess(
        env,
        codexHealthProviderId(provider.id, prepared?.codexMode),
        requestId,
        HealthScope.Catalog,
      ),
    );
    return {
      provider,
      success: true,
      models: filteredModels,
    };
  } catch (error) {
    const proxyError = prepared?.proxyFailure(error);
    const upstream = {
      provider_id: provider.id,
      credential_id: key.id,
      outcome: request.signal.aborted ? "cancelled" : "exception",
      error: errorMessage(error),
      duration_ms: elapsedMs(startedAt),
    };
    if (
      prepared &&
      !request.signal.aborted &&
      !proxyError &&
      !(error instanceof OAuthError)
    ) {
      await scheduleHealthUpdate(
        context,
        recordProviderFailure(
          env,
          codexHealthProviderId(provider.id, prepared?.codexMode),
          requestId,
          HealthScope.Catalog,
        ),
      );
    }
    return { provider, success: false, models: [], upstream, proxyError };
  }
}

function standardModel(raw: JsonObject, id: string): JsonObject {
  return {
    ...raw,
    id,
    object: typeof raw.object === "string" ? raw.object : "model",
  };
}

function indexModelAliases(
  providerId: string,
  routes: Record<string, ModelRouteConfig>,
): Map<string, string[]> {
  const aliases = new Map<string, string[]>();
  for (const [id, route] of Object.entries(routes)) {
    if (route.providers && !route.providers.includes(providerId)) continue;
    const ids = aliases.get(route.model);
    if (ids) ids.push(id);
    else aliases.set(route.model, [id]);
  }
  return aliases;
}

function aggregateClientModels<T>(
  results: ProviderModelsResult[],
  routesByProvider: Map<string, Record<string, ModelRouteConfig>>,
  render: (
    id: string,
    upstream: UpstreamModel,
    provider: ProviderType,
  ) => T | undefined,
): T[] {
  const merged = new Map<string, T>();

  for (const { provider, success, models } of results) {
    if (!success) continue;
    const routes = routesByProvider.get(provider.id) ?? {};
    const aliasesByModel = indexModelAliases(provider.id, routes);
    const allowedModels = new Set(provider.models);
    for (const upstream of models) {
      if (!allowedModels.has(upstream.id)) continue;
      const aliases = aliasesByModel.get(upstream.id) ?? [];
      const ids = Object.hasOwn(routes, upstream.id)
        ? aliases
        : [upstream.id, ...aliases];
      for (const id of ids) {
        if (merged.has(id)) continue;
        const model = render(id, upstream, provider.type);
        if (model !== undefined) merged.set(id, model);
      }
    }
  }
  return [...merged.values()];
}

export function aggregateStandardModels(
  results: ProviderModelsResult[],
  routesByProvider: Map<string, Record<string, ModelRouteConfig>>,
): JsonObject[] {
  return aggregateClientModels(results, routesByProvider, (id, upstream) => {
    if (id === CODEX_AUTO_REVIEW_MODEL) return undefined;
    const { codex: _codex, ...model } = upstream.raw;
    return standardModel(model, id);
  });
}

export function modelsFormatFor(request: Request): ModelsFormat {
  // `models` is dialect-neutral, so requestProtocol resolves it from the
  // client's own identity. The Claude user-agent rule lives there, not here.
  if (requestProtocol(request, "models") === ApiProtocol.Anthropic) {
    return "anthropic";
  }
  return isCodexClientRequest(request) ? "codex" : "openai";
}

function cacheTtlMs(env: Bindings): number {
  const raw = env.MODELS_CACHE_TTL_SECONDS;
  const rawText = typeof raw === "string" ? raw.trim() : raw;
  const configured =
    rawText === undefined || rawText === ""
      ? DEFAULT_MODELS_CACHE_TTL_SECONDS
      : Number(rawText);
  if (!Number.isFinite(configured) || configured < 0) {
    return DEFAULT_MODELS_CACHE_TTL_SECONDS * 1000;
  }
  return Math.min(configured, MAX_MODELS_CACHE_TTL_SECONDS) * 1000;
}

async function hashText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function requestHeaderVary(request: Request): string {
  const entries: string[] = [];
  request.headers.forEach((value, name) => {
    if (!shouldStripRequestHeader(name)) {
      entries.push(`${name.toLowerCase()}:${value}`);
    }
  });
  return entries.sort().join("\n");
}

async function modelsCacheKey(
  request: Request,
  config: GatewayConfig,
  client: ClientApiKeyConfig,
  format: ModelsFormat,
  oauthIdentity: string,
): Promise<string> {
  const url = new URL(request.url);
  const providerIds = [...client.providers].sort().join(",");
  const vary = [
    JSON.stringify(config),
    format,
    url.pathname === "/models" || url.pathname === "/v1/models"
      ? "models"
      : url.pathname,
    url.search,
    providerIds,
    client.id,
    requestHeaderVary(request),
    oauthIdentity,
    ...(format === "openai" ? [] : [MODEL_TEMPLATES_CACHE_IDENTITY]),
  ].join("\u0000");
  return hashText(vary);
}

export function clearModelsCacheForTests(): void {
  modelsCache.clear();
}

async function collectModels(
  request: Request,
  env: Bindings,
  config: GatewayConfig,
  client: ClientApiKeyConfig,
  configuredTargets: RoutedProvider[],
  format: ModelsFormat,
  requestId: string,
  context?: HealthExecutionContext,
  requestLog?: RequestLogContext,
): Promise<ModelsCollectionResult> {
  const selection = await selectAvailableCatalogTargetsWithDetails(
    env,
    configuredTargets,
    {
      client: isCodexClientRequest(request) ? "codex" : "other",
      endpoint: "models",
      transport: ProviderTransport.Http,
    },
  );
  const available = selection.targets;
  const routing = {
    checked_available_providers: available.map((entry) => entry.provider.id),
    selected_credentials: available.map(({ provider, credential: key }) => ({
      provider_id: provider.id,
      credential_id: key.id,
    })),
    provider_checks: selection.checks,
    credential_checks: selection.credentialChecks,
  };
  requestLog?.mergeSection("routing", routing);
  if (
    selection.checks.some(
      (entry) => entry.reason === ProviderAvailabilityReason.HealthReadFailed,
    ) ||
    selection.credentialChecks.some(
      (entry) => entry.reason === ProviderAvailabilityReason.HealthReadFailed,
    )
  ) {
    requestLog?.warn();
  }
  if (available.length === 0) {
    requestLog?.warn({ outcome: "provider_cooling_down" });
    throw new ModelsRequestError(
      503,
      "No healthy provider is currently available",
      "server_error",
      "provider_cooling_down",
    );
  }

  const results = await mapWithConcurrency(
    available,
    MODEL_CATALOG_CONCURRENCY,
    (target) =>
      fetchProviderModels(
        request,
        env,
        config,
        target,
        requestId,
        context,
        requestLog,
      ),
  );
  const upstreamErrors = results.flatMap((result) =>
    !result.success && result.upstream ? [result.upstream] : [],
  );
  if (upstreamErrors.length > 0) {
    requestLog?.mergeSection("catalog", { upstream_errors: upstreamErrors });
  }
  if (
    requestLog &&
    results.some((result) => result.upstreamError !== undefined)
  ) {
    requestLog.defer(
      (async () => {
        for (const result of results) {
          if (result.upstream && result.upstreamError) {
            const fields = await result.upstreamError;
            Object.assign(
              result.upstream,
              requestLog.limitUpstreamErrorFields(fields),
            );
          }
        }
      })(),
    );
  }
  if (!results.some((result) => result.success)) {
    const proxyError = results.every(
      (result) => result.proxyError?.status === 503,
    )
      ? results[0]?.proxyError
      : undefined;
    if (proxyError)
      throw new ModelsRequestError(
        proxyError.status,
        proxyError.message,
        "server_error",
        proxyError.code,
      );
    requestLog?.warn({ outcome: "upstream_unavailable" });
    throw new ModelsRequestError(
      502,
      "No upstream model catalog could be retrieved",
      "server_error",
      "upstream_unavailable",
    );
  }

  const routesByProvider = modelRoutesByProvider(config, client);
  const payload = modelsPayload(results, routesByProvider, format);
  return {
    payload,
    partialSuccess: upstreamErrors.length > 0,
  };
}

function modelsPayload(
  results: ProviderModelsResult[],
  routesByProvider: Map<string, Record<string, ModelRouteConfig>>,
  format: ModelsFormat,
): JsonObject {
  if (format === "openai")
    return {
      object: "list",
      data: aggregateStandardModels(results, routesByProvider),
    };

  // Append gateway entries after native entries so an alias collision keeps native metadata.
  const native = nativeCatalogProviders[format];
  const orderedResults = [
    ...results.filter(({ provider }) => provider.type === native),
    ...results.filter(
      ({ provider }) => provider.type === ProviderType.AiGateway,
    ),
  ];
  switch (format) {
    case "codex":
      return {
        models: aggregateClientModels(
          orderedResults,
          routesByProvider,
          codexCatalogEntry,
        ),
      };
    case "anthropic": {
      const data = aggregateClientModels(
        orderedResults,
        routesByProvider,
        anthropicCatalogEntry,
      );
      return {
        data,
        has_more: false,
        first_id: data[0]?.id ?? null,
        last_id: data.at(-1)?.id ?? null,
      };
    }
  }
}

function codexCatalogEntry(
  id: string,
  upstream: UpstreamModel,
  provider: ProviderType,
): JsonObject | undefined {
  if (provider === ProviderType.Codex) {
    const info = upstream.codexInfo;
    if (!info || id === upstream.id) return info;
    return { ...info, slug: id };
  }
  const metadata = modelMetadata(id, upstream.id);
  if (!metadata && !upstream.codexInfo) return undefined;
  return codexModelInfo({ id, upstream, metadata });
}

function anthropicCatalogEntry(
  id: string,
  upstream: UpstreamModel,
  provider: ProviderType,
): (JsonObject & { id: string }) | undefined {
  if (id === CODEX_AUTO_REVIEW_MODEL) return undefined;
  const { raw } = upstream;
  if (provider === ProviderType.Claude) {
    // Some Claude clients use the optional name field as the model ID.
    const name =
      id !== upstream.id && raw.name === upstream.id ? { name: id } : {};
    return { ...raw, ...name, id };
  }
  const metadata = modelMetadata(id, upstream.id);
  const hasModelInfo =
    raw.type === "model" &&
    (typeof raw.created_at === "string" ||
      raw.capabilities === null ||
      isObject(raw.capabilities));
  if (!metadata && !hasModelInfo) return undefined;
  return anthropicModelInfo({ id, upstream, metadata });
}

function isCachedModelsPayload(
  value: unknown,
  format: ModelsFormat,
): value is JsonObject {
  if (!isObject(value)) return false;
  const models = format === "codex" ? value.models : value.data;
  const identity = format === "codex" ? "slug" : "id";
  if (
    !Array.isArray(models) ||
    !models.every(
      (model: unknown) =>
        isObject(model) && typeof model[identity] === "string",
    )
  )
    return false;
  if (format === "openai") return value.object === "list";
  if (format === "anthropic")
    return (
      value.has_more === false &&
      (value.first_id === null || typeof value.first_id === "string") &&
      (value.last_id === null || typeof value.last_id === "string")
    );
  return true;
}

/** Null explicitly disables caching when coordinated authorization state is unavailable. */
async function codexCacheIdentity(
  request: Request,
  env: Bindings,
  targets: RoutedProvider[],
): Promise<string | null> {
  const accounts = targets.flatMap(({ provider, credentials }) =>
    provider.type === ProviderType.Codex
      ? credentials.flatMap((credential) =>
          credential.auth.type === "oauth"
            ? [{ provider, ref: credential.auth.account_ref }]
            : [],
        )
      : [],
  );
  const identities = await mapWithConcurrency(
    accounts,
    PROVIDER_FAN_OUT_CONCURRENCY,
    async ({ provider, ref }) => {
      const mode = codexRequestMode(request, provider.use_siwc);
      try {
        const readiness = await accountReply(
          env.PROVIDER_OAUTH_ACCOUNT.getByName(ref).run({
            action: "readiness",
            mode,
          }),
          accountReadinessSchema,
        );
        if (readiness.codex_mode !== mode || readiness.generation === undefined)
          return null;
        return [ref, mode, readiness.generation, readiness.ready];
      } catch {
        // A failed coordinated read must never be hidden by a previous cache hit.
        return null;
      }
    },
  );
  if (identities.some((identity) => identity === null)) return null;
  return JSON.stringify(identities);
}

export async function handleModels(
  request: Request,
  env: Bindings,
  config: GatewayConfig,
  client: ClientApiKeyConfig,
  requestId = "unknown",
  context?: HealthExecutionContext,
  requestLog?: RequestLogContext,
): Promise<Response> {
  const format = modelsFormatFor(request);
  const nativeProvider =
    format === "openai" ? undefined : nativeCatalogProviders[format];
  const configuredTargets = allowedProviderCandidates(config, client).filter(
    ({ provider }) =>
      (nativeProvider === undefined ||
        provider.type === nativeProvider ||
        provider.type === ProviderType.AiGateway) &&
      providerSupportsEndpoint(provider, "models"),
  );
  requestLog?.registerSensitiveValues([
    client.api_key,
    ...upstreamSecretValues(config),
  ]);
  const ttlMs = cacheTtlMs(env);
  const oauthIdentity =
    ttlMs > 0
      ? await codexCacheIdentity(request, env, configuredTargets)
      : null;
  const cacheEnabled = oauthIdentity !== null;
  requestLog?.set({
    routing: {
      candidate_providers: configuredTargets.map(({ provider }) => provider.id),
    },
  });
  requestLog?.mergeSection("catalog", {
    response_format: format,
    cache_enabled: cacheEnabled,
  });
  const cacheKey = await modelsCacheKey(
    request,
    config,
    client,
    format,
    oauthIdentity ?? "",
  );

  const cachedPayload = cacheEnabled ? modelsCache.read(cacheKey) : undefined;
  if (cachedPayload) {
    requestLog?.mergeSection("catalog", { cache: "hit" });
    return jsonResponse(cachedPayload);
  }

  if (cacheEnabled && env.MODELS_CACHE) {
    try {
      const raw = await env.MODELS_CACHE.get(cacheKey);
      const cached: unknown = raw === null ? null : JSON.parse(raw);
      const now = Date.now();
      if (
        isObject(cached) &&
        typeof cached.expires_at === "number" &&
        Number.isSafeInteger(cached.expires_at) &&
        cached.expires_at > now &&
        cached.expires_at <= now + MAX_MODELS_CACHE_TTL_SECONDS * 1000 &&
        isCachedModelsPayload(cached.payload, format)
      ) {
        modelsCache.write(
          cacheKey,
          cached.payload,
          Math.min(ttlMs, cached.expires_at - now),
          now,
        );
        requestLog?.mergeSection("catalog", { cache: "shared_hit" });
        return jsonResponse(cached.payload);
      }
    } catch {
      // Model results are disposable. Coordination still uses its normal
      // failure policy when rebuilding a missing or unavailable cache.
      requestLog?.mergeSection("catalog", { shared_cache: "unavailable" });
    }
  }

  requestLog?.mergeSection("catalog", {
    cache: cacheEnabled ? "miss" : "bypass",
  });

  try {
    const result = await collectModels(
      request,
      env,
      config,
      client,
      configuredTargets,
      format,
      requestId,
      context,
      requestLog,
    );
    if (result.partialSuccess) {
      requestLog?.warn({ outcome: "partial_success" });
    }
    const now = Date.now();
    if (cacheEnabled) modelsCache.write(cacheKey, result.payload, ttlMs, now);
    if (cacheEnabled && env.MODELS_CACHE) {
      try {
        await env.MODELS_CACHE.put(
          cacheKey,
          JSON.stringify({
            expires_at: now + ttlMs,
            payload: result.payload,
          }),
          ttlMs,
        );
      } catch {
        requestLog?.mergeSection("catalog", { shared_cache: "unavailable" });
      }
    }
    return jsonResponse(result.payload);
  } catch (error) {
    if (error instanceof ModelsRequestError) {
      requestLog?.warn({
        outcome: error.code,
        error: error.messageText,
      });
      return apiError(
        requestProtocol(request),
        error.status,
        error.messageText,
        { type: error.type, code: error.code, requestId },
      );
    }
    throw error;
  }
}
