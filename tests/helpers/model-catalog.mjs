import { registerHooks } from "node:module";

const metadataUrl = new URL(
  "../../src/gateway/catalog/metadata.ts",
  import.meta.url,
).href;
const fixtureUrl = new URL("./model-catalog.json", import.meta.url).href;

export async function withModelCatalogFixture(importModules) {
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL === metadataUrl && specifier === "./models.json")
        return nextResolve(fixtureUrl, context);
      return nextResolve(specifier, context);
    },
  });
  try {
    // The catalog is read at module initialization, after the hook is registered.
    return await importModules();
  } finally {
    hook.deregister();
  }
}
