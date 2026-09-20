import { z } from "zod";
import { readBodyWithinLimit } from "../../gateway/http/body.ts";
import type { UpstreamFetch } from "../../gateway/transport/index.ts";
import { logWarn } from "../../shared/log.ts";
import {
  OAuthError,
  identitySchema,
  type AccountModel,
  type QuotaSnapshot,
} from "../oauth/schema.ts";

export const ANTIGRAVITY_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
// Public desktop OAuth registration used by CLIProxyAPI, not an account credential.
const ANTIGRAVITY_CLIENT_SECRET = "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";
export const ANTIGRAVITY_REDIRECT_URI = "http://localhost:51121/oauth-callback";
export const ANTIGRAVITY_BASE = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_USER_AGENT = "antigravity/hub/2.9.1 darwin/arm64";
export const ANTIGRAVITY_ONBOARD_USER_AGENT = `${ANTIGRAVITY_USER_AGENT} google-api-nodejs-client/10.3.0`;
export const ANTIGRAVITY_GOOG_API_CLIENT = "gl-node/22.21.1";
const SCOPES = [
  "cloud-platform",
  "userinfo.email",
  "userinfo.profile",
  "cclog",
  "experimentsandconfigs",
].map((scope) => `https://www.googleapis.com/auth/${scope}`);
export function authorizationUrl(state: string, challenge: string): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: ANTIGRAVITY_CLIENT_ID,
    redirect_uri: ANTIGRAVITY_REDIRECT_URI,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}
const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
});
const objectSchema = z.record(z.string(), z.unknown());
export function object(value: unknown): Record<string, unknown> {
  const result = objectSchema.safeParse(value);
  return result.success ? result.data : {};
}
function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}
export function projectId(value: unknown): string | null {
  const data = object(value);
  for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
    const id = str(data[key]) ?? str(object(data[key]).id);
    if (id) return id;
  }
  return null;
}
export function defaultTier(value: unknown): string {
  const data = object(value);
  const tiers = Array.isArray(data.allowedTiers)
    ? data.allowedTiers.map(object)
    : [];
  return (
    str(tiers.find((tier) => tier.isDefault === true)?.id) ??
    str(object(data.currentTier).id) ??
    "free-tier"
  );
}
export function parseModels(value: unknown): AccountModel[] {
  const parsed = z
    .object({ models: z.record(z.string(), objectSchema) })
    .parse(value);
  return Object.entries(parsed.models).map(([id, model]) => ({
    id,
    display_name: str(model.displayName ?? model.display_name) ?? id,
    input_token_limit: positive(model.inputTokenLimit ?? model.maxInputTokens),
    output_token_limit: positive(
      model.outputTokenLimit ?? model.maxOutputTokens,
    ),
    supports_thinking:
      typeof model.supportsThinking === "boolean"
        ? model.supportsThinking
        : null,
    supports_images:
      typeof model.supportsImages === "boolean" ? model.supportsImages : null,
  }));
}
function fraction(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" &&
    Number.isFinite(number) &&
    number >= 0 &&
    number <= 1
    ? number
    : null;
}
export function parseQuota(value: unknown): QuotaSnapshot["groups"] {
  const data = object(value);
  if (Array.isArray(data.groups))
    return data.groups.map((value, i) => {
      const group = object(value);
      return {
        id: str(group.id) ?? `group-${i}`,
        label: str(group.displayName ?? group.display_name) ?? `Quota ${i + 1}`,
        buckets: (Array.isArray(group.buckets) ? group.buckets : []).map(
          (value, j) => {
            const bucket = object(value);
            return {
              id: str(bucket.bucketId ?? bucket.bucket_id) ?? `bucket-${j}`,
              label:
                str(
                  bucket.displayName ?? bucket.display_name ?? bucket.window,
                ) ?? "Remaining",
              window: str(bucket.window),
              remaining_fraction: fraction(
                bucket.remainingFraction ?? bucket.remaining_fraction,
              ),
              reset_at: str(bucket.resetTime ?? bucket.reset_time),
            };
          },
        ),
      };
    });
  if (!data.models || typeof data.models !== "object")
    throw new OAuthError("Quota response has no quota inventory", 502);
  return Object.entries(object(data.models)).map(([id, value]) => {
    const model = object(value);
    const info = object(model.quotaInfo ?? model.quota_info);
    return {
      id,
      label: str(model.displayName ?? model.display_name) ?? id,
      buckets: [
        {
          id: "model",
          label: "Remaining",
          window: null,
          remaining_fraction: fraction(
            info.remainingFraction ?? info.remaining_fraction,
          ),
          reset_at: str(info.resetTime ?? info.reset_time),
        },
      ],
    };
  });
}
export function parseSubscription(
  value: unknown,
): QuotaSnapshot["subscription"] {
  const data = object(value);
  const paid = object(data.paidTier ?? data.paid_tier);
  const current = object(data.currentTier ?? data.current_tier);
  const tier = str(paid.id) ? paid : current;
  if (!str(tier.id) && !str(tier.name)) return null;
  const credits = paid.availableCredits ?? paid.available_credits;
  return {
    tier_id: str(tier.id),
    tier_name: str(tier.name),
    credits: (Array.isArray(credits) ? credits : []).map((value) => {
      const credit = object(value);
      const amount = credit.creditAmount ?? credit.credit_amount;
      return {
        type: str(credit.creditType ?? credit.credit_type),
        amount:
          typeof amount === "number" && Number.isFinite(amount)
            ? amount
            : str(amount),
      };
    }),
  };
}

