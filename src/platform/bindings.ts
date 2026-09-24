/**
 * Portable runtime contract. Business code programs against these types; the
 * Cloudflare Worker passes its Wrangler bindings (which satisfy them
 * structurally) and the standard backend builds them over Redis and SQL.
 */
import type { ProviderHealthSnapshot } from "../config/types.ts";
import type {
  AffinityProviderCandidate,
  AffinitySelection,
  SessionAffinityRecord,
  SessionAffinityRegistration,
  SessionAffinityResolution,
} from "../gateway/routing/affinity.ts";
import type {
  ProxyGroupStatus,
  ProxySelection,
} from "../gateway/proxies/schema.ts";
import type { AccountCommand } from "../providers/oauth/commands.ts";
import type { AccountReply } from "../providers/oauth/schema.ts";

// ---------------------------------------------------------------------------
// Storage primitives
// ---------------------------------------------------------------------------

/** Published-configuration snapshot store (Cloudflare KV or Redis). */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export type SqlDialect = "sqlite" | "postgres";

export interface SqlRunMeta {
  readonly changes: number;
}

export interface SqlResult<T = Record<string, unknown>> {
  readonly results: T[];
  readonly meta: SqlRunMeta;
}

/** D1-shaped prepared statement; SQLite and Postgres adapters implement it. */
export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
  run<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
}

export interface SqlDatabase {
  /** Absent on D1, which is always SQLite. */
  readonly dialect?: SqlDialect;
  prepare(query: string): SqlStatement;
  /** Executes the statements atomically and returns one result per statement. */
  batch<T = Record<string, unknown>>(
    statements: SqlStatement[],
  ): Promise<SqlResult<T>[]>;
}

export function sqlDialect(db: Pick<SqlDatabase, "dialect">): SqlDialect {
  return db.dialect ?? "sqlite";
}

export interface QueueMessage<T = unknown> {
  readonly body: T;
  readonly contentType?: "json" | "text" | "bytes" | "v8";
}

/** Terminal usage-event queue (Cloudflare Queue or a direct SQL ingester). */
export interface UsageQueue<T = unknown> {
  send(body: T): Promise<unknown>;
  sendBatch(messages: Iterable<QueueMessage<T>>): Promise<unknown>;
}

/** Static console bundle (Workers Assets or a filesystem reader). */
export interface AssetFetcher {
  fetch(request: Request, init?: RequestInit): Promise<Response>;
}

// ---------------------------------------------------------------------------
// Coordination objects
// ---------------------------------------------------------------------------

export interface ObjectNamespace<T> {
  getByName(name: string): T;
}

export interface HealthObject {
  getStatus(): Promise<ProviderHealthSnapshot>;
  recordSuccess(): Promise<ProviderHealthSnapshot>;
  recordFailure(): Promise<ProviderHealthSnapshot>;
  recordImmediateFailure(): Promise<ProviderHealthSnapshot>;
  clear(): Promise<ProviderHealthSnapshot>;
}

export interface SessionAffinityResolveOptions {
  contextManagement?: boolean;
  initialProviderIds?: readonly string[];
}

export interface ClearedSessionAffinityBinding {
  binding_id: string;
  generation: number;
}

export interface SessionAffinityObject {
  resolve(
    candidates: AffinityProviderCandidate[],
    preferred: AffinitySelection | undefined,
    registration: SessionAffinityRegistration,
    options?: SessionAffinityResolveOptions,
  ): Promise<SessionAffinityResolution | undefined>;
  claimContextSession(clientId: string): Promise<boolean>;
  releaseContextSession(
    clientId: string,
  ): Promise<"released" | "missing" | "forbidden">;
  getStatus(): Promise<SessionAffinityRecord | null>;
  clear(): Promise<void>;
  clearIfBindingId(bindingId: string, generation: number): Promise<boolean>;
  clearManaged(
    registration: SessionAffinityRegistration,
  ): Promise<ClearedSessionAffinityBinding | null>;
}

