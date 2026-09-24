/**
 * Serves the built console (`console/dist`) from disk for the standard
 * backend. `serveConsoleAsset` strips the `/console` prefix before calling
 * `fetch`, so paths here are relative to the bundle root.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AssetFetcher } from "../bindings.ts";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

interface ResolvedFile {
  readonly file: string;
  readonly size: number;
  readonly mtimeMs: number;
}

async function existingFile(file: string): Promise<ResolvedFile | undefined> {
  try {
    const info = await stat(file);
    return info.isFile()
      ? { file, size: info.size, mtimeMs: info.mtimeMs }
      : undefined;
  } catch {
    return undefined;
  }
}

export function createFilesystemAssets(root: string): AssetFetcher {
  const base = path.resolve(root);
  const inside = (candidate: string): boolean =>
    candidate === base || candidate.startsWith(`${base}${path.sep}`);

  async function resolve(pathname: string): Promise<ResolvedFile | undefined> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return undefined;
    }
    if (decoded.includes("\0")) return undefined;
    const relative = decoded.replace(/^\/+/, "");
    const target = path.resolve(base, relative);
    if (!inside(target)) return undefined;
    const direct =
      relative === "" || relative.endsWith("/")
        ? await existingFile(path.join(target, "index.html"))
        : await existingFile(target);
    if (direct) return direct;
    // Client-side routes have no file extension and fall back to the SPA shell.
    return path.extname(relative) === ""
      ? existingFile(path.join(base, "index.html"))
      : undefined;
  }

  return {
    async fetch(request: Request): Promise<Response> {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { allow: "GET, HEAD" },
        });
      }
      const url = new URL(request.url);
      const resolved = await resolve(url.pathname);
      if (!resolved) return new Response("Not Found", { status: 404 });
      const extension = path.extname(resolved.file).toLowerCase();
      const etag = `"${resolved.size.toString(16)}-${Math.floor(resolved.mtimeMs).toString(16)}"`;
      const headers = new Headers({
        "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream",
        etag,
        "cache-control": url.pathname.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      });
      if (request.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304, headers });
      }
      headers.set("content-length", String(resolved.size));
      if (request.method === "HEAD") {
        return new Response(null, { status: 200, headers });
      }
      return new Response(await readFile(resolved.file), {
        status: 200,
        headers,
      });
    },
  };
}
