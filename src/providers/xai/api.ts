import { decodeJwt } from "jose";
import { z } from "zod";
import { readBodyWithinLimit } from "../../gateway/http/body.ts";
import type { UpstreamFetch } from "../../gateway/transport/index.ts";
import { OAuthError, tokenSchema } from "../oauth/schema.ts";
import { parseBilling } from "./billing.ts";

export const XAI_BASE = "https://cli-chat-proxy.grok.com/v1";
export const XAI_DISCOVERY =
  "https://auth.x.ai/.well-known/openid-configuration";
export const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_SCOPE =
  "openid profile email offline_access grok-cli:access api:access";
export const XAI_VERSION = "0.2.120";
export function xaiHeaders(token: string, subject?: string): Headers {
  return new Headers({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-client-version": XAI_VERSION,
    "x-grok-client-identifier": "grok-shell",
    "x-authenticateresponse": "authenticate-response",
    "user-agent": `xai-grok-workspace/${XAI_VERSION}`,
    ...(subject ? { "x-userid": subject } : {}),
  });
}
export function officialOAuthUrl(value: string): string {
  const url = URL.parse(value);
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    !(url.hostname === "x.ai" || url.hostname.endsWith(".x.ai"))
  )
    throw new OAuthError("Invalid xAI authorization endpoint", 502);
  return url.href;
}
const grantSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  expires_in: z.number().nonnegative().optional(),
});
export const xaiDeviceSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().transform(officialOAuthUrl),
  verification_uri_complete: z.string().transform(officialOAuthUrl).optional(),
  expires_in: z.number().positive(),
  interval: z.number().positive().default(5),
  token_endpoint: z.string().transform(officialOAuthUrl),
});
export type XaiDevice = z.output<typeof xaiDeviceSchema>;
export function xaiIdentity(tokens: z.output<typeof tokenSchema>) {
  try {
    const claims = decodeJwt(tokens.id_token ?? tokens.access_token);
    if (claims.iss && claims.iss !== "https://auth.x.ai")
      throw new Error("issuer");
    return z
      .object({ sub: z.string().min(1), email: z.email().optional() })
      .parse(claims);
  } catch {
    throw new OAuthError(
      "xAI did not return a usable account identity",
      401,
      "invalid_grant",
    );
  }
}
export class XaiClient {
  constructor(
    private readonly send: UpstreamFetch,
    private readonly signal: AbortSignal,
  ) {}
  private async json(
    url: string,
    init: RequestInit = {},
    timeout = 15000,
  ): Promise<unknown> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeout);
    const signal = AbortSignal.any([this.signal, abort.signal]);
    try {
      const headers = new Headers(init.headers);
      headers.set("accept", "application/json");
      const response = await this.send(
        new Request(url, { ...init, headers, redirect: "manual", signal }),
      );
      const bytes = await readBodyWithinLimit(
        response.body,
        2 * 1024 * 1024,
        response.headers.get("content-length"),
        undefined,
        signal,
      );
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        /* Never expose upstream token responses. */
      }
      const error = z.object({ error: z.string().min(1) }).safeParse(value);
      if (!response.ok || error.success) {
        const code =
          error.success &&
          [
            "authorization_pending",
            "slow_down",
            "access_denied",
            "expired_token",
            "invalid_grant",
          ].includes(error.data.error)
            ? error.data.error
            : "upstream_error";
        throw new OAuthError(
          `xAI account request failed (HTTP ${response.status}, ${code})`,
          response.ok ? 400 : response.status,
          code,
        );
      }
      if (value === undefined)
        throw new OAuthError("Invalid xAI account response", 502);
      return value;
    } finally {
      clearTimeout(timer);
    }
  }
  private async discovery() {
    const discovery = z.object({
      device_authorization_endpoint: z.string().transform(officialOAuthUrl),
      token_endpoint: z.string().transform(officialOAuthUrl),
    });
    return discovery.parse(await this.json(XAI_DISCOVERY));
  }
  async startDevice(): Promise<XaiDevice> {
    const endpoints = await this.discovery();
    const response = await this.json(endpoints.device_authorization_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: XAI_CLIENT_ID,
        scope: XAI_SCOPE,
      }).toString(),
    });
    const value = z.record(z.string(), z.unknown()).parse(response);
    return xaiDeviceSchema.parse({
      ...value,
      token_endpoint: endpoints.token_endpoint,
    });
  }
  private async grant(
    endpoint: string,
    form: Record<string, string>,
    previous?: z.output<typeof tokenSchema>,
  ) {
    const result = grantSchema.parse(
      await this.json(officialOAuthUrl(endpoint), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: XAI_CLIENT_ID,
          ...form,
        }).toString(),
      }),
    );
    let expires_at = !result.expires_in
      ? previous?.expires_at
      : Date.now() + result.expires_in * 1000;
    if (expires_at === undefined) {
      try {
        const claim = decodeJwt(result.access_token).exp;
        if (claim !== undefined) expires_at = claim * 1000;
      } catch {
        /* Opaque access tokens need an explicit expiry on initial authorization. */
      }
    }
    if (expires_at === undefined)
      throw new OAuthError("xAI did not return a token expiry", 502);
    return tokenSchema.parse({
      access_token: result.access_token,
      refresh_token: result.refresh_token ?? previous?.refresh_token,
      id_token: result.id_token ?? previous?.id_token,
      expires_at,
    });
  }
  async pollDevice(device: XaiDevice) {
    try {
      return {
        tokens: await this.grant(device.token_endpoint, {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: device.device_code,
        }),
        slow: false,
      };
    } catch (error) {
      if (
        error instanceof OAuthError &&
        ["authorization_pending", "slow_down"].includes(error.code)
      )
        return { tokens: null, slow: error.code === "slow_down" };
      throw error;
    }
  }
  async refresh(previous: z.output<typeof tokenSchema>, subject: string) {
    if (!previous.refresh_token)
      throw new OAuthError("Reconnect this xAI account", 401, "invalid_grant");
    const endpoints = await this.discovery();
    const tokens = await this.grant(
      endpoints.token_endpoint,
      { grant_type: "refresh_token", refresh_token: previous.refresh_token },
      previous,
    );
    if (xaiIdentity(tokens).sub !== subject)
      throw new OAuthError(
        "xAI refresh returned a different account",
        401,
        "invalid_grant",
      );
    // Check fresh access-token claims too when an omitted ID token was preserved.
    try {
      const claims = decodeJwt(tokens.access_token);
      if (claims.sub && claims.sub !== subject)
        throw new OAuthError(
          "xAI refresh returned a different account",
          401,
          "invalid_grant",
        );
    } catch (error) {
      if (error instanceof OAuthError) throw error;
    }
    return tokens;
  }
  async quota(token: string, subject: string) {
    const headers = xaiHeaders(token, subject);
    const billing = await this.json(
      `${XAI_BASE}/billing?format=credits`,
      { headers },
      5000,
    );
    return parseBilling(billing);
  }
}
