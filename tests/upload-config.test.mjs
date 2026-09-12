import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execute = promisify(execFile);
const script = new URL("../scripts/upload-config.mjs", import.meta.url).href;
const configuration = fileURLToPath(
  new URL("../config.example.json", import.meta.url),
);

for (const [name, base, local] of [
  ["gateway origin", "https://gateway.example", false],
  ["console URL", "https://gateway.example/console/", false],
  ["local development", "https://unused.example", true],
]) {
  test(`configuration upload stays under /console/api for ${name}`, async () => {
    const origin = local ? "http://localhost:8788" : "https://gateway.example";
    const harness = `
      import assert from "node:assert/strict";
      process.argv = ["node", "upload-config", ${JSON.stringify(configuration)},
        ...${JSON.stringify(local ? ["--local"] : [])}];
      const requests = [];
      globalThis.fetch = async (url, options) => {
        requests.push(new Request(url, options));
        return Response.json(requests.length === 1 ? { version: 4 }
          : requests.length === 2 ? { version: 5 } : { published_revision: 9 });
      };
      await import(${JSON.stringify(script)});
      assert.equal(process.exitCode, undefined);
      assert.deepEqual(requests.map((request) => [request.method, request.url]), [
        ["GET", ${JSON.stringify(`${origin}/console/api/config`)}],
        ["PUT", ${JSON.stringify(`${origin}/console/api/config`)}],
        ["POST", ${JSON.stringify(`${origin}/console/api/config/publish`)}],
      ]);
      for (const request of requests) {
        assert.equal(request.headers.get("x-cody-admin"), "1");
        assert.equal(request.headers.get("cf-access-client-id"), "test-access-id");
        assert.equal(request.headers.get("cf-access-client-secret"), "test-access-secret");
        assert.equal(request.redirect, "error");
      }
      const draft = await requests[1].json();
      assert.equal(draft.version, 4);
      assert.ok(draft.config.services.length > 0);
      assert.deepEqual(await requests[2].json(), { version: 5 });
    `;
    const { stdout } = await execute(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", harness],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: {
          ...process.env,
          CODY_ADMIN_URL: base,
          CF_ACCESS_CLIENT_ID: "test-access-id",
          CF_ACCESS_CLIENT_SECRET: "test-access-secret",
        },
      },
    );
    assert.match(stdout, /Published configuration revision 9/);
  });
}
