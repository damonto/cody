import { z } from "zod";
import { readBodyWithinLimit } from "../../gateway/http/body.ts";
import type { UpstreamFetch } from "../../gateway/transport/index.ts";
import { logWarn } from "../../shared/log.ts";
import {
  OAuthError,
  consumeResetResultSchema,
  type AccountModel,
  type ConsumeResetResult,
  type QuotaSnapshot,
  type ResetCredits,
} from "../oauth/schema.ts";

export const CODEX_ISSUER = "https://auth.openai.com";
// Public Codex CLI OAuth registration, not an account credential.
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const CODEX_DEVICE_REDIRECT_URI = `${CODEX_ISSUER}/deviceauth/callback`;
export const CODEX_VERIFICATION_URI = `${CODEX_ISSUER}/codex/device`;
export const CHATGPT_BACKEND = "https://chatgpt.com/backend-api";
export const CODEX_BASE = `${CHATGPT_BACKEND}/codex`;
/** Account model discovery must not be filtered by an old client version. */
export const CODEX_CLIENT_VERSION = "0.999.0";
const CODEX_USER_AGENT = "codex-cli";
const SCOPE =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";
/** Device codes expire after 15 minutes on the issuer. */
export const CODEX_DEVICE_TTL_MS = 15 * 60_000;
const PERMANENT_REFRESH_CODES = new Set([
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
]);

