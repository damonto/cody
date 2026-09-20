import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";

test("console production bundles respect size and feature boundaries", async (t) => {
  // Build in memory so this check cannot replace the assets used by Worker/E2E tests.
  const result = await build({
    root: fileURLToPath(new URL("../console/", import.meta.url)),
    configFile: fileURLToPath(
      new URL("../console/vite.config.ts", import.meta.url),
    ),
    logLevel: "error",
    build: { write: false },
  });
  assert.ok(!Array.isArray(result) && "output" in result);
  const chunks = result.output.filter((item) => item.type === "chunk");
  const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const entries = chunks.filter((chunk) => chunk.isEntry);
  assert.ok(entries.length > 0, "The production build must contain an entry");

  function dependencies(roots) {
    const visited = new Set();
    function visit(chunk) {
      if (visited.has(chunk)) return;
      visited.add(chunk);
      for (const name of chunk.imports) {
        const dependency = byFile.get(name);
        assert.ok(dependency, `Missing bundled dependency: ${name}`);
        visit(dependency);
      }
    }
    roots.forEach(visit);
    return [...visited];
  }
  const modules = (graph) =>
    graph.flatMap((chunk) => Object.keys(chunk.modules));
  const initial = dependencies(entries);
  const reportOnly =
    /\/node_modules\/(?:@js-temporal\/polyfill|jsbi|recharts)\//;

  await t.test(
    "minified JavaScript chunks stay within the 500 kB budget",
    () => {
      for (const chunk of chunks) {
        const size = Buffer.byteLength(chunk.code);
        assert.ok(
          size <= 500_000,
          `${chunk.fileName}: ${size} bytes exceeds 500 kB`,
        );
      }
    },
  );

  await t.test(
    "the entry does not eagerly load reporting or configuration schemas",
    () => {
      for (const id of modules(initial)) {
        assert.doesNotMatch(id, reportOnly);
        assert.doesNotMatch(id, /\/src\/(?:admin|config)\/schema\.ts$/);
      }
    },
  );

  await t.test("OAuth client registration stays out of browser bundles", () => {
    for (const id of modules(chunks)) {
      assert.doesNotMatch(id, /\/src\/providers\/antigravity\/api\.ts$/);
    }
    for (const chunk of chunks) {
      assert.doesNotMatch(chunk.code, /GOCSPX-/);
    }
  });

  for (const page of [
    "providers",
    "antigravity",
    "proxies",
    "clients",
    "pricing",
    "routing",
    "settings",
    "runtime",
  ]) {
    await t.test(
      `${page} stays lazy and does not load reporting libraries`,
      () => {
        const chunk = chunks.find((candidate) =>
          Object.keys(candidate.modules).some((id) =>
            id.endsWith(`/console/src/pages/${page}.tsx`),
          ),
        );
        assert.ok(chunk, `Missing ${page} route chunk`);
        assert.ok(!initial.includes(chunk), `${page} is not lazy-loaded`);
        for (const id of modules(dependencies([chunk]))) {
          assert.doesNotMatch(id, reportOnly);
        }
      },
    );
  }
});
