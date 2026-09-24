import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const target = process.argv[2];
if (!["node", "vercel"].includes(target))
  throw new Error("Expected node or vercel");
const output = path.join(root, target === "node" ? "dist" : ".vercel/output");
await rm(output, { recursive: true, force: true });
const functionRoot =
  target === "node" ? output : path.join(output, "functions/gateway.func");
await mkdir(functionRoot, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints:
    target === "node"
      ? { server: "src/server.ts", migrate: "src/migrate.ts" }
      : { index: "src/vercel.ts" },
  outdir: functionRoot,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  external: ["cloudflare:*", "pg-native"],
  banner: {
    js: 'import { createRequire as __codyCreateRequire } from "node:module"; const require = __codyCreateRequire(import.meta.url);',
  },
  sourcemap: true,
  logLevel: "info",
});
await cp(path.join(root, "migrations"), path.join(functionRoot, "migrations"), {
  recursive: true,
});
await cp(
  path.join(root, "console/dist"),
  path.join(functionRoot, "console/dist"),
  { recursive: true },
);
if (target === "vercel") {
  await cp(
    path.join(root, "console/dist"),
    path.join(output, "static/console"),
    { recursive: true },
  );
  const maxDuration = Number(process.env.VERCEL_MAX_DURATION ?? 300);
  if (!Number.isInteger(maxDuration) || maxDuration < 1)
    throw new Error("VERCEL_MAX_DURATION must be a positive integer");
  await writeFile(
    path.join(functionRoot, ".vc-config.json"),
    JSON.stringify(
      {
        runtime: "nodejs24.x",
        handler: "index.mjs",
        launcherType: "Nodejs",
        maxDuration,
        supportsResponseStreaming: true,
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    path.join(output, "config.json"),
    JSON.stringify(
      {
        version: 3,
        routes: [
          { src: "/console/(?:api|auth)(?:/.*)?", dest: "/gateway" },
          {
            src: "/console/assets/.*",
            headers: {
              "cache-control": "public, max-age=31536000, immutable",
              "x-content-type-options": "nosniff",
            },
            continue: true,
          },
          { handle: "filesystem" },
          { src: "/.*", dest: "/gateway" },
        ],
        crons: [{ path: "/_cody/maintenance", schedule: "17 3 * * *" }],
      },
      null,
      2,
    ) + "\n",
  );
}
