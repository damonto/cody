import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { configurationSchema } from "../../config/schema.ts";
import { decryptConfig, encryptConfig } from "../../control/crypto.ts";
import { configureLogging, logWarn } from "../../shared/log.ts";
import {
  ANTIGRAVITY_REDIRECT_URI,
  AntigravityClient,
  authorizationUrl,
  defaultTier,
  object,
  parseModels,
  parseQuota,
  parseSubscription,
  projectId,
} from "../antigravity/api.ts";
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
  quotaSnapshotSchema,
  sessionStatusSchema,
  tokenSchema,
  type AccountReply,
  type AccountView,
  type ProviderConnection,
  type ProxyConfiguration,
  type QuotaSnapshot,
  type SessionView,
} from "./schema.ts";

const SESSION_TTL_MS = 10 * 60_000;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const QUOTA_CACHE_TTL_MS = 60_000;
type AccountEnv = Pick<
  Env,
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
});
const storedSchema = z.object({
  account_ref: z.uuid(),
  provider_id: z.string(),
  generation: z.number(),
  status: z.enum(["disconnected", "ready", "needs_reauthorization"]),
  connection: connectionSchema,
  tokens: tokenSchema.nullable(),
  identity: identitySchema.nullable(),
  project_id: z.string().nullable(),
  error: z.string().nullable(),
  session: sessionSchema.nullable(),
  models: accountViewSchema.shape.models,
  models_updated_at: z.number().nullable(),
  models_error: z.string().nullable(),
  quota: quotaSnapshotSchema,
});
type Stored = z.output<typeof storedSchema>;
type Session = z.output<typeof sessionSchema>;
const emptyQuota = (): Stored["quota"] => ({
  groups: [],
  subscription: null,
  updated_at: null,
  last_error: null,
  stale: true,
});
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
async function equalState(a: string, b: string): Promise<boolean> {
  const hash = (text: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const [left, right] = await Promise.all([hash(a), hash(b)]);
  return crypto.subtle.timingSafeEqual(left, right);
}

/** One account owns its token lifecycle. Inference streams never pass through this object. */
export class ProviderOAuthAccount extends DurableObject<AccountEnv> {
  private account: Stored | null = null;
  private mutations: Promise<unknown> = Promise.resolve();
  private readonly refreshes = new Map<RefreshKind, PendingRefresh>();
  constructor(ctx: DurableObjectState, env: AccountEnv) {
    super(ctx, env);
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
        session &&
        !["complete", "cancelled", "expired"].includes(session.status)
          ? Math.min(
              session.expires_at,
              session.status === "initializing"
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
      account.status === "disconnected" && session
        ? session.status === "initializing"
          ? "initializing"
          : ["pending", "exchanging"].includes(session.status)
            ? "authorizing"
            : account.status
        : account.status;
    return {
      account_ref: account.account_ref,
      provider_id: account.provider_id,
      status,
      email: account.identity?.email ?? null,
      project_id: account.project_id,
      expires_at: account.tokens?.expires_at ?? null,
      error: account.error,
      models: account.models,
      models_updated_at: account.models_updated_at,
      models_error: account.models_error,
      quota: {
        ...account.quota,
        stale:
          account.status !== "ready" ||
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
      ["complete", "cancelled", "expired"].includes(session.status)
    )
      return;
    await this.change((account) => {
      if (!account) throw new OAuthError("Account does not exist", 404);
      const current = account.session;
      if (
        current &&
        Date.now() >= current.expires_at &&
        !["complete", "cancelled", "expired"].includes(current.status)
      ) {
        account.generation++;
        current.status = "expired";
        current.tokens = null;
        current.verifier = "";
        current.state = "";
      }
      return account;
    });
  }
  private sessionView(id: string, actor: string): SessionView {
    const session = this.session(id, actor);
    return {
      id: `${this.requireAccount().account_ref}.${session.id}`,
      account_ref: this.requireAccount().account_ref,
      status: session.status,
      expires_at: session.expires_at,
      url:
        session.status === "pending"
          ? authorizationUrl(session.state, session.challenge)
          : null,
      error: session.error,
      can_retry:
        session.status === "error" &&
        session.tokens !== null &&
        Date.now() < session.expires_at,
      account: this.view(),
    };
  }
  private async client(
    connection?: ProviderConnection,
    config?: ProxyConfiguration,
  ): Promise<AntigravityClient> {
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
            provider.type === "antigravity",
        );
        const credential = provider?.credentials.find(
          (credential) =>
            credential.auth.type === "oauth" &&
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
    return new AntigravityClient(
      providerOutbound(selected, network, this.env, signal).send,
      signal,
    );
  }
  private async start(
    accountRef: string,
    actor: string,
    connection: ProviderConnection,
  ): Promise<SessionView> {
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
      status: "pending",
      state: base64url(crypto.getRandomValues(new Uint8Array(32))),
      verifier,
      challenge,
      expires_at: Date.now() + SESSION_TTL_MS,
      connection,
      error: null,
      tokens: null,
      identity: null,
      stage: "identity",
      tier: "free-tier",
      attempts: 0,
      next_at: Date.now(),
    };
    await this.change((account) => {
      if (
        account &&
        (account.account_ref !== accountRef ||
          account.provider_id !== connection.provider_id)
      )
        throw new OAuthError("Account belongs to another provider", 403);
      account ??= {
        account_ref: accountRef,
        provider_id: connection.provider_id,
        generation: 0,
        status: "disconnected",
        connection,
        tokens: null,
        identity: null,
        project_id: null,
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
      "INSERT OR IGNORE INTO oauth_accounts (account_ref, provider_id, provider_type, created_at) VALUES (?, ?, 'antigravity', ?)",
    )
      .bind(accountRef, connection.provider_id, Date.now())
      .run();
    return this.sessionView(session.id, actor);
  }
  private async complete(
    id: string,
    actor: string,
    redirect: string,
  ): Promise<SessionView> {
    const session = this.session(id, actor);
    const generation = this.requireAccount().generation;
    if (
      ["expired", "cancelled"].includes(session.status) ||
      Date.now() >= session.expires_at
    )
      throw new OAuthError(
        "Authorization session expired or was cancelled; start again",
        410,
      );
    if (session.status !== "pending")
      throw new OAuthError(
        "Authorization callback was already submitted; check the session status",
        409,
      );
    const url = URL.parse(redirect);
    if (
      !url ||
      `${url.origin}${url.pathname}` !== ANTIGRAVITY_REDIRECT_URI ||
      url.username ||
      url.password ||
      url.hash ||
      url.searchParams.getAll("state").length !== 1 ||
      !(await equalState(url.searchParams.get("state") ?? "", session.state))
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
      if (pending.status !== "pending")
        throw new OAuthError("Authorization is already being processed", 409);
      if (Date.now() >= pending.expires_at)
        throw new OAuthError("Authorization session expired; start again", 410);
      pending.status = "exchanging";
    });
    const operation = (async () => {
      try {
        const tokens = await (
          await this.client(session.connection)
        ).exchange(code, session.verifier);
        await this.updateGeneration(generation, (account) => {
          const pending = this.ownedSession(account, id, actor);
          if (
            pending.status !== "exchanging" ||
            Date.now() >= pending.expires_at
          )
            throw new OAuthError(
              "Authorization session is no longer active",
              410,
            );
          pending.tokens = tokens;
          pending.verifier = "";
          pending.status = "initializing";
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
      account.session.status = "error";
      account.session.error = safeError(error);
      account.session.verifier = "";
    });
  }
  private async cancel(id: string, actor: string): Promise<void> {
    this.session(id, actor);
    await this.change((account) => {
      if (!account) throw new OAuthError("Account does not exist", 404);
      const session = this.ownedSession(account, id, actor);
      if (session.status === "complete")
        throw new OAuthError(
          "Authorization is complete; disconnect the account instead",
          409,
        );
      account.generation++;
      session.status = "cancelled";
      session.tokens = null;
      session.verifier = "";
      session.state = "";
      return account;
    });
  }
  private async initialize(): Promise<void> {
    const snapshot = structuredClone(this.requireAccount());
    const session = snapshot.session;
    if (!session?.tokens || session.status !== "initializing") return;
    const client = await this.client(session.connection);
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
        pending.status !== "initializing" ||
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
        account.status = "ready";
        account.error = null;
        account.generation++;
        account.quota = emptyQuota();
        account.models = [];
        account.models_updated_at = null;
        account.models_error = null;
        pending.status = "complete";
        pending.tokens = null;
        pending.state = "";
        pending.verifier = "";
      }
    });
  }
  private active() {
    const account = this.requireAccount();
    if (account.status !== "ready" || !account.tokens || !account.project_id)
      throw new OAuthError(
        "Reconnect this account before sending requests",
        503,
        "oauth_account_unavailable",
      );
    return {
      generation: account.generation,
      tokens: account.tokens,
      project_id: account.project_id,
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
          const result = await (
            await this.client(connection, config)
          ).refresh(refreshToken);
          await this.updateGeneration(snapshot.generation, (account) => {
            account.tokens = {
              ...result,
              refresh_token: result.refresh_token ?? refreshToken,
            };
            account.error = null;
          });
        } catch (error) {
          if (this.account?.generation === snapshot.generation)
            await this.updateGeneration(snapshot.generation, (account) => {
              account.error = safeError(error);
              if (error instanceof OAuthError && error.code === "invalid_grant")
                account.status = "needs_reauthorization";
            });
          throw error;
        }
      });
    }
    const current = this.active();
    return {
      token: current.tokens.access_token,
      project_id: current.project_id,
    };
  }
  private refreshModels(): Promise<void> {
    const generation = this.requireAccount().generation;
    return this.shareRefresh("models", generation, async () => {
      try {
        const token = await this.resolve();
        const models = parseModels(
          await (await this.client()).models(token.token, token.project_id),
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
        let groups: QuotaSnapshot["groups"] | undefined;
        let subscription: QuotaSnapshot["subscription"] | undefined;
        let lastError: string | null = null;
        // Independent transports, serialized so a six-account batch has at most six requests in flight.
        // Preparation and parsing belong to each operation's failure boundary too.
        try {
          groups = parseQuota(
            await (await this.client()).quota(token.token, token.project_id),
          );
        } catch (error) {
          lastError = safeError(error);
        }
        try {
          subscription = parseSubscription(
            await (await this.client()).load(token.token),
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
  private async retry(id: string, actor: string): Promise<void> {
    await this.updateGeneration(this.requireAccount().generation, (account) => {
      const session = this.ownedSession(account, id, actor);
      if (
        session.status !== "error" ||
        !session.tokens ||
        Date.now() >= session.expires_at
      )
        throw new OAuthError("Start a new authorization session", 409);
      session.status = "initializing";
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
      account.status = "disconnected";
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
  override async alarm(): Promise<void> {
    await this.expireSession();
    const account = this.requireAccount();
    const session = account.session;
    if (!session) return;
    if (session.status === "initializing") {
      try {
        await this.initialize();
      } catch (error) {
        await this.failSession(account.generation, error);
      }
    }
  }
}
