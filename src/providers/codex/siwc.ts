import { createLocalJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { readBodyWithinLimit } from "../../gateway/http/body.ts";
import type { UpstreamFetch } from "../../gateway/transport/index.ts";
import { MAX_ACCOUNT_METADATA_BYTES } from "../../shared/payload-limits.ts";
import { OAuthError } from "../oauth/schema.ts";
import type { AccountTokens } from "../oauth/provider.ts";
import type { Session } from "../oauth/state.ts";
import { CODEX_ISSUER } from "./api.ts";

export const SIWC_RESOURCE = "https://api.openai.com/v1";
export const SIWC_REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
export const SIWC_SCOPE =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

const DYNAMIC_CLIENT = "dynamic_agent_client";
const discoverySchema = z.object({
  issuer: z.literal(CODEX_ISSUER),
  token_endpoint: z.url(),
  jwks_uri: z.url(),
  revocation_endpoint: z.url(),
});
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).nullish(),
  id_token: z.string().min(1).nullish(),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
});
const terminalRefreshCodes = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

export function siwcAuthorizationUrl(session: Session): string {
  const pending = session.siwc;
  if (!pending) throw new OAuthError("SIWC authorization is not prepared", 409);
  const url = new URL(`${CODEX_ISSUER}/api/accounts/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: pending.client_id ?? DYNAMIC_CLIENT,
    ...(pending.client_id ? {} : { agent_name_hint: "Cody" }),
    ext_agent_host_id: pending.host_id,
    redirect_uri: SIWC_REDIRECT_URI,
    resource: SIWC_RESOURCE,
    scope: SIWC_SCOPE,
    state: session.state,
    nonce: pending.nonce,
    code_challenge: session.challenge,
    code_challenge_method: "S256",
    ...(pending.consent ? { prompt: "consent" } : {}),
  }).toString();
  return url.toString();
}

/** All identity and token requests use the account's selected transport. */
export class SiwcClient {
  constructor(
    private readonly send: UpstreamFetch,
    private readonly signal: AbortSignal,
  ) {}

  private async request(
    url: string,
    init: RequestInit = {},
    refresh = false,
  ): Promise<unknown> {
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new Error("SIWC operation timed out")),
      15_000,
    );
    const signal = AbortSignal.any([this.signal, deadline.signal]);
    try {
      const response = await this.send(
        new Request(url, { ...init, signal, redirect: "manual" }),
      );
      const bytes = await readBodyWithinLimit(
        response.body,
        MAX_ACCOUNT_METADATA_BYTES,
        response.headers.get("content-length"),
        undefined,
        signal,
      );
      let data: unknown;
      try {
        data = bytes.length
          ? JSON.parse(new TextDecoder().decode(bytes))
          : null;
      } catch {
        if (response.ok)
          throw new OAuthError("OpenAI returned an invalid SIWC response", 502);
      }
      if (!response.ok) {
        const parsed = z
          .object({
            error: z
              .union([z.string(), z.object({ code: z.string().optional() })])
              .optional(),
          })
          .safeParse(data);
        const raw = parsed.success ? parsed.data.error : undefined;
        const code = typeof raw === "string" ? raw : raw?.code;
        const permanent =
          refresh && code !== undefined && terminalRefreshCodes.has(code);
        throw new OAuthError(
          permanent
            ? "ChatGPT session expired or was revoked; sign in again"
            : `OpenAI SIWC request failed (${response.status})`,
          response.status,
          permanent ? "invalid_grant" : (code ?? "siwc_upstream_error"),
        );
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
  private async metadata() {
    const metadata = discoverySchema.parse(
      await this.request(`${CODEX_ISSUER}/.well-known/openid-configuration`),
    );
    // Discovery never authorizes sending credentials to another origin.
    for (const endpoint of [
      metadata.token_endpoint,
      metadata.revocation_endpoint,
      metadata.jwks_uri,
    ]) {
      const url = new URL(endpoint);
      if (
        url.origin !== CODEX_ISSUER ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new OAuthError("Invalid OpenAI discovery endpoint", 502);
    }
    return metadata;
  }
  private async grant(form: URLSearchParams, refresh = false) {
    const metadata = await this.metadata();
    const data = tokenSchema.parse(
      await this.request(
        metadata.token_endpoint,
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: form,
        },
        refresh,
      ),
    );
    const tokens: AccountTokens = {
      access_token: data.access_token,
      ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
      ...(data.id_token ? { id_token: data.id_token } : {}),
      expires_at: Date.now() + data.expires_in * 1000,
    };
    return { tokens, scope: data.scope, metadata };
  }
  async verify(
    idToken: string,
    clientId: string,
    jwksUri: string,
    nonce?: string,
  ) {
    const keys = z
      .object({ keys: z.array(z.record(z.string(), z.unknown())) })
      .parse(await this.request(jwksUri));
    const { payload } = await jwtVerify(idToken, createLocalJWKSet(keys), {
      issuer: CODEX_ISSUER,
      audience: clientId,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "exp", ...(nonce ? ["nonce"] : [])],
    });
    if (nonce && payload.nonce !== nonce)
      throw new OAuthError("ChatGPT ID token nonce mismatch", 502);
    if (
      Array.isArray(payload.aud) &&
      payload.aud.length > 1 &&
      payload.azp !== clientId
    )
      throw new OAuthError("ChatGPT ID token authorized party mismatch", 502);
    return {
      subject: z.string().min(1).parse(payload.sub),
      email: z.email().safeParse(payload.email).data ?? null,
    };
  }
  async exchange(code: string, clientId: string, session: Session) {
    if (!session.siwc?.nonce)
      throw new OAuthError("SIWC authorization nonce is unavailable", 409);
    const result = await this.grant(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: session.verifier,
        redirect_uri: SIWC_REDIRECT_URI,
        resource: SIWC_RESOURCE,
      }),
    );
    if (
      !result.tokens.id_token ||
      result.scope === undefined ||
      (result.scope.split(/\s+/).includes("offline_access") &&
        !result.tokens.refresh_token)
    )
      throw new OAuthError(
        "Incomplete ChatGPT SIWC token response; sign in again",
        502,
      );
    const identity = await this.verify(
      result.tokens.id_token,
      clientId,
      result.metadata.jwks_uri,
      session.siwc.nonce,
    );
    return {
      tokens: result.tokens,
      identity,
      scopes: result.scope.split(/\s+/).filter(Boolean),
    };
  }
  async refresh(refreshToken: string, clientId: string, subject: string) {
    const result = await this.grant(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: refreshToken,
        resource: SIWC_RESOURCE,
      }),
      true,
    );
    if (!result.tokens.refresh_token)
      throw new OAuthError(
        "SIWC refresh omitted the replacement refresh token",
        502,
      );
    if (result.tokens.id_token) {
      const identity = await this.verify(
        result.tokens.id_token,
        clientId,
        result.metadata.jwks_uri,
      );
      if (identity.subject !== subject)
        throw new OAuthError(
          "SIWC refresh returned another identity",
          401,
          "invalid_grant",
        );
    }
    return {
      tokens: result.tokens,
      scopes: result.scope?.split(/\s+/).filter(Boolean),
    };
  }
  async models(token: string) {
    return this.request(`${SIWC_RESOURCE}/models`, {
      headers: { authorization: `Bearer ${token}` },
    });
  }
  async revoke(refreshToken: string, clientId: string) {
    const metadata = await this.metadata();
    await this.request(metadata.revocation_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: refreshToken,
        token_type_hint: "refresh_token",
        client_id: clientId,
      }),
    });
  }
}
