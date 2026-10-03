import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  ANTIGRAVITY_FALLBACK_VERSION,
  ANTIGRAVITY_MANIFEST_URL,
  ANTIGRAVITY_VERSION_KEY,
  antigravityVersion,
  refreshAntigravityVersion,
} from "../../src/providers/antigravity/version.ts";

beforeEach(() => env.CODY_CONFIG_KV.delete(ANTIGRAVITY_VERSION_KEY));
afterEach(() => vi.unstubAllGlobals());

test("a cold Worker cache refreshes the Hub version in the background", async () => {
  const send = vi.fn(async (request: Request) => {
    expect(request.url).toBe(ANTIGRAVITY_MANIFEST_URL);
    expect(request.redirect).toBe("manual");
    expect(request.headers.get("authorization")).toBeNull();
    return new Response("version: 2.12.1\n");
  });
  vi.stubGlobal("fetch", send);
  const ctx = createExecutionContext();
  expect(await antigravityVersion(env.CODY_CONFIG_KV, ctx)).toBe(
    ANTIGRAVITY_FALLBACK_VERSION,
  );
  await waitOnExecutionContext(ctx);
  expect(send).toHaveBeenCalledOnce();
  expect(await antigravityVersion(env.CODY_CONFIG_KV)).toBe("2.12.1");
});

test("a redirected manifest is rejected without caching its body or following it", async () => {
  const send = vi.fn(async (request: Request) => {
    expect(request.redirect).toBe("manual");
    return new Response("version: 9.9.9\n", {
      status: 302,
      headers: { location: "https://other.example/manifest.yml" },
    });
  });
  await refreshAntigravityVersion(env.CODY_CONFIG_KV, send);
  expect(send).toHaveBeenCalledOnce();
  expect(await env.CODY_CONFIG_KV.get(ANTIGRAVITY_VERSION_KEY)).toBeNull();
});
