import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { authenticateAdmin, safeAdminMutation } from "../src/admin/auth.ts";
import {
  createOidcApp,
  authenticateOidcSession,
  safeReturnTo,
  resetOidcDiscoveryForTests,
} from "../src/admin/oidc.ts";

const env = {
  CONFIG_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  ADMIN_AUTH_MODE: "oidc",
  ADMIN_OIDC_ISSUER: "https://issuer.test",
  ADMIN_OIDC_CLIENT_ID: "cody",
  ADMIN_OIDC_ALLOWED_EMAILS: "admin@example.test",
};

test("token authentication and mutation origins work on Node", async () => {
  const settings = {
    ...env,
    ADMIN_AUTH_MODE: "token",
    ADMIN_TOKEN: "a-long-admin-token",
  };
  assert.equal(
    await authenticateAdmin(
      new Request("https://cody.test", {
        headers: { authorization: "Bearer a-long-admin-token" },
      }),
      settings,
    ),
    "admin-token",
  );
  assert.equal(
    await authenticateAdmin(
      new Request("https://cody.test", {
        headers: { authorization: "Bearer a-long-admin-tokem" },
      }),
      settings,
    ),
    null,
  );
  assert.equal(
    safeAdminMutation(
      new Request("http://cody.test/console/api/config", {
        method: "PUT",
        headers: {
          "x-cody-admin": "1",
          "x-forwarded-proto": "https",
          origin: "https://cody.test",
          "sec-fetch-site": "same-origin",
        },
      }),
    ),
    true,
  );
  assert.equal(
    safeAdminMutation(
      new Request("https://cody.test", {
        method: "PUT",
        headers: { "x-cody-admin": "1", origin: "https://attacker.test" },
      }),
    ),
    false,
  );
});

test("OIDC verifies PKCE, state, nonce, email and session scope", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256" };
  let nonce;
  let challenge;
  let verified = true;
  let email = "admin@example.test";
  let invalidNonce = false;
  const transport = async (input, init) => {
    const url = typeof input === "string" ? input : (input.url ?? input.href);
    if (url.endsWith("openid-configuration"))
      return Response.json({
        issuer: env.ADMIN_OIDC_ISSUER,
        authorization_endpoint: "https://issuer.test/authorize",
        token_endpoint: "https://issuer.test/token",
        jwks_uri: "https://issuer.test/keys",
      });
    if (url.endsWith("/keys")) return Response.json({ keys: [jwk] });
    assert.equal(url, "https://issuer.test/token");
    assert.equal(
      init.body.get("redirect_uri"),
      "https://cody.test/console/auth/callback",
    );
    const expected = Buffer.from(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(init.body.get("code_verifier")),
      ),
    ).toString("base64url");
    assert.equal(expected, challenge);
    const token = await new SignJWT({
      nonce: invalidNonce ? "wrong" : nonce,
      email,
      email_verified: verified,
    })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(env.ADMIN_OIDC_ISSUER)
      .setAudience(env.ADMIN_OIDC_CLIENT_ID)
      .setSubject("admin")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    return Response.json({ id_token: token });
  };
  const app = new Hono().route(
    "/console/auth",
    createOidcApp({ fetch: transport }),
  );
  const login = async () => {
    const response = await app.request(
      "https://cody.test/console/auth/login?return_to=/console/providers",
      {},
      env,
    );
    assert.equal(response.status, 302);
    const target = new URL(response.headers.get("location"));
    nonce = target.searchParams.get("nonce");
    challenge = target.searchParams.get("code_challenge");
    assert.equal(target.searchParams.get("code_challenge_method"), "S256");
    const cookie = response.headers.getSetCookie()[0];
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    return {
      state: target.searchParams.get("state"),
      cookie: cookie.split(";")[0],
    };
  };
  const callback = ({ state, cookie }) =>
    app.request(
      `https://cody.test/console/auth/callback?code=code&state=${state}`,
      { headers: { cookie } },
      env,
    );
  try {
    const attempt = await login();
    assert.equal((await callback({ ...attempt, state: "wrong" })).status, 400);
    const response = await callback(attempt);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/console/providers");
    const cookie = response.headers
      .getSetCookie()
      .find((item) => item.startsWith("cody_admin_session="))
      .split(";")[0];
    const request = new Request("https://cody.test/console/api/config", {
      headers: { cookie },
    });
    assert.equal(
      await authenticateOidcSession(request, env),
      "admin@example.test",
    );
    assert.equal(
      await authenticateOidcSession(request, {
        ...env,
        ADMIN_OIDC_CLIENT_ID: "another-client",
      }),
      null,
    );
    assert.equal(
      await authenticateOidcSession(request, {
        ...env,
        ADMIN_OIDC_ALLOWED_EMAILS: "someone@example.test",
      }),
      null,
    );
    assert.equal(
      await authenticateOidcSession(
        new Request(request, { headers: { cookie: cookie + "tampered" } }),
        env,
      ),
      null,
    );
    verified = false;
    assert.equal((await callback(await login())).status, 401);
    verified = true;
    email = "someone@example.test";
    assert.equal((await callback(await login())).status, 403);
    email = "admin@example.test";
    invalidNonce = true;
    assert.equal((await callback(await login())).status, 401);
    assert.equal(
      (
        await app.request(
          "https://cody.test/console/auth/logout",
          { method: "POST", headers: { origin: "https://attacker.test" } },
          env,
        )
      ).status,
      403,
    );
  } finally {
    resetOidcDiscoveryForTests();
  }
});

test("OIDC rejects and cancels oversized discovery streams without caching the failure", async () => {
  let canceled = false;
  let oversized = true;
  const app = new Hono().route(
    "/console/auth",
    createOidcApp({
      fetch: async () => {
        if (oversized)
          return new Response(
            new ReadableStream({
              pull(controller) {
                controller.enqueue(new Uint8Array(64 * 1024));
              },
              cancel() {
                canceled = true;
              },
            }),
          );
        return Response.json({
          issuer: env.ADMIN_OIDC_ISSUER,
          authorization_endpoint: "https://issuer.test/authorize",
          token_endpoint: "https://issuer.test/token",
          jwks_uri: "https://issuer.test/keys",
        });
      },
    }),
  );
  try {
    assert.equal(
      (await app.request("https://cody.test/console/auth/login", {}, env))
        .status,
      502,
    );
    assert.equal(canceled, true);
    oversized = false;
    assert.equal(
      (await app.request("https://cody.test/console/auth/login", {}, env))
        .status,
      302,
    );
  } finally {
    resetOidcDiscoveryForTests();
  }
});

test("OIDC return URLs remain inside the console", () => {
  for (const value of [
    "https://attacker.test",
    "//attacker.test",
    "/console/../outside",
    "/console/%2e%2e/outside",
    "/console/../console/auth/login",
    "/consoleish",
  ])
    assert.equal(safeReturnTo(value), "/console/");
  assert.equal(
    safeReturnTo("/console/providers?tab=accounts"),
    "/console/providers?tab=accounts",
  );
});
