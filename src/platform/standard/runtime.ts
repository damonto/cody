import path from "node:path";
import { app } from "../../app.ts";
import { ConfigPublisherCore } from "../../control/publisher.ts";
import { ProviderHealthCore } from "../../gateway/health/provider-health.ts";
import { SessionAffinityCore } from "../../gateway/sessions/session-affinity.ts";
import { setDirectWebSocketConnector } from "../../gateway/transport/index.ts";
import { setDefaultSocksDial } from "../../gateway/transport/socks.ts";
import { runMaintenance } from "../../maintenance.ts";
import { ProviderOAuthAccountCore } from "../../providers/oauth/account.ts";
import { equalSecret } from "../../shared/equal-secret.ts";
import { UsageOutboxCore } from "../../telemetry/outbox.ts";
import type {
  Bindings,
  ConfigPublisherObject,
  HealthObject,
  OAuthAccountObject,
  ProxyGroupObject,
  SessionAffinityIndexObject,
  SessionAffinityObject,
  SqlDatabase,
  UsageOutboxObject,
} from "../bindings.ts";
import { createFilesystemAssets } from "./assets.ts";
import { connectRedis } from "./ioredis.ts";
import { ObjectRuntime, RedisObjectLocks } from "./objects.ts";
import { ProxyGroupCore } from "./proxy-group.ts";
import { PublishedConfigSnapshot } from "./published-config.ts";
import type { RedisClient } from "./redis.ts";
import { SessionAffinityIndexCore } from "./session-index.ts";
import {
  readSettings,
  type StandardSettings,
  type StandardTarget,
} from "./settings.ts";
import { nodeSocksDial } from "./socket.ts";
import { SqlObjectBackend } from "./sql-objects.ts";
import { connectDatabase } from "./sql/connect.ts";
import { applyMigrations, migrationDirectories } from "./sql/migrate.ts";
import type { PostgresOptions } from "./sql/postgres.ts";
import { TaskTracker } from "./tasks.ts";
import { DirectIngestQueue } from "./usage.ts";
import { connectUpstreamWebSocket } from "./websocket-bridge.ts";
import { installWebSocketPair } from "./websocket-pair.ts";
import { LocalWebSocketProxyNamespace } from "./websocket-proxy.ts";

export const MAINTENANCE_PATH = "/_cody/maintenance";

export interface RuntimeOptions {
  readonly target: StandardTarget;
  readonly root: string;
  readonly source?: Record<string, string | undefined>;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
  readonly onPool?: PostgresOptions["onPool"];
  /** Injected, already migrated resources for integration tests. */
  readonly resources?: {
    db: SqlDatabase;
    redis: RedisClient;
    close(): Promise<void>;
  };
}

export interface StandardRuntime {
  readonly settings: StandardSettings;
  readonly bindings: Bindings;
  readonly tasks: TaskTracker;
  fetch(request: Request): Promise<Response>;
  tick(): Promise<void>;
  maintain(): Promise<void>;
  close(): Promise<void>;
}

