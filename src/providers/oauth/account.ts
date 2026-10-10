import {
  storedSchema,
  terminalSessionStatuses,
  emptyQuota,
  devicePending,
  nextAccountAlarm,
  safeError,
  base64url,
  type Stored,
  type Session,
} from "./state.ts";
import { AccountInventory } from "./inventory.ts";
import {
  initializeCodexAccount,
  initializeClaudeAccount,
  initializeXaiAccount,
} from "./initialization.ts";
import { accountView } from "./presentation.ts";
import { ControlStore } from "../../control/store.ts";
import { XaiClient, xaiIdentity } from "../xai/api.ts";

import {
  ClaudeClient,
  CLAUDE_REDIRECT_URI,
  authorizationUrl as claudeAuthorizationUrl,
  parseProfile as parseClaudeProfile,
} from "../claude/api.ts";
import { OAuthFlow, OAuthSessionStatus, OAuthAccountStatus } from "./values.ts";
import { ProviderType, CredentialAuthType } from "../../config/values.ts";

import { z } from "zod";
import { decryptConfig, encryptConfig } from "../../control/crypto.ts";
import { equalSecret } from "../../shared/equal-secret.ts";
import { configureLogging, logWarn } from "../../shared/log.ts";
import { antigravityVersion } from "../antigravity/version.ts";
import { AntigravityVerificationError } from "../antigravity/verification.ts";
import {
  PROJECT_INITIALIZATION_TTL_MS,
  pollProject,
  scheduleProjectRetry,
  retryableProjectError,
  projectTimeout,
  type ProjectStep,
} from "../antigravity/initialization.ts";
import {
  ANTIGRAVITY_REDIRECT_URI,
  AntigravityClient,
  authorizationUrl as antigravityAuthorizationUrl,
} from "../antigravity/api.ts";
import {
  CODEX_DEVICE_REDIRECT_URI,
  CODEX_DEVICE_TTL_MS,
  CODEX_REDIRECT_URI,
  CODEX_VERIFICATION_URI,
  CodexClient,
  authorizationUrl as codexAuthorizationUrl,
  parseIdToken,
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
  tokenSchema,
  type AccountReply,
  type AccountView,
  type OAuthProviderType,
  type ProviderConnection,
  type ProxyConfiguration,
  proxyConfigurationSchema,
  type SessionView,
} from "./schema.ts";
import { sqlDialect, type Bindings } from "../../platform/bindings.ts";
import { insertIgnore } from "../../platform/sql-dialect.ts";
import type { ObjectContext } from "../../platform/object-context.ts";

const SESSION_TTL_MS = 10 * 60_000;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
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

