import { fileURLToPath, URL } from "node:url";
import { createRuntime } from "./platform/standard/runtime.ts";
import { createNodeServer } from "./platform/standard/server.ts";
import { errorMessage } from "./shared/log.ts";

async function main(): Promise<void> {
  const root = fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "../" : "./", import.meta.url),
  );
  const runtime = await createRuntime({ target: "node", root });
  const host = createNodeServer(runtime);
  const alarmTimer = setInterval(
    () => runtime.tasks.track(runtime.tick()),
    1000,
  );
  const maintenanceTimer = setInterval(
    () => runtime.tasks.track(runtime.maintain()),
    3_600_000,
  );
  alarmTimer.unref();
  maintenanceTimer.unref();
  try {
    await new Promise<void>((resolve, reject) => {
      host.server.once("error", reject);
      host.server.listen(runtime.settings.PORT, runtime.settings.HOST, () => {
        host.server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    clearInterval(alarmTimer);
    clearInterval(maintenanceTimer);
    await runtime.close();
    throw error;
  }
  const address = host.server.address();
  console.info({
    event: "server.listening",
    host: runtime.settings.HOST,
    port: typeof address === "object" ? address?.port : runtime.settings.PORT,
  });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    clearInterval(alarmTimer);
    clearInterval(maintenanceTimer);
    void host.close().catch((error: unknown) => {
      console.error({
        event: "server.shutdown.failed",
        error: errorMessage(error),
      });
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

void main().catch((error: unknown) => {
  console.error({ event: "server.start.failed", error: errorMessage(error) });
  process.exitCode = 1;
});
