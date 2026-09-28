import { z } from "zod";
import type { UpstreamFetch } from "../../gateway/transport/index.ts";
import { readBodyWithinLimit } from "../../gateway/http/body.ts";
import {
  OAuthError,
  type AccountModel,
  type QuotaSnapshot,
  claudeAccountSchema,
  quotaSnapshotSchema,
} from "../oauth/schema.ts";

export const CLAUDE_BASE = "https://api.anthropic.com";
export const CLAUDE_REDIRECT_URI =
  "https://platform.claude.com/oauth/code/callback";
// Public Claude Code OAuth registration, not an account secret.
export const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const SCOPES =
  "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
export function authorizationUrl(state: string, challenge: string): string {
  const url = new URL("https://claude.com/cai/oauth/authorize");
  url.search = new URLSearchParams({
    code: "true",
    client_id: CLAUDE_CLIENT_ID,
    response_type: "code",
    redirect_uri: CLAUDE_REDIRECT_URI,
    scope: SCOPES,
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
  scope: z.string().optional(),
  account: z.object({ uuid: z.string() }).optional(),
  organization: z.object({ uuid: z.string() }).optional(),
});
const profileSchema = z.object({
  account: z.object({
    uuid: z.string().min(1),
    email: z.email().nullable().optional(),
  }),
  organization: z.object({
    uuid: z.string().min(1),
    name: z.string().nullable().optional(),
    organization_type: z.string().nullable().optional(),
    rate_limit_tier: z.string().nullable().optional(),
  }),
});
export function parseProfile(value: unknown) {
  const profile = profileSchema.parse(value);
  return {
    identity: {
      id: `${profile.account.uuid}:${profile.organization.uuid}`,
      email: profile.account.email ?? null,
    },
    claude: claudeAccountSchema.parse({
      account_id: profile.account.uuid,
      organization_id: profile.organization.uuid,
      organization_name: profile.organization.name ?? null,
      subscription_type: profile.organization.organization_type ?? null,
      rate_limit_tier: profile.organization.rate_limit_tier ?? null,
    }),
  };
}
const windowSchema = z.object({
  utilization: z.number().nonnegative().nullable(),
  resets_at: z.string().nullable(),
});
const usageSchema = z.object({
  five_hour: windowSchema.nullable().optional(),
  seven_day: windowSchema.nullable().optional(),
  seven_day_oauth_apps: windowSchema.nullable().optional(),
  seven_day_opus: windowSchema.nullable().optional(),
  seven_day_sonnet: windowSchema.nullable().optional(),
  limits: z
    .array(
      z.object({
        kind: z.string(),
        group: z.string().optional(),
        is_active: z.boolean().optional(),
        percent: z.number().nonnegative().nullable().optional(),
        utilization: z.number().nonnegative().nullable().optional(),
        resets_at: z.union([z.string(), z.number()]).nullable().optional(),
        scope: z
          .object({
            model: z.object({
              id: z.string().optional(),
              display_name: z.string().optional(),
            }),
          })
          .nullable()
          .optional(),
      }),
    )
    .nullable()
    .optional(),
  extra_usage: quotaSnapshotSchema.shape.extra_usage,
});
export function parseUsage(
  value: unknown,
): Pick<QuotaSnapshot, "groups" | "extra_usage"> {
  const data = usageSchema.parse(value);
  const groups: QuotaSnapshot["groups"] = [];
  for (const key of [
    "five_hour",
    "seven_day",
    "seven_day_oauth_apps",
    "seven_day_opus",
    "seven_day_sonnet",
  ] as const) {
    const window = data[key];
    if (!window) continue;
    const model =
      key === "seven_day_opus"
        ? "opus"
        : key === "seven_day_sonnet"
          ? "sonnet"
          : null;
    groups.push({
      id: key,
      label: key.replaceAll("_", " "),
      model,
      buckets: [
        {
          id: key,
          label: key.replaceAll("_", " "),
          window: key === "five_hour" ? "5h" : "weekly",
          remaining_fraction:
            window.utilization === null
              ? null
              : Math.max(0, 1 - window.utilization / 100),
          used_percent: window.utilization,
          reset_at: window.resets_at,
          window_seconds: key === "five_hour" ? 18000 : 604800,
        },
      ],
    });
  }
  // Current desktop/CPA usage also exposes active session, weekly and model-scoped limits.
  for (const limit of data.limits ?? []) {
    if (limit.is_active === false) continue;
    const scoped = [
      "weekly_scoped",
      "weekly_model_scoped",
      "model_scoped",
    ].includes(limit.kind);
    if (scoped && limit.group && limit.group !== "weekly") continue;
    const base =
      !limit.scope && limit.kind === "session"
        ? "five_hour"
        : !limit.scope && ["weekly", "weekly_all"].includes(limit.kind)
          ? "seven_day"
          : null;
    if (!base && !scoped) continue;
    const model = scoped ? limit.scope?.model.id : null;
    if (scoped && !model)
      throw new OAuthError(
        "Claude returned a model quota without a model identity",
        502,
      );
    if (
      base &&
      groups.some(
        (group) => group.id === base && group.buckets[0]?.used_percent != null,
      )
    )
      continue;
    const id = base ?? `weekly:${model}`;
    const label =
      limit.scope?.model.display_name ?? model ?? id.replaceAll("_", " ");
    const used = limit.percent ?? limit.utilization ?? null;
    const rawReset = limit.resets_at;
    const reset =
      typeof rawReset === "number"
        ? rawReset * (rawReset < 1e12 ? 1000 : 1)
        : rawReset
          ? Date.parse(rawReset)
          : NaN;
    const resetAt =
      Number.isFinite(reset) && Math.abs(reset) <= 8640000000000000
        ? new Date(reset).toISOString()
        : null;
    const group = {
      id,
      label,
      model: model ?? null,
      buckets: [
        {
          id,
          label,
          window: base === "five_hour" ? "5h" : "weekly",
          remaining_fraction:
            used === null ? null : Math.max(0, 1 - used / 100),
          used_percent: used,
          reset_at: resetAt,
          window_seconds: base === "five_hour" ? 18000 : 604800,
        },
      ],
    };
    const previous = groups.findIndex((group) => group.id === id);
    if (previous < 0) groups.push(group);
    else {
      const previousReset = Date.parse(
        groups[previous].buckets[0]?.reset_at ?? "",
      );
      if (
        !Number.isFinite(previousReset) ||
        reset > previousReset ||
        (reset === previousReset &&
          (groups[previous].buckets[0]?.used_percent ?? -1) <= (used ?? -1))
      )
        groups[previous] = group;
    }
  }
  if (!groups.some((group) => !group.model))
    throw new OAuthError("Claude returned no subscription usage windows", 502);
  return { groups, extra_usage: data.extra_usage ?? null };
}
const modelsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      display_name: z.string().optional(),
      max_input_tokens: z.number().positive().optional(),
      max_tokens: z.number().positive().optional(),
    }),
  ),
  has_more: z.boolean().optional(),
  last_id: z.string().optional(),
});
export function parseModels(value: unknown): AccountModel[] {
  return modelsSchema.parse(value).data.map((model) => ({
    id: model.id,
    display_name: model.display_name ?? model.id,
    input_token_limit: model.max_input_tokens ?? null,
    output_token_limit: model.max_tokens ?? null,
    supports_thinking: null,
    supports_images: null,
  }));
}
export class ClaudeClient {
  constructor(
    private readonly send: UpstreamFetch,
    private readonly signal: AbortSignal,
  ) {}
  private async json(
    url: string,
    init: RequestInit = {},
    timeoutMs = 15000,
  ): Promise<unknown> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await this.send(
        new Request(url, {
          ...init,
          redirect: "manual",
          signal: AbortSignal.any([this.signal, abort.signal]),
        }),
      );
      const bytes = await readBodyWithinLimit(
        response.body,
        2 * 1024 * 1024,
        response.headers.get("content-length"),
        undefined,
        AbortSignal.any([this.signal, abort.signal]),
      );
      const text = new TextDecoder().decode(bytes);
      if (!response.ok) {
        let invalid = false;
        try {
          invalid = z
            .object({ error: z.literal("invalid_grant") })
            .safeParse(JSON.parse(text)).success;
        } catch {
          /* No upstream text enters logs. */
        }
        throw new OAuthError(
          `Claude account request failed (HTTP ${response.status})`,
          response.status,
          invalid ? "invalid_grant" : "upstream_error",
        );
      }
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  }
  private async grant(
    body: Record<string, string>,
    expected?: { account_id: string; organization_id: string },
  ) {
    const data = tokenResponse.parse(
      await this.json(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: CLAUDE_CLIENT_ID, ...body }),
      }),
    );
    if (
      expected &&
      ((data.account && data.account.uuid !== expected.account_id) ||
        (data.organization &&
          data.organization.uuid !== expected.organization_id))
    )
      throw new OAuthError(
        "Token refresh returned another Claude account or organization",
        401,
        "invalid_grant",
      );
    if (data.scope && !data.scope.split(" ").includes("user:inference"))
      throw new OAuthError("Claude authorization lacks inference scope", 403);
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };
  }
  exchange(code: string, verifier: string, state: string) {
    return this.grant({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      state,
      redirect_uri: CLAUDE_REDIRECT_URI,
    });
  }
  refresh(
    refreshToken: string,
    expected?: { account_id: string; organization_id: string },
  ) {
    return this.grant(
      {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: SCOPES,
      },
      expected,
    );
  }
  private get(path: string, token: string, timeoutMs = 10000) {
    return this.json(
      `${CLAUDE_BASE}${path}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
          "anthropic-version": "2023-06-01",
        },
      },
      timeoutMs,
    );
  }
  profile(token: string) {
    return this.get("/api/oauth/profile", token);
  }
  usage(token: string) {
    return this.get("/api/oauth/usage", token, 5000);
  }
  async models(token: string) {
    const data: z.output<typeof modelsSchema>["data"] = [];
    let after = "";
    const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const result = modelsSchema.parse(
        await this.get(
          `/v1/models?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ""}`,
          token,
        ),
      );
      data.push(...result.data);
      if (!result.has_more) return { data };
      if (!result.last_id || seen.has(result.last_id))
        throw new OAuthError("Invalid Claude model pagination", 502);
      after = result.last_id;
      seen.add(after);
    }
    throw new OAuthError("Claude model catalog exceeds pagination limit", 502);
  }
}