/** One account owns its token lifecycle. Inference streams never pass through this object. */
export class ProviderOAuthAccountCore {
  private account: Stored | null = null;
  private readonly inventory: AccountInventory;
  private mutations: Promise<unknown> = Promise.resolve();
  private readonly refreshes = new Map<RefreshKind, PendingRefresh>();
  constructor(
    protected readonly ctx: ObjectContext,
    protected readonly env: AccountEnv,
  ) {
    this.inventory = new AccountInventory(
      {
        current: () => this.requireAccount(),
        update: (generation, update) =>
          this.updateGeneration(generation, update),
        refresh: (kind, generation, run) =>
          this.shareRefresh(kind, generation, run),
        resolve: () => this.resolve(),
      },
      {
        antigravity: () => this.antigravity(),
        codex: () => this.codex(),
        claude: () => this.claude(),
        xai: () => this.xai(),
      },
    );
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
      const next = storedSchema.parse(
        await update(this.account ? structuredClone(this.account) : null),
      );
      const encrypted = await encryptConfig(
        next,
        this.env.CONFIG_ENCRYPTION_KEY,
      );
      const alarm = nextAccountAlarm(next);
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
    return accountView(this.requireAccount());
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
  private async configuredConnection(fallback: ProviderConnection): Promise<{
    connection: ProviderConnection;
    config: ProxyConfiguration;
  }> {
    const account = this.requireAccount();
    const store = new ControlStore(
      this.env.CODY_DB,
      this.env.CONFIG_ENCRYPTION_KEY,
    );
    const config = await store.committed();
    const provider = config.providers.find(
      (provider) =>
        provider.id === account.provider_id &&
        provider.type === account.provider_type,
    );
    if (!provider && config.revision) {
      // Seeded native providers can exist before their first compiled snapshot.
      const current = await store.resource(["providers"], (rows) =>
        rows.providers.some(
          (row) =>
            row.id === account.provider_id &&
            row.type === account.provider_type &&
            row.deleted_at === null,
        ),
      );
      if (!current.item)
        throw new OAuthError("Provider is no longer configured", 410);
    }
    const credential = provider?.credentials.find(
      (credential) =>
        credential.auth.type === CredentialAuthType.OAuth &&
        credential.auth.account_ref === account.account_ref,
    );
    return {
      connection:
        provider && credential
          ? providerConnection(provider, credential)
          : fallback,
      // OAuth setup may precede credential creation. Do not pass inference-only
      // proxy owner inventories through this management transport boundary.
      config: proxyConfigurationSchema.parse(config),
    };
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
      const committed = await this.configuredConnection(account.connection);
      selected = committed.connection;
      config ??= committed.config;
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
      account ??= storedSchema.parse({
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
      });
      account.generation++;
      account.session = session;
      account.antigravity_initialization = null;
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
    const identity =
      session.identity ??
      (await (
        await this.antigravity(session.connection)
      ).userInfo(session.tokens.access_token));
    if (snapshot.identity && snapshot.identity.id !== identity.id)
      throw new OAuthError(
        "This is a different Google account; add it as a new account instead",
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
          "Google did not return a refresh token; start authorization again",
        );
      // The OAuth session can finish while project provisioning continues durably.
      // Keep a working account's credentials until the replacement is ready.
      account.antigravity_initialization = {
        tokens: { ...pending.tokens, refresh_token: refreshToken },
        identity,
        connection: pending.connection,
        stage: "project",
        tier: "free-tier",
        attempts: 0,
        next_at: Date.now(),
        deadline: Date.now() + PROJECT_INITIALIZATION_TTL_MS,
        error: null,
        last_result: null,
      };
      account.generation++;
      pending.identity = identity;
      pending.status = OAuthSessionStatus.Complete;
      pending.tokens = null;
      pending.state = "";
      pending.verifier = "";
    });
  }
  private async projectFailure(
    generation: number,
    error: unknown,
  ): Promise<void> {
    if (this.account?.generation !== generation) return;
    // Storage/programming faults must reach the alarm runtime; only known
    // upstream failures may change the persisted project's retry state.
    if (!(error instanceof OAuthError)) throw error;
    await this.updateGeneration(generation, (account) => {
      const project = account.antigravity_initialization;
      if (!project) return;
      const now = Date.now();
      if (error.code !== "project_initialization_timeout")
        project.last_result = safeError(error);
      if (error instanceof AntigravityVerificationError) {
        project.error = error.message;
        project.verification = error.verification;
      } else if (now >= project.deadline)
        project.error = projectTimeout(project).message;
      else if (retryableProjectError(error))
        account.antigravity_initialization = scheduleProjectRetry(project, now);
      else project.error = safeError(error);
    });
  }
  private async initializeAntigravityProject(): Promise<void> {
    const snapshot = structuredClone(this.requireAccount());
    const project = snapshot.antigravity_initialization;
    if (!project || project.error) return;
    if (Date.now() >= project.deadline)
      return this.projectFailure(snapshot.generation, projectTimeout(project));

    let client: AntigravityClient;
    let tokens = project.tokens;
    try {
      const selected = await this.configuredConnection(project.connection);
      project.connection = selected.connection;
      client = await this.antigravity(selected.connection, selected.config);
      if (tokens.expires_at <= Date.now() + TOKEN_REFRESH_MARGIN_MS) {
        if (!tokens.refresh_token)
          throw new OAuthError(
            "Reconnect this account to obtain a refresh token",
            401,
            "invalid_grant",
          );
        tokens = { ...tokens, ...(await client.refresh(tokens.refresh_token)) };
      }
    } catch (error) {
      return this.projectFailure(snapshot.generation, error);
    }
    if (tokens !== project.tokens) {
      // Rotated tokens must be durable before any later request can fail.
      await this.updateGeneration(snapshot.generation, (account) => {
        if (account.antigravity_initialization)
          account.antigravity_initialization.tokens = tokens;
      });
      project.tokens = tokens;
    }

    let result: ProjectStep;
    try {
      result = await pollProject(client, project);
    } catch (error) {
      return this.projectFailure(snapshot.generation, error);
    }
    // Keep persistence outside the upstream error handler. A rejected commit
    // is retried by the object runtime, never classified as a Google failure.
    await this.updateGeneration(snapshot.generation, (account) => {
      if (result.kind === "pending") {
        account.antigravity_initialization = scheduleProjectRetry(
          { ...project, ...result.progress },
          Date.now(),
        );
        return;
      }
      account.tokens = project.tokens;
      account.identity = project.identity;
      account.project_id = result.project_id;
      account.connection = project.connection;
      account.status = OAuthAccountStatus.Ready;
      account.error = null;
      account.generation++;
      account.quota = emptyQuota();
      account.models = [];
      account.models_updated_at = null;
      account.models_error = null;
      account.antigravity_initialization = null;
      delete account.models_verification;
    });
  }
  private async retryProject(): Promise<void> {
    await this.updateGeneration(this.requireAccount().generation, (account) => {
      const project = account.antigravity_initialization;
      if (account.provider_type !== ProviderType.Antigravity || !project)
        throw new OAuthError(
          "There is no pending Antigravity project initialization",
          409,
        );
      if (!project.error) return;
      account.generation++;
      project.error = null;
      delete project.verification;
      project.last_result = null;
      project.stage = "project";
      project.attempts = 0;
      project.next_at = Date.now();
      project.deadline = Date.now() + PROJECT_INITIALIZATION_TTL_MS;
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
      initializeCodexAccount(account, session, claims, identity);
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
      initializeClaudeAccount(account, session, profile);
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
      initializeXaiAccount(account, session, claims, tokens);
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
      session.next_at = Date.now();
    });
  }
  private async disconnect(): Promise<void> {
    await this.change((account) => {
      if (!account) throw new OAuthError("Account does not exist", 404);
      account.generation++;
      account.tokens = null;
      account.session = null;
      account.antigravity_initialization = null;
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
      case "claude_limit":
      case "claude_usage":
        if (this.requireAccount().provider_type !== ProviderType.Claude)
          throw new OAuthError("Only available for Claude", 400);
        await this.updateGeneration(command.generation, (account) => {
          account.claude_quota_revision++;
          const observations =
            command.action === "claude_limit"
              ? [command, ...(command.additional_limits ?? [])]
              : (command.limits ?? []);
          if (observations.length) {
            const limits = (account.quota.claude_limits ?? []).filter(
              (limit) => limit.until > Date.now(),
            );
            for (const observation of observations) {
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
          }
          if (command.action === "claude_limit") return;
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
        await this.inventory.refreshModels();
        return this.view();
      case "quota":
        await this.inventory.refreshQuota(command.force);
        return this.view();
      case "disconnect":
        await this.disconnect();
        return this.view();
      case "reset_credits":
        await this.inventory.refreshResetCredits();
        return this.view();
      case "consume_reset":
        return this.inventory.consumeReset(
          command.redeem_request_id,
          command.credit_id,
        );
      case "view":
        return this.view();
      case "readiness":
        try {
          this.active();
          return { ready: true };
        } catch (error) {
          if (
            error instanceof OAuthError &&
            error.code === "oauth_account_unavailable"
          )
            return { ready: false };
          throw error;
        }
      case "retry_project":
        await this.retryProject();
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
    if (
      account.antigravity_initialization &&
      !account.antigravity_initialization.error
    ) {
      try {
        await this.initializeAntigravityProject();
      } catch (error) {
        // Cancellation or reauthorization can supersede an in-flight alarm.
        if (!(error instanceof OAuthError && error.code === "account_changed"))
          throw error;
      }
      return;
    }
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
