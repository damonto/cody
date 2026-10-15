import { accountProvider } from "./registry.ts";
import { TOKEN_REFRESH_MARGIN_MS, type AccountProvider } from "./provider.ts";
import {
  storedSchema,
  freezeAccount,
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
import { accountView } from "./presentation.ts";
import { ControlStore } from "../../control/store.ts";
import { OAuthFlow, OAuthSessionStatus, OAuthAccountStatus } from "./values.ts";
import { CredentialAuthType } from "../../config/values.ts";

import { z } from "zod";
import { decryptConfig, encryptConfig } from "../../control/crypto.ts";
import { equalSecret } from "../../shared/equal-secret.ts";
import { configureLogging, logWarn } from "../../shared/log.ts";
import type { UpstreamFetch } from "../../gateway/transport/index.ts";
import {
  providerConnection,
  providerOutbound,
  currentProxyConfiguration,
} from "../outbound.ts";
import { accountCommandSchema, type AccountCommand } from "./commands.ts";
import {
  OAuthError,
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
    private readonly loadAccount: (
      ciphertext: string,
    ) => Promise<Stored> = async (ciphertext) =>
      storedSchema.parse(
        await decryptConfig(ciphertext, env.CONFIG_ENCRYPTION_KEY),
      ),
  ) {
    this.inventory = new AccountInventory(
      {
        current: () => this.requireAccount(),
        update: (generation, update) =>
          this.updateGeneration(generation, update),
        refresh: (kind, generation, run) =>
          this.shareRefresh(kind, generation, run),
      },
      () => this.provider().inventory,
    );
    void this.ctx.blockConcurrencyWhile(async () => {
      const encrypted = await this.ctx.storage.get<string>("account");
      if (encrypted)
        this.account = freezeAccount(await this.loadAccount(encrypted));
    });
  }
  /** Operator-only restore; the deployment must be quiescent during transfer. */
  async transferReload(): Promise<void> {
    const encrypted = await this.ctx.storage.get<string>("account");
    this.account = encrypted
      ? freezeAccount(
          storedSchema.parse(
            await decryptConfig(encrypted, this.env.CONFIG_ENCRYPTION_KEY),
          ),
        )
      : null;
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
      this.account = freezeAccount(next);
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
    const authorization = this.provider().authorization;
    return {
      id: `${account.account_ref}.${session.id}`,
      account_ref: account.account_ref,
      status: session.status,
      expires_at: session.expires_at,
      url:
        session.status !== OAuthSessionStatus.Pending
          ? null
          : device
            ? (authorization.device?.url(session) ?? null)
            : (authorization.browser?.url(session) ?? null),
      flow: session.flow,
      user_code:
        device && session.status === OAuthSessionStatus.Pending
          ? session.user_code
          : null,
      verification_uri: device
        ? (authorization.device?.url(session) ?? null)
        : null,
      error: session.error,
      can_retry:
        session.status === OAuthSessionStatus.Error &&
        session.tokens !== null &&
        Date.now() < session.expires_at,
      account: this.view(),
    };
  }
  private provider(
    type = this.requireAccount().provider_type,
  ): AccountProvider {
    return accountProvider(
      type,
      {
        current: () => this.requireAccount(),
        update: (generation, update) =>
          this.updateGeneration(generation, update),
        resolve: (rejected) => this.resolve(undefined, undefined, rejected),
      },
      {
        outbound: (connection, config) => this.outbound(connection, config),
        configuredConnection: (fallback) => this.configuredConnection(fallback),
        metadata: this.env,
        context: this.ctx,
      },
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
    const authorization = this.provider(providerType).authorization;
    if (
      flow === OAuthFlow.Device ? !authorization.device : !authorization.browser
    )
      throw new OAuthError(
        "This provider does not support the selected authorization flow",
        400,
      );
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
        (flow === OAuthFlow.Device
          ? authorization.device!.ttlMs
          : SESSION_TTL_MS),
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
    const device = this.provider().authorization.device;
    if (!device)
      throw new OAuthError("Device authorization is unavailable", 400);
    try {
      await device.request(this.session(id, actor));
    } catch (error) {
      await this.failSession(
        generation,
        device.error ? device.error(error) : error,
      );
    }
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
    const browser = this.provider().authorization.browser;
    if (!browser)
      throw new OAuthError("Browser authorization is unavailable", 400);
    const { url, state: normalizedState } = browser.normalizeCallback(redirect);
    if (
      !url ||
      `${url.origin}${url.pathname}` !== browser.redirectUri ||
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
        const tokens = await browser.exchange(code, session);
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
  private active() {
    const account = this.requireAccount();
    if (account.status !== OAuthAccountStatus.Ready || !account.tokens)
      throw new OAuthError(
        "Reconnect this account before sending requests",
        503,
        "oauth_account_unavailable",
      );
    const credential = this.provider().credential();
    return {
      generation: account.generation,
      tokens: account.tokens,
      credential,
    };
  }
  private async resolve(
    connection?: ProviderConnection,
    config?: ProxyConfiguration,
    rejected?: { generation: number; token: string },
  ) {
    const snapshot = this.active();
    if (
      rejected &&
      (!this.provider().recoverUnauthorized ||
        snapshot.generation !== rejected.generation)
    )
      throw new OAuthError(
        "Account changed during authentication recovery",
        409,
        "account_changed",
      );
    if (
      connection &&
      connection.provider_id !== this.requireAccount().provider_id
    )
      throw new OAuthError("Account belongs to another provider", 403);
    const force =
      rejected &&
      (await equalSecret(snapshot.tokens.access_token, rejected.token));
    // Another request may already have replaced the rejected token. Reuse it.
    if (
      force ||
      (!rejected &&
        snapshot.tokens.expires_at <= Date.now() + TOKEN_REFRESH_MARGIN_MS)
    ) {
      await this.shareRefresh("token", snapshot.generation, async () => {
        const current = this.active();
        if (current.generation !== snapshot.generation)
          throw new OAuthError(
            "Account changed during token refresh",
            409,
            "account_changed",
          );
        if (
          !(await equalSecret(
            current.tokens.access_token,
            snapshot.tokens.access_token,
          ))
        )
          return;
        try {
          const refreshToken = snapshot.tokens.refresh_token;
          if (!refreshToken)
            throw new OAuthError(
              "Reconnect this account to obtain a refresh token",
              503,
              "invalid_grant",
            );
          await this.provider().refresh(
            snapshot.generation,
            { ...snapshot.tokens, refresh_token: refreshToken },
            connection,
            config,
          );
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
    if (current.generation !== snapshot.generation)
      throw new OAuthError(
        "Account changed during token resolution",
        409,
        "account_changed",
      );
    return current.credential;
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
      case "codex_usage":
      case "xai_auth_invalid":
      case "xai_limit":
      case "claude_limit":
      case "claude_usage": {
        const provider = this.provider();
        if (!provider.observe)
          throw new OAuthError("Unsupported account observation", 400);
        await provider.observe(command);
        return command.action === "codex_usage"
          ? { observed: true }
          : this.view();
      }
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
      case "codex_refresh":
        return this.resolve(
          command.connection,
          command.proxy_configuration,
          command,
        );
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
      case "reset_credits": {
        const resets = this.provider().resets;
        if (!resets)
          throw new OAuthError("Account resets are unavailable", 400);
        await resets.refresh();
        return this.view();
      }
      case "consume_reset": {
        const resets = this.provider().resets;
        if (!resets)
          throw new OAuthError("Account resets are unavailable", 400);
        const result = await resets.consume(
          command.redeem_request_id,
          command.credit_id,
        );
        await this.inventory.refreshQuota(true);
        return { result, account: this.view() };
      }
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
      case "retry_project": {
        const background = this.provider().background;
        if (!background)
          throw new OAuthError("Account initialization cannot be retried", 409);
        await background.retry();
        return this.view();
      }
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
    const provider = this.provider();
    if (provider.background?.pending()) {
      try {
        await provider.background.run();
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
        await provider.authorization.device?.poll();
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
        await provider.authorization.initialize();
      } catch (error) {
        await this.failSession(account.generation, error);
      }
    }
  }
}
