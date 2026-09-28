import {
  OAuthAccountViewStatus,
  OAuthFlow,
  OAuthSessionStatus,
  OAuthAccountStatus,
} from "./values.ts";
import { ProviderType, CredentialAuthType } from "../../config/values.ts";

import { z } from "zod";
import { configurationSchema } from "../../config/schema.ts";
import { decryptConfig, encryptConfig } from "../../control/crypto.ts";
import { equalSecret } from "../../shared/equal-secret.ts";
import { configureLogging, logWarn } from "../../shared/log.ts";
import {
  ANTIGRAVITY_REDIRECT_URI,
  AntigravityClient,
  authorizationUrl as antigravityAuthorizationUrl,
  defaultTier,
  object,
  parseModels as parseAntigravityModels,
  parseQuota,
  parseSubscription,
  projectId,
} from "../antigravity/api.ts";
import {
  CODEX_DEVICE_REDIRECT_URI,
  CODEX_DEVICE_TTL_MS,
  CODEX_REDIRECT_URI,
  CODEX_VERIFICATION_URI,
  CodexClient,
  authorizationUrl as codexAuthorizationUrl,
  parseIdToken,
  parseModels as parseCodexModels,
  parseResetCredits,
  parseUsage,
} from "../codex/api.ts";
import type { UpstreamFetch } from "../../gateway/transport/index.ts";
import {
  providerConnection,
  providerOutbound,
  publishedProxyConfiguration,
} from "../outbound.ts";
import { accountCommandSchema, type AccountCommand } from "./commands.ts";
import {
  OAuthError,
  accountViewSchema,
  connectionSchema,
  identitySchema,
  oauthProviderTypeSchema,
  quotaSnapshotSchema,
  sessionStatusSchema,
  tokenSchema,
  type AccountReply,
  type AccountView,
  type ConsumeResetResult,
  type OAuthProviderType,
  type ProviderConnection,
  type ProxyConfiguration,
  type QuotaSnapshot,
  type SessionView,
} from "./schema.ts";
import { sqlDialect, type Bindings } from "../../platform/bindings.ts";
import { insertIgnore } from "../../platform/sql-dialect.ts";
import type { ObjectContext } from "../../platform/object-context.ts";

const SESSION_TTL_MS = 10 * 60_000;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const QUOTA_CACHE_TTL_MS = 60_000;
type AccountEnv = Pick<
  Bindings,
  | "CODY_DB"
  | "CODY_CONFIG_KV"
  | "LOG_LEVEL"
  | "CONFIG_KEY"
  | "CONFIG_ENCRYPTION_KEY"
  | "PROXY_GROUP"
>;
type RefreshKind = "token" | "models" | "quota";
interface PendingRefresh {
  readonly generation: number;
  readonly result: Promise<void>;
}

const sessionSchema = z.object({
  id: z.uuid(),
  actor: z.string(),
  status: sessionStatusSchema,
  state: z.string(),
  verifier: z.string(),
  challenge: z.string(),
  expires_at: z.number(),
  connection: connectionSchema,
  error: z.string().nullable(),
  tokens: tokenSchema.nullable(),
  identity: identitySchema.nullable(),
  stage: z.enum(["identity", "project", "onboard"]),
  tier: z.string(),
  attempts: z.number(),
  next_at: z.number(),
  flow: z.enum(OAuthFlow).default(OAuthFlow.Pkce),
  // Device authorization polls the issuer from the alarm until approval.
  device_auth_id: z.string().nullable().default(null),
  user_code: z.string().nullable().default(null),
  poll_interval_ms: z.number().default(5000),
});
const storedSchema = z.object({
  account_ref: z.uuid(),
  provider_id: z.string(),
  provider_type: oauthProviderTypeSchema.default(ProviderType.Antigravity),
  generation: z.number(),
  status: z.enum(OAuthAccountStatus),
  connection: connectionSchema,
  tokens: tokenSchema.nullable(),
  identity: identitySchema.nullable(),
  project_id: z.string().nullable(),
  codex: accountViewSchema.shape.codex,
  error: z.string().nullable(),
  session: sessionSchema.nullable(),
  models: accountViewSchema.shape.models,
  models_updated_at: z.number().nullable(),
  models_error: z.string().nullable(),
  quota: quotaSnapshotSchema,
});
type Stored = z.output<typeof storedSchema>;
type Session = z.output<typeof sessionSchema>;
const terminalSessionStatuses: ReadonlySet<OAuthSessionStatus> = new Set([
  OAuthSessionStatus.Complete,
  OAuthSessionStatus.Cancelled,
  OAuthSessionStatus.Expired,
]);

const emptyQuota = (): Stored["quota"] => ({
  groups: [],
  subscription: null,
  updated_at: null,
  last_error: null,
  stale: true,
});
const devicePending = (session: Session): boolean =>
  session.flow === OAuthFlow.Device &&
  session.status === OAuthSessionStatus.Pending;
