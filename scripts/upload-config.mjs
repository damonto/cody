import { readValidatedConfig } from "./config-utils.mjs";
import { ADMIN_API_PATH } from "../src/admin/paths.ts";

const args = process.argv.slice(2);
const local = args.includes("--local");
const path = args.find((arg) => !arg.startsWith("--")) ?? "config.json";

try {
  const { config } = await readValidatedConfig(path);
  const base = local ? "http://localhost:8788" : process.env.CODY_ADMIN_URL;
  if (!base)
    throw new Error("Set CODY_ADMIN_URL to the gateway origin, or use --local");
  const url = new URL(base);
  if (!local && url.protocol !== "https:")
    throw new Error("CODY_ADMIN_URL must use HTTPS");
  const headers = new Headers({
    "content-type": "application/json",
    "x-cody-admin": "1",
  });
  if (process.env.CF_ACCESS_CLIENT_ID)
    headers.set("CF-Access-Client-Id", process.env.CF_ACCESS_CLIENT_ID);
  if (process.env.CF_ACCESS_CLIENT_SECRET)
    headers.set("CF-Access-Client-Secret", process.env.CF_ACCESS_CLIENT_SECRET);
  async function call(pathname, method = "GET", body) {
    const response = await fetch(new URL(`${ADMIN_API_PATH}${pathname}`, url), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(
        `Admin API returned ${response.status}; inspect the panel for details`,
      );
    return response.json();
  }
  const current = await call("/config");
  const saved = await call("/config", "PUT", {
    version: current.version,
    config,
  });
  const published = await call("/config/publish", "POST", {
    version: saved.version,
  });
  console.log(
    `Published configuration revision ${published.published_revision}. KV propagation is eventual.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