export function authorizationUrl(state: string, challenge: string): string {
  const url = new URL(`${CODEX_ISSUER}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_CLIENT_ID,
    redirect_uri: CODEX_REDIRECT_URI,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "codex_cli_rs",
  }).toString();
  return url.toString();
}

const objectSchema = z.record(z.string(), z.unknown());
function object(value: unknown): Record<string, unknown> {
  const result = objectSchema.safeParse(value);
  return result.success ? result.data : {};
}
function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
function finite(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

/** Decode a JWT payload without verifying it; the issuer delivered it over TLS. */
export function jwtClaims(token: string): Record<string, unknown> {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return {};
  try {
    const padded = payload.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return object(
      JSON.parse(
        new TextDecoder().decode(
          Uint8Array.from(binary, (char) => char.charCodeAt(0)),
        ),
      ),
    );
  } catch {
    return {};
  }
}

export interface CodexIdentity {
  readonly email: string | null;
  readonly is_fedramp?: boolean;
  readonly account_id: string;
  readonly user_id: string | null;
  readonly plan_type: string | null;
  readonly subscription_active_until: string | null;
}
export function parseIdToken(idToken: string): CodexIdentity {
  const claims = jwtClaims(idToken);
  const auth = object(claims["https://api.openai.com/auth"]);
  const profile = object(claims["https://api.openai.com/profile"]);
  const email = str(claims.email) ?? str(profile.email);
  const accountId = str(auth.chatgpt_account_id);
  if (!accountId)
    throw new OAuthError(
      "The ChatGPT sign-in did not include a workspace account; sign in again",
      502,
    );
  const until = auth.chatgpt_subscription_active_until;
  return {
    email,
    account_id: accountId,
    ...(auth.chatgpt_account_is_fedramp === true ? { is_fedramp: true } : {}),
    user_id: str(auth.chatgpt_user_id) ?? str(auth.user_id),
    plan_type: str(auth.chatgpt_plan_type),
    subscription_active_until:
      str(until) ??
      (finite(until) === null
        ? null
        : new Date(finite(until)! * 1000).toISOString()),
  };
}

const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
});
function tokens(data: z.output<typeof tokenResponse>) {
  const exp = finite(jwtClaims(data.access_token).exp);
  return {
    access_token: data.access_token,
    ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
    ...(data.id_token ? { id_token: data.id_token } : {}),
    expires_at:
      exp !== null ? exp * 1000 : Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

export interface DeviceGrant {
  readonly device_auth_id: string;
  readonly user_code: string;
  readonly interval_ms: number;
}
export interface DeviceAuthorization {
  readonly code: string;
  readonly verifier: string;
}

function windowName(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds === 18_000) return "5h";
  if (seconds === 604_800) return "weekly";
  const days = seconds / 86_400;
  if (days >= 28 && days <= 31) return "monthly";
  if (seconds % 86_400 === 0) return `${days}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.round(seconds / 60)}m`;
}
const WINDOW_LABELS: Record<string, string> = {
  "5h": "5-hour limit",
  weekly: "Weekly limit",
  monthly: "Monthly limit",
};
function parseLimit(
  id: string,
  label: string,
  value: unknown,
  model: string | null = null,
): QuotaSnapshot["groups"][number] | null {
  const limit = object(value);
  if (!Object.keys(limit).length) return null;
  const buckets = (["primary_window", "secondary_window"] as const).flatMap(
    (key) => {
      const window = object(limit[key]);
      const used = finite(window.used_percent);
      if (used === null) return [];
      const seconds = finite(window.limit_window_seconds);
      const name = windowName(seconds);
      const resetAt = finite(window.reset_at);
      const resetAfter = finite(window.reset_after_seconds);
      return [
        {
          id: key === "primary_window" ? "primary" : "secondary",
          label:
            (name && WINDOW_LABELS[name]) ??
            (name ? `${name} limit` : "Usage limit"),
          window: name,
          window_seconds: seconds,
          used_percent: used,
          remaining_fraction: Math.min(1, Math.max(0, 1 - used / 100)),
          reset_at:
            resetAt !== null
              ? new Date(resetAt * 1000).toISOString()
              : resetAfter !== null
                ? new Date(Date.now() + resetAfter * 1000).toISOString()
                : null,
        },
      ];
    },
  );
  return {
    id,
    label,
    buckets,
    limit_reached: limit.limit_reached === true || limit.allowed === false,
    model,
  };
}

export interface CodexUsage {
  readonly groups: QuotaSnapshot["groups"];
  readonly plan_type: string | null;
  readonly limit_reached: boolean;
  readonly credits_balance: QuotaSnapshot["credits_balance"];
  readonly available_resets: number | null;
}
/** Map `GET /wham/usage` to the shared account quota snapshot. */
export function parseUsage(value: unknown): CodexUsage {
  const data = object(value);
  if (!("rate_limit" in data) && !("plan_type" in data))
    throw new OAuthError("Usage response has no rate-limit status", 502);
  const groups = [
    parseLimit("codex", "Codex", data.rate_limit),
    parseLimit("code_review", "Code review", data.code_review_rate_limit),
    ...(Array.isArray(data.additional_rate_limits)
      ? data.additional_rate_limits
      : []
    ).map((value, index) => {
      const extra = object(value);
      const name =
        str(extra.limit_name) ?? str(extra.metered_feature) ?? `limit-${index}`;
      return parseLimit(
        str(extra.metered_feature) ?? name,
        name,
        extra.rate_limit,
        str(extra.normal_model_slug),
      );
    }),
  ].filter((group) => group !== null);
  const credits = object(data.credits);
  const main = object(data.rate_limit);
  return {
    groups,
    plan_type: str(data.plan_type),
    limit_reached: main.limit_reached === true || main.allowed === false,
    credits_balance: Object.keys(credits).length
      ? {
          has_credits: credits.has_credits === true,
          unlimited: credits.unlimited === true,
          // The backend reports the balance as a decimal string or number.
          balance:
            str(credits.balance) ??
            (typeof credits.balance === "number"
              ? String(credits.balance)
              : null),
        }
      : null,
    available_resets: finite(
      object(data.rate_limit_reset_credits).available_count,
    ),
  };
}

/** Credits are `available`, `redeeming` or `redeemed`; only the first can be spent. */
export function creditAvailable(credit: { status: string | null }): boolean {
  return credit.status?.toLowerCase() === "available";
}

export function parseResetCredits(
  value: unknown,
): Omit<ResetCredits, "updated_at" | "error"> {
  const data = object(value);
  const credits = (Array.isArray(data.credits) ? data.credits : []).flatMap(
    (value) => {
      const credit = object(value);
      const id = str(credit.id);
      return id
        ? [
            {
              id,
              reset_type: str(credit.reset_type),
              status: str(credit.status),
              granted_at: str(credit.granted_at),
              expires_at: str(credit.expires_at),
              title: str(credit.title),
              description: str(credit.description),
            },
          ]
        : [];
    },
  );
  return {
    available_count: Math.max(
      0,
      Math.trunc(
        finite(data.available_count) ?? credits.filter(creditAvailable).length,
      ),
    ),
    credits,
  };
}

export function parseModels(value: unknown): AccountModel[] {
  const models = object(value).models;
  if (!Array.isArray(models))
    throw new OAuthError("Model response has no model list", 502);
  return models.flatMap((value) => {
    const model = object(value);
    const slug = str(model.slug);
    if (!slug) return [];
    const context = finite(model.context_window);
    const modalities = Array.isArray(model.input_modalities)
      ? model.input_modalities
      : null;
    return [
      {
        id: slug,
        display_name: str(model.display_name) ?? slug,
        input_token_limit: context !== null && context > 0 ? context : null,
        output_token_limit: null,
        supports_thinking: Array.isArray(model.supported_reasoning_levels)
          ? model.supported_reasoning_levels.length > 0
          : null,
        supports_images: modalities ? modalities.includes("image") : null,
      },
    ];
  });
}

/** Every operation receives the provider transport; no OAuth request silently uses global fetch. */
export class CodexClient {
  constructor(
    private readonly send: UpstreamFetch,
    private readonly signal: AbortSignal = new AbortController().signal,
    private readonly isFedramp = false,
  ) {}
  private async json(
    url: string,
    init: RequestInit,
    operation: string,
    pending: readonly number[] = [],
  ): Promise<unknown> {
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new Error("Codex operation timed out")),
      15_000,
    );
    const signal = AbortSignal.any([this.signal, deadline.signal]);
    try {
      const response = await this.send(
        new Request(url, { ...init, signal, redirect: "manual" }),
      );
      const bytes = await readBodyWithinLimit(
        response.body,
        8 * 1024 * 1024,
        response.headers.get("content-length"),
        undefined,
        signal,
      );
      if (pending.includes(response.status)) return undefined;
      let data: unknown;
      try {
        data = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        if (response.ok)
          throw new OAuthError(
            `${operation} returned an invalid response`,
            502,
          );
      }
      if (!response.ok) {
        const error = object(data).error;
        const code =
          str(error) ?? str(object(error).code) ?? str(object(data).code);
        logWarn("oauth.upstream.failed", {
          operation,
          status: response.status,
          url: url.split("?")[0],
          upstream_error: code ?? str(object(error).message),
        });
        throw new OAuthError(
          `${operation} failed (HTTP ${response.status})`,
          response.status,
          code ?? "upstream_error",
        );
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
  private backend(
    path: string,
    token: string,
    accountId: string,
    operation: string,
    init: RequestInit = {},
  ) {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    headers.set("authorization", `Bearer ${token}`);
    headers.set("chatgpt-account-id", accountId);
    if (this.isFedramp) headers.set("x-openai-fedramp", "true");
    headers.set("user-agent", CODEX_USER_AGENT);
    return this.json(
      `${CHATGPT_BACKEND}${path}`,
      { ...init, headers },
      operation,
    );
  }
  async exchange(code: string, verifier: string, redirectUri: string) {
    return tokens(
      tokenResponse.required({ refresh_token: true, id_token: true }).parse(
        await this.json(
          `${CODEX_ISSUER}/oauth/token`,
          {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code,
              redirect_uri: redirectUri,
              client_id: CODEX_CLIENT_ID,
              code_verifier: verifier,
            }),
          },
          "Token exchange",
        ),
      ),
    );
  }
  async refresh(
    refreshToken: string,
    previous?: z.output<typeof tokenResponse> & { expires_at: number },
  ) {
    try {
      const data = tokenResponse.partial().parse(
        await this.json(
          `${CODEX_ISSUER}/oauth/token`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              client_id: CODEX_CLIENT_ID,
              grant_type: "refresh_token",
              refresh_token: refreshToken,
            }),
          },
          "Token refresh",
        ),
      );
      const accessToken = data.access_token ?? previous?.access_token;
      if (!accessToken)
        throw new OAuthError("Token refresh returned no access token", 502);
      return {
        ...previous,
        ...tokens({ ...data, access_token: accessToken }),
        ...(!data.access_token && previous
          ? { expires_at: previous.expires_at }
          : {}),
      };
    } catch (error) {
      if (
        error instanceof OAuthError &&
        (error.status === 401 ||
          (error.status === 400 &&
            error.code.toLowerCase() === "invalid_grant") ||
          PERMANENT_REFRESH_CODES.has(error.code.toLowerCase()))
      )
        throw new OAuthError(
          "ChatGPT authorization expired or was revoked; reconnect this account",
          error.status,
          "invalid_grant",
        );
      // The account core uses invalid_grant as the reauthorization signal.
      // An unexpected status with that code must remain a transient failure.
      if (
        error instanceof OAuthError &&
        error.code.toLowerCase() === "invalid_grant"
      )
        throw new OAuthError(error.message, error.status, "upstream_error");
      throw error;
    }
  }
  async startDevice(): Promise<DeviceGrant> {
    const data = object(
      await this.json(
        `${CODEX_ISSUER}/api/accounts/deviceauth/usercode`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
        },
        "Device code request",
      ),
    );
    const id = str(data.device_auth_id);
    const code = str(data.user_code) ?? str(data.usercode);
    if (!id || !code)
      throw new OAuthError("Device code response is incomplete", 502);
    const interval = finite(data.interval);
    return {
      device_auth_id: id,
      user_code: code,
      interval_ms: Math.min(60, Math.max(1, interval ?? 5)) * 1000,
    };
  }
  /** Returns null while the user has not approved the code yet. */
  async pollDevice(
    grant: Pick<DeviceGrant, "device_auth_id" | "user_code">,
  ): Promise<DeviceAuthorization | null> {
    const data = await this.json(
      `${CODEX_ISSUER}/api/accounts/deviceauth/token`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          device_auth_id: grant.device_auth_id,
          user_code: grant.user_code,
        }),
      },
      "Device authorization",
      [403, 404],
    );
    if (data === undefined) return null;
    const result = object(data);
    const code = str(result.authorization_code);
    const verifier = str(result.code_verifier);
    if (!code || !verifier)
      throw new OAuthError("Device authorization response is incomplete", 502);
    return { code, verifier };
  }
  models(token: string, accountId: string) {
    return this.json(
      `${CODEX_BASE}/models?client_version=${CODEX_CLIENT_VERSION}`,
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "chatgpt-account-id": accountId,
          ...(this.isFedramp ? { "x-openai-fedramp": "true" } : {}),
          "user-agent": CODEX_USER_AGENT,
        },
      },
      "Codex models",
    );
  }
  usage(token: string, accountId: string) {
    return this.backend("/wham/usage", token, accountId, "Codex usage");
  }
  resetCredits(token: string, accountId: string) {
    return this.backend(
      "/wham/rate-limit-reset-credits",
      token,
      accountId,
      "Codex reset credits",
    );
  }
  async consumeReset(
    token: string,
    accountId: string,
    redeemRequestId: string,
    creditId?: string,
  ): Promise<ConsumeResetResult> {
    return consumeResetResultSchema.parse(
      await this.backend(
        "/wham/rate-limit-reset-credits/consume",
        token,
        accountId,
        "Codex reset",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            redeem_request_id: redeemRequestId,
            ...(creditId ? { credit_id: creditId } : {}),
          }),
        },
      ),
    );
  }
}
