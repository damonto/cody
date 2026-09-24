import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../src/config/store.ts";
import { createRuntime } from "../src/platform/standard/runtime.ts";

const filename = process.argv[2];
if (!filename) throw new Error("Usage: npm run config:import -- config.json");
const config = parseConfig(JSON.parse(await readFile(filename, "utf8")));
const runtime = await createRuntime({
  target: "node",
  root: fileURLToPath(new URL("..", import.meta.url)),
});
try {
  const publisher =
    runtime.bindings.CONFIG_PUBLISHER.getByName("configuration");
  const draft = JSON.parse(await publisher.getDraft());
  if (!draft.ok || draft.data.version !== 0)
    throw new Error(
      "A draft already exists. Use the console to update and publish it.",
    );
  const saved = JSON.parse(
    await publisher.saveDraft(JSON.stringify(config), 0, "config-import"),
  );
  if (!saved.ok) throw new Error(saved.error);
  const published = JSON.parse(
    await publisher.publish(saved.data.version, "config-import"),
  );
  if (!published.ok) throw new Error(published.error);
  console.info("Configuration validated and published.");
} finally {
  await runtime.close();
}
