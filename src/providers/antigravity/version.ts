import { z } from "zod";
import { readBodyWithinLimit } from "../../gateway/http/body.ts";
import type { KeyValueStore } from "../../platform/bindings.ts";
import type { UpstreamFetch } from "../../gateway/transport/index.ts";
import { errorMessage, logWarn } from "../../shared/log.ts";
import { abortable } from "../../shared/abort.ts";
import type { HealthExecutionContext } from "../../gateway/health/health.ts";

export const ANTIGRAVITY_FALLBACK_VERSION = "2.9.1";
export const ANTIGRAVITY_VERSION_KEY = "metadata:antigravity:hub-version";
export const ANTIGRAVITY_MANIFEST_URL =
  "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml";
const VERSION_TTL_MS = 6 * 60 * 60_000;
const CACHE_READ_TIMEOUT_MS = 200;
// A local throttle for public metadata refreshes, never account or routing state.
const refreshAfter = new WeakMap<KeyValueStore, number>();
const versionSchema = z
  .string()
  .max(64)
  .regex(/^\d+\.\d+\.\d+$/);
const snapshotSchema = z.object({
  version: versionSchema,
  expires_at: z.number(),
});

export function antigravityUserAgent(
  version = ANTIGRAVITY_FALLBACK_VERSION,
): string {
  return `antigravity/hub/${version} darwin/arm64`;
}

async function snapshot(
  store: KeyValueStore | undefined,
  signal?: AbortSignal,
) {
  if (!store) return undefined;
  try {
    const raw = await abortable(
      store.get(ANTIGRAVITY_VERSION_KEY),
      signal ?? AbortSignal.timeout(CACHE_READ_TIMEOUT_MS),
    );
    return raw && raw.length <= 2048
      ? snapshotSchema.parse(JSON.parse(raw))
      : undefined;
  } catch {
    return undefined;
  }
}

/** Public version metadata is independent of account tokens and config revisions. */
export async function antigravityVersion(
  store?: KeyValueStore,
  context?: HealthExecutionContext,
): Promise<string> {
  const cached = await snapshot(store);
  const now = Date.now();
  if (
    store &&
    context?.waitUntil &&
    (!cached || cached.expires_at - now <= VERSION_TTL_MS / 2) &&
    (refreshAfter.get(store) ?? 0) <= now
  ) {
    refreshAfter.set(store, now + 60_000);
    const cancellation = new AbortController();
    const refresh = refreshAntigravityVersion(
      store,
      undefined,
      cancellation.signal,
    );
    try {
      context.waitUntil(refresh);
    } catch {
      cancellation.abort(new Error("Background execution is unavailable"));
    }
  }
  return cached && cached.expires_at > now
    ? cached.version
    : ANTIGRAVITY_FALLBACK_VERSION;
}

/** Maintenance and waitUntil refreshes share the same cache; inference never awaits the manifest. */
export async function refreshAntigravityVersion(
  store: KeyValueStore,
  send: UpstreamFetch = (request) => fetch(request),
  cancellation?: AbortSignal,
): Promise<void> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(10_000),
    ...(cancellation ? [cancellation] : []),
  ]);
  try {
    const cached = await snapshot(store, signal);
    signal.throwIfAborted();
    if (cached && cached.expires_at - Date.now() > VERSION_TTL_MS / 2) return;
    const response = await send(
      new Request(ANTIGRAVITY_MANIFEST_URL, {
        headers: {
          "user-agent": "electron-builder",
          "cache-control": "no-cache",
        },
        redirect: "manual",
        signal,
      }),
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Manifest returned HTTP ${response.status}`);
    }
    const bytes = await readBodyWithinLimit(
      response.body,
      4096,
      response.headers.get("content-length"),
      undefined,
      signal,
    );
    // Only the scalar version is needed; never parse updater URLs or execute manifest content.
    const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "");
    const matches = [
      ...text.matchAll(
        /^version:[ \t]*(?:"(\d+\.\d+\.\d+)"|'(\d+\.\d+\.\d+)'|(\d+\.\d+\.\d+))[ \t]*(?:#.*)?\r?$/gm,
      ),
    ];
    const [match] = matches;
    if (
      !match ||
      matches.length !== 1 ||
      [...text.matchAll(/^version:/gm)].length !== 1
    )
      throw new Error("Manifest has no unique semantic version");
    const version = versionSchema.parse(match[1] ?? match[2] ?? match[3]);
    signal.throwIfAborted();
    await abortable(
      store.put(
        ANTIGRAVITY_VERSION_KEY,
        JSON.stringify({ version, expires_at: Date.now() + VERSION_TTL_MS }),
      ),
      signal,
    );
  } catch (error) {
    logWarn("antigravity.version_refresh.failed", {
      error: errorMessage(error),
    });
  }
}