/** Every operation receives the provider transport; no OAuth request silently uses global fetch. */
export class AntigravityClient {
  constructor(
    private readonly send: UpstreamFetch,
    private readonly signal: AbortSignal = new AbortController().signal,
  ) {}
  private async json(
    url: string,
    init: RequestInit,
    operation: string,
  ): Promise<unknown> {
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new Error("Antigravity operation timed out")),
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
        const upstreamError = object(data).error;
        logWarn("oauth.upstream.failed", {
          operation,
          status: response.status,
          url: url.split("?")[0],
          upstream_error:
            typeof upstreamError === "string"
              ? upstreamError
              : object(upstreamError).message,
        });
        const code =
          object(data).error === "invalid_grant"
            ? "invalid_grant"
            : "upstream_error";
        throw new OAuthError(
          code === "invalid_grant"
            ? "Google authorization expired or was revoked; reconnect this account"
            : `${operation} failed (HTTP ${response.status})`,
          response.status,
          code,
        );
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
  private async token(fields: Record<string, string>) {
    const data = tokenResponse.parse(
      await this.json(
        "https://oauth2.googleapis.com/token",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            ...fields,
            client_id: ANTIGRAVITY_CLIENT_ID,
            client_secret: ANTIGRAVITY_CLIENT_SECRET,
          }),
        },
        "Token exchange",
      ),
    );
    return {
      access_token: data.access_token,
      ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
      expires_at: Date.now() + data.expires_in * 1000,
    };
  }
  exchange(code: string, verifier: string) {
    return this.token({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: ANTIGRAVITY_REDIRECT_URI,
    });
  }
  refresh(refreshToken: string) {
    return this.token({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
  }
  async userInfo(token: string) {
    return identitySchema.parse(
      await this.json(
        "https://www.googleapis.com/oauth2/v2/userinfo?alt=json",
        {
          headers: {
            accept: "*/*",
            authorization: `Bearer ${token}`,
            "user-agent": ANTIGRAVITY_USER_AGENT,
          },
        },
        "Google account identity",
      ),
    );
  }
  private post(
    method: string,
    token: string,
    body: unknown,
    base = ANTIGRAVITY_BASE,
  ) {
    return this.json(
      `${base}/v1internal:${method}`,
      {
        method: "POST",
        headers: {
          accept: "*/*",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": ANTIGRAVITY_USER_AGENT,
        },
        body: JSON.stringify(body),
      },
      method,
    );
  }
  load(token: string) {
    return this.post(
      "loadCodeAssist",
      token,
      { metadata: { ideType: "ANTIGRAVITY" } },
      "https://cloudcode-pa.googleapis.com",
    );
  }
  onboard(token: string, tier: string) {
    return this.json(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser",
      {
        method: "POST",
        headers: {
          accept: "*/*",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": ANTIGRAVITY_ONBOARD_USER_AGENT,
          "x-goog-api-client": ANTIGRAVITY_GOOG_API_CLIENT,
        },
        body: JSON.stringify({
          tier_id: tier,
          metadata: {
            ide_type: "ANTIGRAVITY",
            ide_name: "antigravity",
            ide_version: "2.9.1",
          },
        }),
      },
      "onboardUser",
    );
  }
  models(token: string, project: string) {
    return this.post("fetchAvailableModels", token, { project });
  }
  async quota(token: string, project: string) {
    try {
      return await this.post("retrieveUserQuotaSummary", token, { project });
    } catch (error) {
      if (error instanceof OAuthError && [404, 405, 501].includes(error.status))
        return this.models(token, project);
      throw error;
    }
  }
}
