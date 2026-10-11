import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readTransferJson } from "../src/transfer/transport.ts";
import { transferFailure } from "../src/transfer/protocol.ts";

// Separate processes isolate Wrangler account credentials and preview lifetimes.
let worker;
let directory;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try {
    await worker?.stop();
  } finally {
    try {
      if (directory) await rm(directory, { recursive: true, force: true });
    } finally {
      process.exit(0);
    }
  }
}
process.on("disconnect", close);
process.on("SIGTERM", close);
process.on("SIGINT", close);
process.on("message", async (message) => {
  try {
    if (message.action === "start") {
      directory = await mkdtemp(join(tmpdir(), "cody-transfer-"));
      process.env.WRANGLER_LOG_PATH = join(directory, "logs");
      process.env.WRANGLER_LOG_SANITIZE = "true";
      const { unstable_dev } = await import("wrangler");
      const config = join(directory, "wrangler.json");
      await writeFile(config, JSON.stringify(message.config), { mode: 0o600 });
      worker = await unstable_dev(
        fileURLToPath(new URL("./transfer-bridge.ts", import.meta.url)),
        {
          config,
          local: false,
          ip: "127.0.0.1",
          port: 0,
          inspectorPort: 0,
          logLevel: "none",
          vars: {
            CONFIG_ENCRYPTION_KEY: process.env.TRANSFER_KEY,
            BRIDGE_TOKEN: process.env.BRIDGE_TOKEN,
          },
          experimental: {
            watch: false,
            showInteractiveDevSession: false,
            disableExperimentalWarning: true,
            disableDevRegistry: true,
          },
        },
      );
      process.send({ id: message.id, result: true });
    } else if (message.action === "call") {
      const response = await worker.fetch("http://localhost/", {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.BRIDGE_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(message.command),
      });
      const result = await readTransferJson(response);
      process.send({
        id: message.id,
        ...(response.ok ? { result } : { error: result.error }),
      });
    } else if (message.action === "close") await close();
  } catch (error) {
    process.send?.({
      id: message.id,
      error: transferFailure(
        error,
        message.action === "start"
          ? "Cloudflare temporary preview startup"
          : "Cloudflare temporary preview request",
      ).message,
    });
  }
});
