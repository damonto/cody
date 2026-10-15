import { ProviderType } from "../../config/values.ts";
import { OAuthSessionStatus, OAuthAccountStatus } from "../oauth/values.ts";
import {
  OAuthError,
  type ProviderConnection,
  type ProxyConfiguration,
} from "../oauth/schema.ts";
import type {
  AccountProvider,
  AccountState,
  AccountServices,
} from "../oauth/provider.ts";
import {
  browserCallback,
  authorizationTokens,
  TOKEN_REFRESH_MARGIN_MS,
  unavailableIdentity,
} from "../oauth/provider.ts";
import { emptyQuota, safeError } from "../oauth/state.ts";
import {
  ANTIGRAVITY_REDIRECT_URI,
  AntigravityClient,
  authorizationUrl,
} from "./api.ts";
import { antigravityVersion } from "./version.ts";
import { AntigravityVerificationError } from "./verification.ts";
import {
  PROJECT_INITIALIZATION_TTL_MS,
  projectInitializationSchema,
  pollProject,
  scheduleProjectRetry,
  retryableProjectError,
  projectTimeout,
  type ProjectStep,
} from "./initialization.ts";
import { AntigravityInventory } from "./inventory.ts";

export function antigravityAccount(
  state: AccountState<typeof ProviderType.Antigravity>,
  services: AccountServices,
): AccountProvider {
  const client = async (
    connection?: ProviderConnection,
    config?: ProxyConfiguration,
  ) => {
    const [send, signal] = await services.outbound(connection, config);
    return new AntigravityClient(
      send,
      signal,
      await antigravityVersion(
        services.metadata.CODY_CONFIG_KV,
        services.context,
      ),
    );
  };
  async function projectFailure(
    generation: number,
    error: unknown,
  ): Promise<void> {
    if (state.current().authorization_generation !== generation) return;
    // Storage/programming faults must reach the alarm runtime; only known
    // upstream failures may change the persisted project's retry state.
    if (!(error instanceof OAuthError)) throw error;
    await state.updateAuthorization(generation, (account) => {
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
  async function initializeProject(): Promise<void> {
    const snapshot = state.current();
    if (
      !snapshot.antigravity_initialization ||
      snapshot.antigravity_initialization.error
    )
      return;
    const project = projectInitializationSchema.parse(
      snapshot.antigravity_initialization,
    );
    if (project.inherit_refresh_token === undefined) {
      try {
        await state.updateAuthorization(
          snapshot.authorization_generation,
          async (account) => {
            const pending = account.antigravity_initialization;
            if (!pending || pending.inherit_refresh_token !== undefined) return;
            if (!account.tokens) {
              pending.inherit_refresh_token = false;
              return;
            }
            const tokens = await authorizationTokens(
              pending.tokens,
              account.tokens,
            );
            if (!tokens.refresh_token && pending.tokens.refresh_token) {
              pending.tokens = tokens;
              pending.inherit_refresh_token = true;
              return;
            }
            throw new OAuthError(
              "Start authorization again to finish connecting this account",
              409,
              "project_token_source_unknown",
            );
          },
        );
      } catch (error) {
        return projectFailure(snapshot.authorization_generation, error);
      }
      return initializeProject();
    }
    if (Date.now() >= project.deadline)
      return projectFailure(
        snapshot.authorization_generation,
        projectTimeout(project),
      );

    let projectClient: AntigravityClient;
    let tokens = project.tokens;
    try {
      const selected = await services.configuredConnection(project.connection);
      project.connection = selected.connection;
      projectClient = await client(selected.connection, selected.config);
      if (tokens.expires_at <= Date.now() + TOKEN_REFRESH_MARGIN_MS) {
        if (project.inherit_refresh_token) {
          // A borrowed refresh token belongs to the active lifecycle. Resolve
          // through it so provisioning never rotates a second copy in parallel.
          await state.resolve();
          const active = state.current().tokens;
          if (!active) return unavailableIdentity();
          tokens = { ...active, refresh_token: undefined };
        } else if (!tokens.refresh_token)
          throw new OAuthError(
            "Reconnect this account to obtain a refresh token",
            401,
            "invalid_grant",
          );
        else
          tokens = {
            ...tokens,
            ...(await projectClient.refresh(tokens.refresh_token)),
          };
      }
    } catch (error) {
      return projectFailure(snapshot.authorization_generation, error);
    }
    if (tokens !== project.tokens) {
      // Rotated tokens must be durable before any later request can fail.
      await state.updateAuthorization(
        snapshot.authorization_generation,
        (account) => {
          if (account.antigravity_initialization)
            account.antigravity_initialization.tokens = tokens;
        },
      );
      project.tokens = tokens;
    }

    let result: ProjectStep;
    try {
      result = await pollProject(projectClient, project);
    } catch (error) {
      return projectFailure(snapshot.authorization_generation, error);
    }
    // Keep persistence outside the upstream error handler. A rejected commit
    // is retried by the object runtime, never classified as a Google failure.
    if (result.kind === "pending")
      return state.updateAuthorization(
        snapshot.authorization_generation,
        (account) => {
          account.antigravity_initialization = scheduleProjectRetry(
            { ...project, ...result.progress },
            Date.now(),
          );
        },
      );
    await state.replaceCredentials(
      snapshot.authorization_generation,
      project.inherit_refresh_token === true,
      (account) => {
        account.tokens = project.inherit_refresh_token
          ? { ...project.tokens, refresh_token: account.tokens?.refresh_token }
          : project.tokens;
        account.identity = project.identity;
        account.project_id = result.project_id;
        account.connection = project.connection;
        account.status = OAuthAccountStatus.Ready;
        account.error = null;
        account.generation++;
        account.authorization_generation++;
        account.quota = emptyQuota();
        account.models = [];
        account.models_updated_at = null;
        account.models_error = null;
        account.antigravity_initialization = null;
        delete account.models_verification;
      },
    );
  }
  async function retryProject(): Promise<void> {
    await state.updateAuthorization(
      state.current().authorization_generation,
      (account) => {
        const project = account.antigravity_initialization;
        if (account.provider_type !== ProviderType.Antigravity || !project)
          throw new OAuthError(
            "There is no pending Antigravity project initialization",
            409,
          );
        if (!project.error) return;
        account.authorization_generation++;
        project.error = null;
        delete project.verification;
        project.last_result = null;
        project.stage = "project";
        project.attempts = 0;
        project.next_at = Date.now();
        project.deadline = Date.now() + PROJECT_INITIALIZATION_TTL_MS;
      },
    );
  }

  return {
    authorization: {
      browser: {
        redirectUri: ANTIGRAVITY_REDIRECT_URI,
        url: (session) => authorizationUrl(session.state, session.challenge),
        normalizeCallback: browserCallback,
        exchange: async (code, session) =>
          (await client(session.connection)).exchange(code, session.verifier),
      },
      async initialize() {
        const snapshot = state.current();
        const session = snapshot.session;
        if (
          !session?.tokens ||
          session.status !== OAuthSessionStatus.Initializing
        )
          return;
        const identity =
          session.identity ??
          (await (
            await client(session.connection)
          ).userInfo(session.tokens.access_token));
        if (snapshot.identity && snapshot.identity.id !== identity.id)
          throw new OAuthError(
            "This is a different Google account; add it as a new account instead",
          );
        await state.updateAuthorization(
          snapshot.authorization_generation,
          async (account) => {
            const pending = account.session;
            if (
              !pending ||
              pending.id !== session.id ||
              pending.status !== OAuthSessionStatus.Initializing ||
              !pending.tokens
            )
              throw new OAuthError("Authorization was cancelled", 409);
            if (Date.now() >= pending.expires_at)
              throw new OAuthError(
                "Authorization session expired; start again",
                410,
              );
            const tokens = await authorizationTokens(
              pending.tokens,
              snapshot.tokens,
              account.tokens,
            );
            const refreshToken =
              tokens.refresh_token ?? account.tokens?.refresh_token;
            if (!refreshToken)
              throw new OAuthError(
                "Google did not return a refresh token; start authorization again",
              );
            // The OAuth session can finish while project provisioning continues durably.
            // Keep a working account's credentials until the replacement is ready.
            account.antigravity_initialization = {
              tokens,
              inherit_refresh_token: !tokens.refresh_token,
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
            account.authorization_generation++;
            pending.identity = identity;
            pending.status = OAuthSessionStatus.Complete;
            pending.tokens = null;
            pending.state = "";
            pending.verifier = "";
          },
        );
      },
    },
    async refresh(generation, tokens, connection, config) {
      const result = await (
        await client(connection, config)
      ).refresh(tokens.refresh_token);
      await state.update(generation, (account) => {
        account.tokens = {
          ...result,
          refresh_token: result.refresh_token ?? tokens.refresh_token,
        };
        account.error = null;
      });
    },
    inventory: new AntigravityInventory(state, client),
    background: {
      pending: () => {
        const project = state.current().antigravity_initialization;
        return !!project && !project.error;
      },
      run: initializeProject,
      retry: retryProject,
    },
  };
}
