import { ControlStore } from "../../control/store.ts";
import { XaiClient, xaiDeviceSchema, xaiIdentity } from "../xai/api.ts";
import { xaiModels } from "../xai/models.ts";
import {
  ClaudeClient,
  CLAUDE_REDIRECT_URI,
  authorizationUrl as claudeAuthorizationUrl,
  parseProfile as parseClaudeProfile,
  parseModels as parseClaudeModels,
  parseUsage as parseClaudeUsage,
} from "../claude/api.ts";
import {
  OAuthAccountViewStatus,
  OAuthFlow,
  OAuthSessionStatus,
  OAuthAccountStatus,
} from "./values.ts";
import { ProviderType, CredentialAuthType } from "../../config/values.ts";

import { z } from "zod";
import { decryptConfig, encryptConfig } from "../../control/crypto.ts";
import { equalSecret } from "../../shared/equal-secret.ts";
import { configureLogging, logWarn } from "../../shared/log.ts";
import { antigravityVersion } from "../antigravity/version.ts";
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
  currentProxyConfiguration,
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
  | "CONFIG_ENCRYPTION_KEY"
  | "PROXY_GROUP"
  | "UPSTREAM_HTTP"
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
  xai_device: xaiDeviceSchema.optional(),
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
  claude: accountViewSchema.shape.claude,
  xai: accountViewSchema.shape.xai,
  claude_quota_revision: z.number().default(0),
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
  private change(
    update: (previous: Stored | null) => Stored | Promise<Stored>,
  ): Promise<void> {
    const operation = this.mutations.then(async () => {
      configureLogging(this.env.LOG_LEVEL);
      const next = await update(
        this.account ? structuredClone(this.account) : null,
      );
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
    update: (account: Stored) => void | Promise<void>,
  ): Promise<void> {
    await this.change(async (account) => {
      if (!account || account.generation !== generation)
        throw new OAuthError(
          "Account changed during the operation; try again",
          409,
          "account_changed",
        );
      await update(account);
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
      generation: account.generation,
      account_ref: account.account_ref,
      provider_id: account.provider_id,
      status,
      email: account.identity?.email ?? null,
      project_id: account.project_id,
      codex: account.codex,
      claude: account.claude,
      xai: account.xai,
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
        current.xai_device = undefined;
        current.user_code = null;
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
            ? (session.xai_device?.verification_uri_complete ??
              session.xai_device?.verification_uri ??
              CODEX_VERIFICATION_URI)
            : account.provider_type === ProviderType.Codex
              ? codexAuthorizationUrl(session.state, session.challenge)
              : account.provider_type === ProviderType.Claude
                ? claudeAuthorizationUrl(session.state, session.challenge)
                : antigravityAuthorizationUrl(session.state, session.challenge),
      flow: session.flow,
      user_code:
        device && session.status === OAuthSessionStatus.Pending
          ? session.user_code
          : null,
      verification_uri: device
        ? (session.xai_device?.verification_uri_complete ??
          session.xai_device?.verification_uri ??
          CODEX_VERIFICATION_URI)
        : null,
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
    return new AntigravityClient(
      send,
      signal,
      await antigravityVersion(this.env.CODY_CONFIG_KV, this.ctx),
    );
  }
  private async xai(
    connection?: ProviderConnection,
    config?: ProxyConfiguration,
  ): Promise<XaiClient> {
    const [send, signal] = await this.outbound(connection, config);
    return new XaiClient(send, signal);
  }
  private async claude(
    connection?: ProviderConnection,
    config?: ProxyConfiguration,
  ): Promise<ClaudeClient> {
    const [send, signal] = await this.outbound(connection, config);
    return new ClaudeClient(send, signal);
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
      const committed = await new ControlStore(
        this.env.CODY_DB,
        this.env.CONFIG_ENCRYPTION_KEY,
      ).committed();
      {
        const provider = committed.providers.find(
          (provider) =>
            provider.id === account.provider_id &&
            provider.type === account.provider_type,
        );
        if (!provider && committed.revision)
          throw new OAuthError("Provider is no longer configured", 410);
        const credential = provider?.credentials.find(
          (credential) =>
            credential.auth.type === CredentialAuthType.OAuth &&
            credential.auth.account_ref === account.account_ref,
        );
        if (provider && credential)
          selected = providerConnection(provider, credential);
        config ??= committed;
      }
    }
    const network = config ?? (await currentProxyConfiguration(this.env));
    const group =
      selected.credential_proxy_group === undefined
        ? selected.provider_proxy_group
        : selected.credential_proxy_group;
    if (group && !network.proxy_groups.some((entry) => entry.id === group))
      throw new OAuthError(
        "Save the selected proxy group before using it",
        409,
      );
    const signal = new AbortController().signal;
    return [
      providerOutbound(
        selected,
        network,
        this.env,
        signal,
        account.provider_type,
      ).send,
      signal,
    ];
  }
  private async start(
    accountRef: string,
    actor: string,
    connection: ProviderConnection,
    providerType: OAuthProviderType,
    flow: OAuthFlow,
  ): Promise<SessionView> {
    if (
      flow === OAuthFlow.Device &&
      providerType !== ProviderType.Codex &&
      providerType !== ProviderType.Xai
    )
      throw new OAuthError("Device authorization is only available for Codex");
    if (providerType === ProviderType.Xai && flow !== OAuthFlow.Device)
      throw new OAuthError("xAI requires device authorization", 400);
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
        claude_quota_revision: 0,
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
      if (this.requireAccount().provider_type === ProviderType.Xai) {
        const grant = await (
          await this.xai(this.session(id, actor).connection)
        ).startDevice();
        await this.updateGeneration(generation, (account) => {
          const pending = this.ownedSession(account, id, actor);
          pending.xai_device = grant;
          pending.user_code = grant.user_code;
          pending.expires_at =
            Date.now() + Math.min(grant.expires_in, 1800) * 1000;
          pending.poll_interval_ms = Math.max(5, grant.interval) * 1000;
          pending.next_at = Date.now() + pending.poll_interval_ms;
        });
        return;
      }
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
    if (snapshot.provider_type === ProviderType.Xai) {
      if (!session.xai_device) return;
      const result = await (
        await this.xai(session.connection)
      ).pollDevice(session.xai_device);
      await this.updateGeneration(snapshot.generation, (account) => {
        const pending = account.session;
        if (
          !pending ||
          pending.id !== session.id ||
          !devicePending(pending) ||
          Date.now() >= pending.expires_at
        )
          throw new OAuthError(
            "Authorization session is no longer active",
            410,
          );
        if (result.tokens) {
          pending.tokens = result.tokens;
          pending.status = OAuthSessionStatus.Initializing;
          pending.xai_device = undefined;
          pending.user_code = null;
          pending.next_at = Date.now();
        } else {
          if (result.slow) pending.poll_interval_ms += 5000;
          pending.next_at = Date.now() + pending.poll_interval_ms;
        }
      });
      return;
    }
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
    const claude = this.requireAccount().provider_type === ProviderType.Claude;
    if (claude && !URL.canParse(redirect)) {
      const [code, state, extra] = redirect.trim().split("#");
      if (!code || !state || extra)
        throw new OAuthError(
          "Paste the Claude authorization code including its state",
        );
      redirect = `${CLAUDE_REDIRECT_URI}?${new URLSearchParams({ code, state }).toString()}`;
    }
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
        (codex
          ? CODEX_REDIRECT_URI
          : claude
            ? CLAUDE_REDIRECT_URI
            : ANTIGRAVITY_REDIRECT_URI) ||
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
          : claude
            ? await (
                await this.claude(session.connection)
              ).exchange(code, session.verifier, session.state)
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
      session.xai_device = undefined;
      session.user_code = null;
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
    if (snapshot.provider_type === ProviderType.Xai)
      return this.initializeXai(snapshot, session, session.tokens);
    if (snapshot.provider_type === ProviderType.Codex)
      return this.initializeCodex(snapshot, session, session.tokens);
    if (snapshot.provider_type === ProviderType.Claude)
      return this.initializeClaude(snapshot, session, session.tokens);
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
  private async initializeClaude(
    snapshot: Stored,
    session: Session,
    tokens: NonNullable<Session["tokens"]>,
  ): Promise<void> {
    const profile = parseClaudeProfile(
      await (
        await this.claude(session.connection)
      ).profile(tokens.access_token),
    );
    if (snapshot.identity && snapshot.identity.id !== profile.identity.id)
      throw new OAuthError(
        "This is a different Claude account or organization; add it as a new account",
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
        throw new OAuthError("Authorization session expired", 410);
      const refreshToken =
        pending.tokens.refresh_token ?? account.tokens?.refresh_token;
      if (!refreshToken)
        throw new OAuthError(
          "Claude did not return a refresh token; authorize again",
        );
      account.tokens = { ...pending.tokens, refresh_token: refreshToken };
      account.identity = profile.identity;
      account.claude = profile.claude;
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
  private async initializeXai(
    snapshot: Stored,
    session: Session,
    tokens: NonNullable<Session["tokens"]>,
  ): Promise<void> {
    const claims = xaiIdentity(tokens);
    if (snapshot.identity && snapshot.identity.id !== claims.sub)
      throw new OAuthError(
        "This is a different xAI account; add a new account",
        400,
      );
    await this.updateGeneration(snapshot.generation, (account) => {
      const pending = account.session;
      if (
        !pending ||
        pending.id !== session.id ||
        pending.status !== OAuthSessionStatus.Initializing ||
        Date.now() >= pending.expires_at
      )
        throw new OAuthError("Authorization session is no longer active", 410);
      const refresh_token =
        tokens.refresh_token ?? account.tokens?.refresh_token;
      if (!refresh_token)
        throw new OAuthError(
          "xAI did not return a refresh token; authorize again",
        );
      account.tokens = { ...tokens, refresh_token };
      account.identity = { id: claims.sub, email: claims.email ?? null };
      account.xai = { subject: claims.sub };
      account.connection = pending.connection;
      account.status = OAuthAccountStatus.Ready;
      account.error = null;
      account.generation++;
      account.quota = emptyQuota();
      account.models = xaiModels();
      account.models_updated_at = Date.now();
      account.models_error = null;
      pending.status = OAuthSessionStatus.Complete;
      pending.tokens = null;
      pending.xai_device = undefined;
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
      | { account_id: string; is_fedramp?: boolean }
      | { project_id: string }
      | { xai_subject: string; generation: number }
      | { claude_organization_id: string; generation: number };
    if (account.provider_type === ProviderType.Xai && account.xai) {
      credential = {
        xai_subject: account.xai.subject,
        generation: account.generation,
      };
    } else if (account.provider_type === ProviderType.Codex && account.codex) {
      credential = {
        account_id: account.codex.account_id,
        ...(account.codex.is_fedramp ? { is_fedramp: true } : {}),
      };
    } else if (
      account.provider_type === ProviderType.Claude &&
      account.claude
    ) {
      credential = {
        claude_organization_id: account.claude.organization_id,
        generation: account.generation,
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
          if ("xai_subject" in snapshot.credential) {
            result = await (
              await this.xai(connection, config)
            ).refresh(snapshot.tokens, snapshot.credential.xai_subject);
          } else if (
            this.requireAccount().provider_type === ProviderType.Codex
          ) {
            result = await (
              await this.codex(connection, config)
            ).refresh(refreshToken, snapshot.tokens);
            // A refreshed id_token may carry a new plan or renewal date.
            if (result.id_token) claims = parseIdToken(result.id_token);
          } else if (
            this.requireAccount().provider_type === ProviderType.Claude
          ) {
            // The refresh grant is already bound to this identity. Do not lose
            // a rotated refresh token to a subsequent profile lookup failure.
            result = await (
              await this.claude(connection, config)
            ).refresh(refreshToken, this.requireAccount().claude ?? undefined);
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
        if (this.requireAccount().provider_type === ProviderType.Xai) {
          await this.updateGeneration(generation, (account) => {
            account.models = xaiModels();
            account.models_updated_at = Date.now();
            account.models_error = null;
          });
          return;
        }
        const token = await this.resolve();
        if ("xai_subject" in token)
          throw new OAuthError("Unexpected account type", 500);
        const models =
          "claude_organization_id" in token
            ? parseClaudeModels(await (await this.claude()).models(token.token))
            : "account_id" in token
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
        if ("xai_subject" in token) {
          const usage = await (
            await this.xai()
          ).quota(token.token, token.xai_subject);
          await this.updateGeneration(generation, (account) => {
            account.quota = { ...usage, xai_limits: account.quota.xai_limits };
          });
          return;
        }
        if ("claude_organization_id" in token) {
          const revision = this.requireAccount().claude_quota_revision;
          const usage = parseClaudeUsage(
            await (await this.claude()).usage(token.token),
          );
          await this.updateGeneration(generation, (account) => {
            if (account.claude_quota_revision !== revision) return;
            account.quota = {
              ...account.quota,
              ...usage,
              updated_at: Date.now(),
              last_error: null,
              stale: false,
              subscription: {
                tier_id: account.claude?.subscription_type ?? null,
                tier_name: account.claude?.rate_limit_tier ?? null,
                credits: [],
              },
            };
          });
          return;
        }
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
      case "xai_auth_invalid":
        if (this.requireAccount().provider_type !== ProviderType.Xai)
          throw new OAuthError("Only available for xAI", 400);
        await this.updateGeneration(command.generation, async (account) => {
          if (
            !account.tokens ||
            !(await equalSecret(account.tokens.access_token, command.token))
          )
            return;
          account.status = OAuthAccountStatus.NeedsReauthorization;
          account.error = "Reconnect this xAI account";
        });
        return this.view();
      case "xai_limit":
        if (this.requireAccount().provider_type !== ProviderType.Xai)
          throw new OAuthError("Only available for xAI", 400);
        await this.updateGeneration(command.generation, (account) => {
          const limits = (account.quota.xai_limits ?? []).filter(
            (limit) => limit.until > Date.now(),
          );
          const previous = limits.find(
            (limit) =>
              limit.model === command.model && limit.kind === command.kind,
          );
          if (previous)
            previous.until = Math.max(previous.until, command.until);
          else
            limits.push({
              model: command.model,
              until: command.until,
              kind: command.kind,
            });
          account.quota.xai_limits = limits;
        });
        return this.view();
      case "claude_usage":
        if (this.requireAccount().provider_type !== ProviderType.Claude)
          throw new OAuthError("Only available for Claude", 400);
        await this.updateGeneration(command.generation, (account) => {
          account.claude_quota_revision++;
          if (
            command.extra_usage_disabled_reason !== undefined &&
            account.quota.extra_usage
          )
            account.quota.extra_usage.disabled_reason =
              command.extra_usage_disabled_reason;
          for (const group of command.groups) {
            const index = account.quota.groups.findIndex(
              (previous) => previous.id === group.id,
            );
            if (index === -1) account.quota.groups.push(group);
            else {
              const previous = account.quota.groups[index];
              const previousReset = Date.parse(
                previous.buckets[0]?.reset_at ?? "",
              );
              const nextReset = Date.parse(group.buckets[0]?.reset_at ?? "");
              if (
                !Number.isFinite(previousReset) ||
                nextReset > previousReset ||
                (nextReset === previousReset &&
                  (group.buckets[0]?.used_percent ?? 0) >=
                    (previous.buckets[0]?.used_percent ?? 0))
              )
                account.quota.groups[index] = group;
            }
          }
        });
        return this.view();
      case "claude_limit":
        if (this.requireAccount().provider_type !== ProviderType.Claude)
          throw new OAuthError("Only available for Claude", 400);
        await this.updateGeneration(command.generation, (account) => {
          account.claude_quota_revision++;
          const limits = (account.quota.claude_limits ?? []).filter(
            (limit) => limit.until > Date.now(),
          );
          for (const observation of [
            command,
            ...(command.additional_limits ?? []),
          ]) {
            const existing = limits.find(
              (limit) => limit.model === observation.model,
            );
            if (existing)
              existing.until = Math.max(existing.until, observation.until);
            else
              limits.push({
                model: observation.model,
                until: observation.until,
              });
          }
          account.quota.claude_limits = limits;
        });
        return this.view();
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