export interface SessionAffinityIndexEntry {
  session_digest: string;
  session_id: string;
  binding_id: string;
  created_at: number;
  generation: number;
}

export interface SessionAffinityIndexPage {
  data: SessionAffinityIndexEntry[];
  next_cursor: string | null;
}

export interface SessionAffinityIndexObject {
  register(
    entry: SessionAffinityIndexEntry,
  ): Promise<SessionAffinityIndexEntry>;
  get(sessionDigest: string): Promise<SessionAffinityIndexEntry | null>;
  listPage(
    cursor: string | null,
    limit: number,
  ): Promise<SessionAffinityIndexPage>;
  remove(
    sessionDigest: string,
    bindingId: string,
    generation: number,
  ): Promise<boolean>;
}

export interface ProxyGroupObject {
  select(value: unknown): Promise<ProxySelection>;
  observe(value: unknown): Promise<void>;
  getStatus(value: unknown): Promise<ProxyGroupStatus>;
  clear(value: unknown, proxyId: string): Promise<boolean>;
}

export interface UsageOutboxObject {
  enqueue(event: unknown): Promise<void>;
}

export interface ConfigPublisherObject {
  getDraft(): Promise<string>;
  saveDraft(config: string, version: number, actor: string): Promise<string>;
  publish(version: number, actor: string): Promise<string>;
  rollback(revision: number, version: number, actor: string): Promise<string>;
}

export interface OAuthAccountObject {
  run(command: AccountCommand): Promise<AccountReply>;
}

export interface ObjectId {
  toString(): string;
}

export interface WebSocketProxyObject {
  fetch(request: Request): Promise<Response>;
}

export interface WebSocketProxyNamespace {
  newUniqueId(): ObjectId;
  get(id: ObjectId): WebSocketProxyObject;
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

type WorkerSettings = Pick<
  Env,
  | "CONFIG_KEY"
  | "CONFIG_CACHE_TTL_SECONDS"
  | "MODELS_CACHE_TTL_SECONDS"
  | "LOG_LEVEL"
  | "ACCESS_TEAM_DOMAIN"
  | "ACCESS_AUD"
  | "ADMIN_LOCAL_DEV"
>;

export interface Bindings extends Partial<WorkerSettings> {
  readonly CODY_CONFIG_KV: KeyValueStore;
  readonly CODY_DB: SqlDatabase;
  readonly USAGE_QUEUE: UsageQueue;
  readonly ASSETS?: AssetFetcher;
  readonly CONFIG_ENCRYPTION_KEY: Env["CONFIG_ENCRYPTION_KEY"];
  readonly HEALTH: ObjectNamespace<HealthObject>;
  readonly SESSION_AFFINITY: ObjectNamespace<SessionAffinityObject>;
  readonly SESSION_AFFINITY_INDEX: ObjectNamespace<SessionAffinityIndexObject>;
  /** Absent where inbound WebSockets are unsupported (Vercel). */
  readonly RESPONSES_WEBSOCKET?: WebSocketProxyNamespace;
  readonly USAGE_OUTBOX?: ObjectNamespace<UsageOutboxObject>;
  readonly CONFIG_PUBLISHER: ObjectNamespace<ConfigPublisherObject>;
  readonly PROXY_GROUP: ObjectNamespace<ProxyGroupObject>;
  readonly PROVIDER_OAUTH_ACCOUNT: ObjectNamespace<OAuthAccountObject>;
  /** Standard backend only: administrator authentication settings. */
  readonly ADMIN_AUTH_MODE?: string;
  readonly ADMIN_OIDC_ISSUER?: string;
  readonly ADMIN_OIDC_CLIENT_ID?: string;
  readonly ADMIN_OIDC_CLIENT_SECRET?: string;
  readonly ADMIN_OIDC_ALLOWED_EMAILS?: string;
  readonly ADMIN_SESSION_TTL_SECONDS?: string;
  readonly ADMIN_TOKEN?: string;
  /** Standard backend only: `"true"` serves the console bundle without sign-in. */
  readonly ADMIN_ASSETS_PUBLIC?: string;
}