function safeError(error: unknown): string {
  return error instanceof OAuthError
    ? error.message
    : "The account operation failed; check the selected proxy and try again";
}
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
/** One account owns its token lifecycle. Inference streams never pass through this object. */
export class ProviderOAuthAccountCore {
  private account: Stored | null = null;
  private mutations: Promise<unknown> = Promise.resolve();
  private readonly refreshes = new Map<RefreshKind, PendingRefresh>();
  constructor(
    protected readonly ctx: ObjectContext,
    protected readonly env: AccountEnv,
  ) {
    void this.ctx.blockConcurrencyWhile(async () => {
      const encrypted = await this.ctx.storage.get<string>("account");
      if (encrypted)
        this.account = storedSchema.parse(
          await decryptConfig(encrypted, this.env.CONFIG_ENCRYPTION_KEY),
        );
    });
  }
  private requireAccount(): Stored {
    if (!this.account) throw new OAuthError("Account does not exist", 404);
    return this.account;
  }
  private change(update: (previous: Stored | null) => Stored): Promise<void> {
    const operation = this.mutations.then(async () => {
      configureLogging(this.env.LOG_LEVEL);
      const next = update(this.account ? structuredClone(this.account) : null);
      const encrypted = await encryptConfig(
        next,
        this.env.CONFIG_ENCRYPTION_KEY,
      );
      const session = next.session;
      const alarm =
        session && !terminalSessionStatuses.has(session.status)
          ? Math.min(
              session.expires_at,
              session.status === OAuthSessionStatus.Initializing ||
                devicePending(session)
                ? session.next_at
                : session.expires_at,
            )
          : null;
      await this.ctx.storage.transaction(async (tx) => {
        await tx.put("account", encrypted);
        if (alarm !== null) await tx.setAlarm(Math.max(Date.now() + 1, alarm));
        else await tx.deleteAlarm();
      });
      this.account = next;
    });
    this.mutations = operation.catch(() => {});
    return operation;
  }
  private async updateGeneration(
    generation: number,
    update: (account: Stored) => void,
  ): Promise<void> {
    await this.change((account) => {
      if (!account || account.generation !== generation)
        throw new OAuthError(
          "Account changed during the operation; try again",
          409,
          "account_changed",
        );
      update(account);
      return account;
    });
  }
  private shareRefresh(
    kind: RefreshKind,
    generation: number,
    run: () => Promise<void>,
  ): Promise<void> {
    const pending = this.refreshes.get(kind);
    if (pending?.generation === generation) return pending.result;
    const result = Promise.resolve()
      .then(run)
      .finally(() => {
        // A late operation must not clear the replacement generation's flight.
        if (this.refreshes.get(kind)?.result === result)
          this.refreshes.delete(kind);
      });
    this.refreshes.set(kind, { generation, result });
    // The caller reports errors; persistence must finish even if it disconnects.
    this.ctx.waitUntil(result.catch(() => {}));
    return result;
  }
  private view(): AccountView {
    const account = this.requireAccount();
    const session = account.session;
    const status =
      account.status === OAuthAccountStatus.Disconnected && session
        ? session.status === OAuthSessionStatus.Initializing
          ? OAuthAccountViewStatus.Initializing
          : session.status === OAuthSessionStatus.Pending ||
              session.status === OAuthSessionStatus.Exchanging
            ? OAuthAccountViewStatus.Authorizing
            : account.status
        : account.status;
    return {
      account_ref: account.account_ref,
      provider_id: account.provider_id,
      status,
      email: account.identity?.email ?? null,
      project_id: account.project_id,
      codex: account.codex,
      expires_at: account.tokens?.expires_at ?? null,
      error: account.error,
      models: account.models,
      models_updated_at: account.models_updated_at,
      models_error: account.models_error,
      quota: {
        ...account.quota,
        stale:
          account.status !== OAuthAccountStatus.Ready ||
          account.quota.last_error !== null ||
          account.quota.updated_at === null ||
          Date.now() - account.quota.updated_at >= QUOTA_CACHE_TTL_MS,
      },
    };
  }
  private session(id: string, actor: string): Session {
    return this.ownedSession(this.requireAccount(), id, actor);
  }
  private ownedSession(account: Stored, id: string, actor: string): Session {
    const session = account.session;
    if (!session || session.id !== id)
      throw new OAuthError("Authorization session does not exist", 404);
    if (session.actor !== actor)
      throw new OAuthError(
        "Authorization belongs to another administrator",
        403,
      );
    return session;
  }
  private async expireSession(): Promise<void> {
    const session = this.account?.session;
    if (
      !session ||
      Date.now() < session.expires_at ||
      terminalSessionStatuses.has(session.status)
    )
      return;
    await this.change((account) => {
      if (!account) throw new OAuthError("Account does not exist", 404);
      const current = account.session;
      if (
        current &&
        Date.now() >= current.expires_at &&
        !terminalSessionStatuses.has(current.status)
      ) {
        account.generation++;
        current.status = OAuthSessionStatus.Expired;
        current.tokens = null;
        current.verifier = "";
        current.state = "";
      }
      return account;
    });
  }
  private sessionView(id: string, actor: string): SessionView {
    const session = this.session(id, actor);
    const account = this.requireAccount();
    const device = session.flow === OAuthFlow.Device;
    return {
      id: `${account.account_ref}.${session.id}`,
      account_ref: account.account_ref,
      status: session.status,
      expires_at: session.expires_at,
      url:
        session.status !== OAuthSessionStatus.Pending
          ? null
          : device
            ? CODEX_VERIFICATION_URI
            : account.provider_type === ProviderType.Codex
              ? codexAuthorizationUrl(session.state, session.challenge)
              : antigravityAuthorizationUrl(session.state, session.challenge),
      flow: session.flow,
      user_code:
        device && session.status === OAuthSessionStatus.Pending
          ? session.user_code
          : null,
      verification_uri: device ? CODEX_VERIFICATION_URI : null,
      error: session.error,
      can_retry:
        session.status === OAuthSessionStatus.Error &&
        session.tokens !== null &&
        Date.now() < session.expires_at,
      account: this.view(),
    };
  }
  private async antigravity(
    connection?: ProviderConnection,
    config?: ProxyConfiguration,
  ): Promise<AntigravityClient> {
    const [send, signal] = await this.outbound(connection, config);
    return new AntigravityClient(send, signal);
  }
  private async codex(
    connection?: ProviderConnection,
    config?: ProxyConfiguration,
  ): Promise<CodexClient> {
    if (this.requireAccount().provider_type !== ProviderType.Codex)
      throw new OAuthError("This operation is only available for Codex", 400);
    const [send, signal] = await this.outbound(connection, config);
    return new CodexClient(
      send,
      signal,
      this.account?.codex?.is_fedramp ?? false,
    );
  }
  private async outbound(
    connection?: ProviderConnection,
    config?: ProxyConfiguration,
  ): Promise<[UpstreamFetch, AbortSignal]> {
    const account = this.requireAccount();
    if (connection && connection.provider_id !== account.provider_id)
      throw new OAuthError("Account belongs to another provider", 403);
    let selected = connection ?? account.connection;
    if (!connection) {
      const raw = await this.env.CODY_CONFIG_KV.get(
        this.env.CONFIG_KEY ?? "gateway-config",
      );
      if (raw) {
        const published = configurationSchema.parse(JSON.parse(raw));
        const provider = published.providers.find(
          (provider) =>
            provider.id === account.provider_id &&
            provider.type === account.provider_type,
        );
        const credential = provider?.credentials.find(
          (credential) =>
            credential.auth.type === CredentialAuthType.OAuth &&
            credential.auth.account_ref === account.account_ref,
        );
        if (provider && credential)
          selected = providerConnection(provider, credential);
        config ??= published;
      }
    }
    const network = config ?? (await publishedProxyConfiguration(this.env));
    const group =
      selected.credential_proxy_group === undefined
        ? selected.provider_proxy_group
        : selected.credential_proxy_group;
    if (group && !network.proxy_groups.some((entry) => entry.id === group))
      throw new OAuthError(
        "Publish the selected proxy group before using it",
        409,
      );
    const signal = new AbortController().signal;
    return [providerOutbound(selected, network, this.env, signal).send, signal];
  }
  private async start(
    accountRef: string,
    actor: string,
    connection: ProviderConnection,
    providerType: OAuthProviderType,
    flow: OAuthFlow,
  ): Promise<SessionView> {
    if (flow === OAuthFlow.Device && providerType !== ProviderType.Codex)
      throw new OAuthError("Device authorization is only available for Codex");
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = base64url(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier),
        ),
      ),
    );
    const session: Session = {
      id: crypto.randomUUID(),
      actor,
      status: OAuthSessionStatus.Pending,
      state: base64url(crypto.getRandomValues(new Uint8Array(32))),
      verifier,
      challenge,
      expires_at:
        Date.now() +
        (flow === OAuthFlow.Device ? CODEX_DEVICE_TTL_MS : SESSION_TTL_MS),
      connection,
      error: null,
      tokens: null,
      identity: null,
      stage: "identity",
      tier: "free-tier",
      attempts: 0,
      // Device sessions request their code before the first poll is scheduled.
      next_at: flow === OAuthFlow.Device ? Number.MAX_SAFE_INTEGER : Date.now(),
      flow,
      device_auth_id: null,
      user_code: null,
      poll_interval_ms: 5000,
    };
    await this.change((account) => {
      if (
        account &&
        (account.account_ref !== accountRef ||
          account.provider_id !== connection.provider_id ||
          account.provider_type !== providerType)
      )
        throw new OAuthError("Account belongs to another provider", 403);
      account ??= {
        account_ref: accountRef,
        provider_id: connection.provider_id,
        provider_type: providerType,
        generation: 0,
        status: OAuthAccountStatus.Disconnected,
        connection,
        tokens: null,
        identity: null,
        project_id: null,
        codex: null,
        error: null,
        session: null,
        models: [],
        models_updated_at: null,
        models_error: null,
        quota: emptyQuota(),
      };
      account.generation++;
      account.session = session;
      return account;
    });
    await this.env.CODY_DB.prepare(
      insertIgnore(
        sqlDialect(this.env.CODY_DB),
        "INSERT INTO oauth_accounts (account_ref, provider_id, provider_type, created_at) VALUES (?, ?, ?, ?)",
      ),
    )
      .bind(accountRef, connection.provider_id, providerType, Date.now())
      .run();
    if (flow === OAuthFlow.Device)
      await this.requestDeviceCode(session.id, actor);
    return this.sessionView(session.id, actor);
  }
  private async requestDeviceCode(id: string, actor: string): Promise<void> {
    const generation = this.requireAccount().generation;
    try {
      const grant = await (
        await this.codex(this.session(id, actor).connection)
      ).startDevice();
      await this.updateGeneration(generation, (account) => {
        const pending = this.ownedSession(account, id, actor);
        pending.device_auth_id = grant.device_auth_id;
        pending.user_code = grant.user_code;
        pending.poll_interval_ms = grant.interval_ms;
        pending.next_at = Date.now() + grant.interval_ms;
      });
    } catch (error) {
      await this.failSession(
        generation,
        error instanceof OAuthError && error.status === 404
          ? new OAuthError(
              "Device code sign-in is not enabled for this ChatGPT workspace; use the browser callback instead",
            )
          : error,
      );
    }
  }
  /** One alarm-driven poll; approval continues into token exchange and initialization. */
  private async pollDevice(): Promise<void> {
    const snapshot = structuredClone(this.requireAccount());
    const session = snapshot.session;
    if (!session || !devicePending(session)) return;
    if (!session.device_auth_id || !session.user_code) return;
    const client = await this.codex(session.connection);
    const approved = await client.pollDevice({
      device_auth_id: session.device_auth_id,
      user_code: session.user_code,
    });
    if (!approved) {
      await this.updateGeneration(snapshot.generation, (account) => {
        const pending = account.session;
        if (pending?.id === session.id && devicePending(pending))
          pending.next_at = Date.now() + pending.poll_interval_ms;
      });
      return;
    }
    await this.updateGeneration(snapshot.generation, (account) => {
      const pending = account.session;
      if (pending?.id !== session.id || !devicePending(pending))
        throw new OAuthError("Authorization is no longer pending", 409);
      pending.status = OAuthSessionStatus.Exchanging;
      pending.user_code = null;
    });
    const tokens = await client.exchange(
      approved.code,
      approved.verifier,
      CODEX_DEVICE_REDIRECT_URI,
    );
    await this.updateGeneration(snapshot.generation, (account) => {
      const pending = account.session;
      if (
        pending?.id !== session.id ||
        pending.status !== OAuthSessionStatus.Exchanging
      )
        throw new OAuthError("Authorization session is no longer active", 410);
      pending.tokens = tokens;
      pending.device_auth_id = null;
      pending.status = OAuthSessionStatus.Initializing;
      pending.next_at = Date.now();
    });
  }
  private async complete(
    id: string,
    actor: string,
    redirect: string,
  ): Promise<SessionView> {
    const session = this.session(id, actor);
    const generation = this.requireAccount().generation;
    if (
      session.status === OAuthSessionStatus.Expired ||
      session.status === OAuthSessionStatus.Cancelled ||
      Date.now() >= session.expires_at
    )
      throw new OAuthError(
        "Authorization session expired or was cancelled; start again",
        410,
      );
    if (session.flow === OAuthFlow.Device)
      throw new OAuthError(
        "This session waits for device approval; no callback is needed",
        409,
      );
    if (session.status !== OAuthSessionStatus.Pending)
      throw new OAuthError(
        "Authorization callback was already submitted; check the session status",
        409,
      );
    const codex = this.requireAccount().provider_type === ProviderType.Codex;
    const url = URL.parse(redirect);
    const callbackState = url?.searchParams.get("state") ?? "";
    const onboardingSuffix = ".onboarding_entrypoint=life_sciences";
    const normalizedState =
      codex && callbackState.endsWith(onboardingSuffix)
        ? callbackState.slice(0, -onboardingSuffix.length)
        : callbackState;
    if (
      !url ||
      `${url.origin}${url.pathname}` !==
        (codex ? CODEX_REDIRECT_URI : ANTIGRAVITY_REDIRECT_URI) ||
      url.username ||
      url.password ||
      url.hash ||
      url.searchParams.getAll("state").length !== 1 ||
      !(await equalSecret(normalizedState, session.state))
    )
      throw new OAuthError("Invalid callback URL or OAuth state");
    if (url.searchParams.has("error")) {
      await this.cancel(id, actor);
      return this.sessionView(id, actor);
    }
    const code = url.searchParams.get("code");
    if (!code || url.searchParams.getAll("code").length !== 1)
      throw new OAuthError(
        "The callback URL must contain one authorization code",
      );
    await this.updateGeneration(generation, (account) => {
      const pending = this.ownedSession(account, id, actor);
      if (pending.status !== OAuthSessionStatus.Pending)
        throw new OAuthError("Authorization is already being processed", 409);
      if (Date.now() >= pending.expires_at)
        throw new OAuthError("Authorization session expired; start again", 410);
      pending.status = OAuthSessionStatus.Exchanging;
    });
    const operation = (async () => {
      try {
        const tokens = codex
          ? await (
              await this.codex(session.connection)
            ).exchange(code, session.verifier, CODEX_REDIRECT_URI)
          : await (
              await this.antigravity(session.connection)
            ).exchange(code, session.verifier);
        await this.updateGeneration(generation, (account) => {
          const pending = this.ownedSession(account, id, actor);
          if (
            pending.status !== OAuthSessionStatus.Exchanging ||
            Date.now() >= pending.expires_at
          )
            throw new OAuthError(
              "Authorization session is no longer active",
              410,
            );
          pending.tokens = tokens;
          pending.verifier = "";
          pending.status = OAuthSessionStatus.Initializing;
          pending.next_at = Date.now();
        });
      } catch (error) {
        await this.failSession(generation, error);
      }
    })();
    this.ctx.waitUntil(operation);
    await operation;
    return this.sessionView(id, actor);
  }
  private async failSession(generation: number, error: unknown): Promise<void> {
    logWarn("oauth.session.failed", {
      generation,
      operation: "authorization",
    });
    if (this.account?.generation !== generation) return;
    await this.updateGeneration(generation, (account) => {
      if (!account.session) return;
      account.session.status = OAuthSessionStatus.Error;
      account.session.error = safeError(error);
      account.session.verifier = "";
    });
  }
  private async cancel(id: string, actor: string): Promise<void> {
    this.session(id, actor);
    await this.change((account) => {
      if (!account) throw new OAuthError("Account does not exist", 404);
      const session = this.ownedSession(account, id, actor);
      if (session.status === OAuthSessionStatus.Complete)
        throw new OAuthError(
          "Authorization is complete; disconnect the account instead",
          409,
        );
      account.generation++;
      session.status = OAuthSessionStatus.Cancelled;
      session.tokens = null;
      session.verifier = "";
      session.state = "";
      return account;
    });
  }
  private async initialize(): Promise<void> {
    const snapshot = structuredClone(this.requireAccount());
    const session = snapshot.session;
    if (!session?.tokens || session.status !== OAuthSessionStatus.Initializing)
      return;
    if (snapshot.provider_type === ProviderType.Codex)
      return this.initializeCodex(snapshot, session, session.tokens);
    const client = await this.antigravity(session.connection);
    let identity = session.identity;
    let project: string | null = null;
    let nextStage = session.stage;
    let tier = session.tier;
    let attempts = session.attempts;
    if (session.stage === "identity") {
      identity = await client.userInfo(session.tokens.access_token);
      if (snapshot.identity && snapshot.identity.id !== identity.id)
        throw new OAuthError(
          "This is a different Google account; add it as a new account instead",
        );
      nextStage = "project";
    } else if (session.stage === "project") {
      const info = await client.load(session.tokens.access_token);
      project = projectId(info);
      tier = defaultTier(info);
      nextStage = "onboard";
    } else {
      const result = object(
        await client.onboard(session.tokens.access_token, tier),
      );
      attempts++;
      if (result.done === true) {
        project = projectId(result.response);
        if (!project)
          throw new OAuthError(
            "Project initialization completed without a project ID",
            502,
          );
      } else if (attempts >= 5)
        throw new OAuthError(
          "Project initialization is not complete; retry initialization",
          503,
        );
    }
    await this.updateGeneration(snapshot.generation, (account) => {
      const pending = account.session;
      if (
        !pending ||
        pending.id !== session.id ||
        pending.status !== OAuthSessionStatus.Initializing ||
        !pending.tokens
      )
        throw new OAuthError("Authorization was cancelled", 409);
      if (Date.now() >= pending.expires_at)
        throw new OAuthError("Authorization session expired; start again", 410);
      pending.identity = identity;
      pending.tier = tier;
      pending.stage = nextStage;
      pending.attempts = attempts;
      pending.next_at = Date.now() + (session.stage === "onboard" ? 2000 : 1);
      if (project && identity) {
        const refreshToken =
          pending.tokens.refresh_token ?? account.tokens?.refresh_token;
        if (!refreshToken)
          throw new OAuthError(
            "Google did not return a refresh token; start authorization again",
          );
        account.tokens = { ...pending.tokens, refresh_token: refreshToken };
        account.identity = identity;
        account.project_id = project;
        account.connection = pending.connection;
        account.status = OAuthAccountStatus.Ready;
        account.error = null;
        account.generation++;
        account.quota = emptyQuota();
        account.models = [];
        account.models_updated_at = null;
        account.models_error = null;
        pending.status = OAuthSessionStatus.Complete;
        pending.tokens = null;
        pending.state = "";
        pending.verifier = "";
      }
    });
  }
  /** Codex identity comes from the exchanged id_token; there is no project setup. */
  private async initializeCodex(
    snapshot: Stored,
    session: Session,
    tokens: NonNullable<Session["tokens"]>,
  ): Promise<void> {
    if (!tokens.id_token)
      throw new OAuthError(
        "ChatGPT did not return an identity token; start authorization again",
        502,
      );
    const claims = parseIdToken(tokens.id_token);
    const identity = {
      id: `${claims.account_id}:${claims.user_id ?? claims.email ?? claims.account_id}`,
      email: claims.email,
    };
    if (snapshot.identity && snapshot.identity.id !== identity.id)
      throw new OAuthError(
        "This is a different ChatGPT account; add it as a new account instead",
      );
    await this.updateGeneration(snapshot.generation, (account) => {
      const pending = account.session;
      if (
        !pending ||
        pending.id !== session.id ||
        pending.status !== OAuthSessionStatus.Initializing ||
        !pending.tokens
      )
        throw new OAuthError("Authorization was cancelled", 409);
      if (Date.now() >= pending.expires_at)
        throw new OAuthError("Authorization session expired; start again", 410);
      const refreshToken =
        pending.tokens.refresh_token ?? account.tokens?.refresh_token;
      if (!refreshToken)
        throw new OAuthError(
          "ChatGPT did not return a refresh token; start authorization again",
        );
      account.tokens = { ...pending.tokens, refresh_token: refreshToken };
      account.identity = identity;
      account.codex = {
        account_id: claims.account_id,
        ...(claims.is_fedramp ? { is_fedramp: true } : {}),
        user_id: claims.user_id,
        plan_type: claims.plan_type,
        subscription_active_until: claims.subscription_active_until,
      };
      account.connection = pending.connection;
      account.status = OAuthAccountStatus.Ready;
      account.error = null;
      account.generation++;
      account.quota = emptyQuota();
      account.models = [];
      account.models_updated_at = null;
      account.models_error = null;
      pending.status = OAuthSessionStatus.Complete;
      pending.tokens = null;
      pending.state = "";
      pending.verifier = "";
    });
  }
  private active() {
    const account = this.requireAccount();
    if (account.status !== OAuthAccountStatus.Ready || !account.tokens)
      throw new OAuthError(
        "Reconnect this account before sending requests",
        503,
        "oauth_account_unavailable",
      );
    let credential:
      { account_id: string; is_fedramp?: boolean } | { project_id: string };
    if (account.provider_type === ProviderType.Codex && account.codex) {
      credential = {
        account_id: account.codex.account_id,
        ...(account.codex.is_fedramp ? { is_fedramp: true } : {}),
      };
    } else if (
      account.provider_type === ProviderType.Antigravity &&
      account.project_id
    ) {
      credential = { project_id: account.project_id };
    } else {
      throw new OAuthError(
        "Account identity is unavailable; reconnect this account",
        503,
        "oauth_account_unavailable",
      );
    }
    return {
      generation: account.generation,
      tokens: account.tokens,
      credential,
    };
  }
  private async resolve(
    connection?: ProviderConnection,
    config?: ProxyConfiguration,
  ) {
    const snapshot = this.active();
    if (
      connection &&
      connection.provider_id !== this.requireAccount().provider_id
    )
      throw new OAuthError("Account belongs to another provider", 403);
    if (snapshot.tokens.expires_at <= Date.now() + TOKEN_REFRESH_MARGIN_MS) {
      await this.shareRefresh("token", snapshot.generation, async () => {
        try {
          const refreshToken = snapshot.tokens.refresh_token;
          if (!refreshToken)
            throw new OAuthError(
              "Reconnect this account to obtain a refresh token",
              503,
              "invalid_grant",
            );
          let result: z.output<typeof tokenSchema>;
          let claims: ReturnType<typeof parseIdToken> | null = null;
          if (this.requireAccount().provider_type === ProviderType.Codex) {
            result = await (
              await this.codex(connection, config)
            ).refresh(refreshToken, snapshot.tokens);
            // A refreshed id_token may carry a new plan or renewal date.
            if (result.id_token) claims = parseIdToken(result.id_token);
          } else
            result = await (
              await this.antigravity(connection, config)
            ).refresh(refreshToken);
          if (
            claims &&
            claims.account_id !== this.requireAccount().codex?.account_id
          )
            throw new OAuthError(
              "Token refresh returned a different workspace; reconnect this account",
              401,
              "invalid_grant",
            );
          await this.updateGeneration(snapshot.generation, (account) => {
            account.tokens = {
              ...result,
              refresh_token: result.refresh_token ?? refreshToken,
            };
            if (
              claims &&
              account.codex &&
              claims.account_id === account.codex.account_id
            )
              account.codex = {
                ...account.codex,
                is_fedramp: claims.is_fedramp ?? false,
                plan_type: claims.plan_type ?? account.codex.plan_type,
                subscription_active_until:
                  claims.subscription_active_until ??
                  account.codex.subscription_active_until,
              };
            account.error = null;
          });
        } catch (error) {
          if (this.account?.generation === snapshot.generation)
            await this.updateGeneration(snapshot.generation, (account) => {
              account.error = safeError(error);
              if (error instanceof OAuthError && error.code === "invalid_grant")
                account.status = OAuthAccountStatus.NeedsReauthorization;
            });
          throw error;
        }
      });
    }
    const current = this.active();
    return { token: current.tokens.access_token, ...current.credential };
  }
  private refreshModels(): Promise<void> {
    const generation = this.requireAccount().generation;
    return this.shareRefresh("models", generation, async () => {
      try {
        const token = await this.resolve();
        const models =
          "account_id" in token
            ? parseCodexModels(
                await (
                  await this.codex()
                ).models(token.token, token.account_id),
              )
            : parseAntigravityModels(
                await (
                  await this.antigravity()
                ).models(token.token, token.project_id),
              );
        await this.updateGeneration(generation, (account) => {
          account.models = models;
          account.models_updated_at = Date.now();
          account.models_error = null;
        });
      } catch (error) {
        if (this.account?.generation === generation)
          await this.updateGeneration(generation, (account) => {
            account.models_error = safeError(error);
          });
      }
    });
  }
  private async refreshQuota(force: boolean): Promise<void> {
    if (!force && !this.view().quota.stale) return;
    const generation = this.requireAccount().generation;
    await this.shareRefresh("quota", generation, async () => {
      try {
        const token = await this.resolve();
        if ("account_id" in token)
          return await this.refreshCodexQuota(
            generation,
            token.token,
            token.account_id,
          );
        let groups: QuotaSnapshot["groups"] | undefined;
        let subscription: QuotaSnapshot["subscription"] | undefined;
        let lastError: string | null = null;
        // Independent transports, serialized so a six-account batch has at most six requests in flight.
        // Preparation and parsing belong to each operation's failure boundary too.
        try {
          groups = parseQuota(
            await (
              await this.antigravity()
            ).quota(token.token, token.project_id),
          );
        } catch (error) {
          lastError = safeError(error);
        }
        try {
          subscription = parseSubscription(
            await (await this.antigravity()).load(token.token),
          );
        } catch (error) {
          lastError ??= safeError(error);
        }
        await this.updateGeneration(generation, (account) => {
          if (groups !== undefined) {
            account.quota.groups = groups;
            account.quota.updated_at = Date.now();
          }
          if (subscription !== undefined)
            account.quota.subscription = subscription;
          account.quota.last_error = lastError;
        });
      } catch (error) {
        if (this.account?.generation === generation)
          await this.updateGeneration(generation, (account) => {
            account.quota.last_error = safeError(error);
          });
      }
    });
  }
  private async refreshCodexQuota(
    generation: number,
    token: string,
    accountId: string,
  ): Promise<void> {
    let usage: ReturnType<typeof parseUsage> | undefined;
    let lastError: string | null = null;
    try {
      usage = parseUsage(await (await this.codex()).usage(token, accountId));
    } catch (error) {
      lastError = safeError(error);
    }
    // A reset-credit lookup failure never hides the usage windows.
    const resets = await this.fetchResetCredits(token, accountId);
    await this.updateGeneration(generation, (account) => {
      const now = Date.now();
      if (usage) {
        account.quota.groups = usage.groups;
        account.quota.updated_at = now;
        account.quota.limit_reached = usage.limit_reached;
        account.quota.credits_balance = usage.credits_balance;
        if (account.codex && usage.plan_type)
          account.codex = { ...account.codex, plan_type: usage.plan_type };
        account.quota.subscription = {
          tier_id: usage.plan_type ?? account.codex?.plan_type ?? null,
          tier_name: null,
          credits: [],
          active_until: account.codex?.subscription_active_until ?? null,
        };
      }
      account.quota.reset_credits = resets;
      account.quota.last_error = lastError;
    });
  }
  private async fetchResetCredits(
    token: string,
    accountId: string,
  ): Promise<NonNullable<QuotaSnapshot["reset_credits"]>> {
    const previous = this.account?.quota.reset_credits;
    try {
      return {
        ...parseResetCredits(
          await (await this.codex()).resetCredits(token, accountId),
        ),
        updated_at: Date.now(),
        error: null,
      };
    } catch (error) {
      return {
        available_count: previous?.available_count ?? 0,
        credits: previous?.credits ?? [],
        updated_at: previous?.updated_at ?? null,
        error: safeError(error),
      };
    }
  }
  private async refreshResetCredits(): Promise<void> {
    const generation = this.requireAccount().generation;
    const token = await this.resolve();
    if (!("account_id" in token))
      throw new OAuthError("This operation is only available for Codex", 400);
    const resets = await this.fetchResetCredits(token.token, token.account_id);
    await this.updateGeneration(generation, (account) => {
      account.quota.reset_credits = resets;
    });
  }
  /** Spends one reset credit; the redeem ID makes a retried request idempotent upstream. */
  private async consumeReset(
    redeemRequestId: string,
    creditId?: string,
  ): Promise<{ result: ConsumeResetResult; account: AccountView }> {
    const token = await this.resolve();
    if (!("account_id" in token))
      throw new OAuthError("This operation is only available for Codex", 400);
    const result = await (
      await this.codex()
    ).consumeReset(token.token, token.account_id, redeemRequestId, creditId);
    logWarn("oauth.codex.reset_consumed", {
      code: result.code,
      windows_reset: result.windows_reset,
    });
    await this.refreshQuota(true);
    return { result, account: this.view() };
  }
  private async retry(id: string, actor: string): Promise<void> {
    await this.updateGeneration(this.requireAccount().generation, (account) => {
      const session = this.ownedSession(account, id, actor);
      if (
        session.status !== OAuthSessionStatus.Error ||
        !session.tokens ||
        Date.now() >= session.expires_at
      )
        throw new OAuthError("Start a new authorization session", 409);
      session.status = OAuthSessionStatus.Initializing;
      session.error = null;
      session.attempts = 0;
      session.next_at = Date.now();
    });
  }
  private async disconnect(): Promise<void> {
    await this.change((account) => {
      if (!account) throw new OAuthError("Account does not exist", 404);
      account.generation++;
      account.tokens = null;
      account.session = null;
      account.status = OAuthAccountStatus.Disconnected;
      account.error = null;
      return account;
    });
  }
  private async dispatch(command: z.output<typeof accountCommandSchema>) {
    switch (command.action) {
      case "start":
        return this.start(
          command.account_ref,
          command.actor,
          command.connection,
          command.provider_type,
          command.flow,
        );
      case "complete":
        return this.complete(
          command.session_id,
          command.actor,
          command.redirect_url,
        );
      case "cancel":
        await this.cancel(command.session_id, command.actor);
        return this.sessionView(command.session_id, command.actor);
      case "retry":
        await this.retry(command.session_id, command.actor);
        return this.sessionView(command.session_id, command.actor);
      case "session":
        return this.sessionView(command.session_id, command.actor);
      case "resolve":
        return this.resolve(command.connection, command.proxy_configuration);
      case "models":
        await this.refreshModels();
        return this.view();
      case "quota":
        await this.refreshQuota(command.force);
        return this.view();
      case "disconnect":
        await this.disconnect();
        return this.view();
      case "reset_credits":
        await this.refreshResetCredits();
        return this.view();
      case "consume_reset":
        return this.consumeReset(command.redeem_request_id, command.credit_id);
      case "view":
        return this.view();
    }
  }
  async run(input: AccountCommand): Promise<AccountReply> {
    try {
      const command = accountCommandSchema.parse(input);
      await this.expireSession();
      return { ok: true, data: await this.dispatch(command) };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof z.ZodError
            ? "Invalid account data"
            : safeError(error),
        status:
          error instanceof OAuthError
            ? error.status
            : error instanceof z.ZodError
              ? 400
              : 503,
        code:
          error instanceof OAuthError ? error.code : "oauth_operation_failed",
      };
    }
  }
  async alarm(): Promise<void> {
    await this.expireSession();
    const account = this.requireAccount();
    const session = account.session;
    if (!session) return;
    if (devicePending(session)) {
      try {
        await this.pollDevice();
      } catch (error) {
        const pending = this.account?.session;
        // Transport faults keep polling until the device code expires.
        if (
          !(error instanceof OAuthError) &&
          pending?.id === session.id &&
          devicePending(pending)
        )
          await this.updateGeneration(account.generation, (current) => {
            if (current.session?.id === session.id)
              current.session.next_at =
                Date.now() + current.session.poll_interval_ms * 2;
          });
        else await this.failSession(account.generation, error);
      }
      return;
    }
    if (session.status === OAuthSessionStatus.Initializing) {
      try {
        await this.initialize();
      } catch (error) {
        await this.failSession(account.generation, error);
      }
    }
  }
}
