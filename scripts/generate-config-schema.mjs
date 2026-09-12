import { readFile, writeFile } from "node:fs/promises";
import { format } from "prettier";
import { z } from "zod";
import { configurationSchema } from "../src/config/schema.ts";

const path = new URL("../config.schema.json", import.meta.url);
const schema = z.toJSONSchema(configurationSchema, {
  io: "input",
  target: "draft-2020-12",
});
const content = await format(JSON.stringify(schema), { parser: "json" });
if (process.argv.includes("--check")) {
  if ((await readFile(path, "utf8")) !== content)
    throw new Error("config.schema.json is stale; run npm run config:schema");
} else {
  await writeFile(path, content);
}