export async function createRuntime(
  options: RuntimeOptions,
): Promise<StandardRuntime> {
  const settings = readSettings(options.source ?? process.env, options.target);
  let resources = options.resources;
  if (!resources) {
    const db = await connectDatabase(settings.DATABASE_URL, {
      max: settings.DATABASE_POOL_SIZE,
      idleTimeoutMillis: options.target === "vercel" ? 5_000 : 30_000,
      ...(options.onPool ? { onPool: options.onPool } : {}),
    });
    try {
      if (settings.DATABASE_MIGRATE === "true")
        await applyMigrations(
          db,
          migrationDirectories(db.dialect, options.root),
        );
      const redis = await connectRedis(settings.REDIS_URL, {
        ...(options.target === "vercel" ? { idleTimeoutMs: 5_000 } : {}),
        ...(options.waitUntil ? { waitUntil: options.waitUntil } : {}),
      });
      const database = db;
      resources = {
        db,
        redis,
        close: async () => {
          await Promise.allSettled([
            Promise.resolve(database.close()),
            redis.quit(),
          ]);
        },
      };
    } catch (error) {
      await db.close();
      throw error;
    }
  }
  const { db, redis } = resources;
  const tasks = new TaskTracker(options.waitUntil);
  const objects = new ObjectRuntime({
    locks: new RedisObjectLocks(redis, settings.REDIS_PREFIX),
    tasks,
  });
  const backend = new SqlObjectBackend(db);
  const durable = { backend, alarms: true };
  // The factories run only after all namespaces have been assembled.
  const env: Bindings = {
    CONFIG_ENCRYPTION_KEY: settings.CONFIG_ENCRYPTION_KEY,
    CONFIG_KEY: settings.CONFIG_KEY,
    CONFIG_CACHE_TTL_SECONDS: settings.CONFIG_CACHE_TTL_SECONDS,
    MODELS_CACHE_TTL_SECONDS: settings.MODELS_CACHE_TTL_SECONDS,
    LOG_LEVEL: settings.LOG_LEVEL,
    ADMIN_AUTH_MODE: settings.ADMIN_AUTH_MODE,
    ADMIN_ASSETS_PUBLIC: settings.ADMIN_ASSETS_PUBLIC,
    ADMIN_SESSION_TTL_SECONDS: settings.ADMIN_SESSION_TTL_SECONDS,
    ...(settings.ADMIN_TOKEN ? { ADMIN_TOKEN: settings.ADMIN_TOKEN } : {}),
    ...(settings.ADMIN_OIDC_ISSUER
      ? { ADMIN_OIDC_ISSUER: settings.ADMIN_OIDC_ISSUER }
      : {}),
    ...(settings.ADMIN_OIDC_CLIENT_ID
      ? { ADMIN_OIDC_CLIENT_ID: settings.ADMIN_OIDC_CLIENT_ID }
      : {}),
    ...(settings.ADMIN_OIDC_CLIENT_SECRET
      ? { ADMIN_OIDC_CLIENT_SECRET: settings.ADMIN_OIDC_CLIENT_SECRET }
      : {}),
    ...(settings.ADMIN_OIDC_ALLOWED_EMAILS
      ? { ADMIN_OIDC_ALLOWED_EMAILS: settings.ADMIN_OIDC_ALLOWED_EMAILS }
      : {}),
    ...(settings.ACCESS_TEAM_DOMAIN
      ? { ACCESS_TEAM_DOMAIN: settings.ACCESS_TEAM_DOMAIN }
      : {}),
    ...(settings.ACCESS_AUD ? { ACCESS_AUD: settings.ACCESS_AUD } : {}),
    CODY_DB: db,
    CODY_CONFIG_KV: new PublishedConfigSnapshot(
      db,
      settings.CONFIG_ENCRYPTION_KEY,
      settings.CONFIG_KEY,
    ),
    USAGE_QUEUE: new DirectIngestQueue(db),
    ASSETS: createFilesystemAssets(path.join(options.root, "console", "dist")),
    HEALTH: objects.namespace(
      "health",
      (ctx) => new ProviderHealthCore(ctx, env),
      (call): HealthObject => ({
        getStatus: () => call((core) => core.getStatus()),
        recordSuccess: () => call((core) => core.recordSuccess()),
        recordFailure: () => call((core) => core.recordFailure()),
        recordImmediateFailure: () =>
          call((core) => core.recordImmediateFailure()),
        clear: () => call((core) => core.clear()),
      }),
      { backend },
    ),
    SESSION_AFFINITY: objects.namespace(
      "affinity",
      (ctx) => new SessionAffinityCore(ctx, env),
      (call): SessionAffinityObject => ({
        resolve: (...args) => call((core) => core.resolve(...args)),
        claimContextSession: (...args) =>
          call((core) => core.claimContextSession(...args)),
        releaseContextSession: (...args) =>
          call((core) => core.releaseContextSession(...args)),
        getStatus: () => call((core) => core.getStatus()),
        clear: () => call((core) => core.clear()),
        clearIfBindingId: (...args) =>
          call((core) => core.clearIfBindingId(...args)),
        clearManaged: (...args) => call((core) => core.clearManaged(...args)),
      }),
      durable,
    ),
    SESSION_AFFINITY_INDEX: objects.namespace(
      "session-index",
      (ctx) => new SessionAffinityIndexCore(ctx),
      (call): SessionAffinityIndexObject => ({
        register: (...args) => call((core) => core.register(...args)),
        get: (...args) => call((core) => core.get(...args)),
        listPage: (...args) => call((core) => core.listPage(...args)),
        remove: (...args) => call((core) => core.remove(...args)),
      }),
      { backend },
    ),
    CONFIG_PUBLISHER: objects.namespace(
      "publisher",
      (ctx) => new ConfigPublisherCore(ctx, env),
      (call): ConfigPublisherObject => ({
        getDraft: () => call((core) => core.getDraft()),
        saveDraft: (...args) => call((core) => core.saveDraft(...args)),
        publish: (...args) => call((core) => core.publish(...args)),
        rollback: (...args) => call((core) => core.rollback(...args)),
      }),
      durable,
    ),
    PROXY_GROUP: objects.namespace(
      "proxy-group",
      (ctx) => new ProxyGroupCore(ctx),
      (call): ProxyGroupObject => ({
        select: (...args) => call((core) => core.select(...args)),
        observe: (...args) => call((core) => core.observe(...args)),
        getStatus: (...args) => call((core) => core.getStatus(...args)),
        clear: (...args) => call((core) => core.clear(...args)),
      }),
      { backend },
    ),
    PROVIDER_OAUTH_ACCOUNT: objects.namespace(
      "oauth",
      (ctx) => new ProviderOAuthAccountCore(ctx, env),
      (call): OAuthAccountObject => ({
        run: (...args) => call((core) => core.run(...args)),
      }),
      durable,
    ),
    USAGE_OUTBOX: objects.namespace(
      "usage",
      (ctx) => new UsageOutboxCore(ctx, env),
      (call): UsageOutboxObject => ({
        enqueue: (...args) => call((core) => core.enqueue(...args)),
      }),
      durable,
    ),
    ...(options.target === "node"
      ? {
          RESPONSES_WEBSOCKET: new LocalWebSocketProxyNamespace(
            () => env,
            tasks,
          ),
        }
      : {}),
  };
  installWebSocketPair();
  setDefaultSocksDial(nodeSocksDial);
  setDirectWebSocketConnector(connectUpstreamWebSocket);
  let ticking: Promise<void> | undefined;
  let nextTick = 0;
  const tick = (): Promise<void> => {
    ticking ??= objects
      .runDueAlarms()
      .then(() => undefined)
      .finally(() => {
        ticking = undefined;
      });
    return ticking;
  };
  const maintain = async (): Promise<void> => {
    await tick();
    await runMaintenance(env);
  };
  return {
    settings,
    bindings: env,
    tasks,
    tick,
    maintain,
    async fetch(request) {
      if (new URL(request.url).pathname === MAINTENANCE_PATH) {
        if (request.method !== "GET")
          return new Response(null, { status: 405, headers: { allow: "GET" } });
        if (
          !settings.CRON_SECRET ||
          !(await equalSecret(
            request.headers.get("authorization") ?? "",
            `Bearer ${settings.CRON_SECRET}`,
          ))
        ) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        await maintain();
        return Response.json(
          { ok: true },
          { headers: { "cache-control": "no-store" } },
        );
      }
      if (Date.now() >= nextTick) {
        nextTick = Date.now() + 10_000;
        tasks.track(tick());
      }
      return app.fetch(request, env, tasks.executionContext());
    },
    async close() {
      await tasks.drain();
      await resources.close();
    },
  };
}
