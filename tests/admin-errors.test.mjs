import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { Hono } from "hono";
import { z } from "zod";
import { adminError } from "../src/admin/middleware.ts";

test("invalid account responses log complete field paths without private input values", async (t) => {
  const entries = [];
  t.mock.method(console, "error", (entry) => entries.push(entry));
  const schema = z.object({
    session: z.object({
      flow: z.literal("siwc_bind"),
      siwc: z.object({ native_generation: z.number() }),
    }),
  });
  const app = new Hono()
    .get("/console/api/provider-accounts", () => {
      schema.parse({
        session: { flow: "private-callback-code", siwc: {} },
        tokens: { access_token: "private-access-token" },
      });
    })
    .onError(adminError);
  const response = await app.request(
    "http://localhost/console/api/provider-accounts",
  );
  assert.equal(response.status, 500);
  assert.equal(
    (await response.json()).error,
    "The console received invalid data. Please try again.",
  );
  assert.deepEqual(entries[0].issues, [
    { path: '["session","flow"]', code: "invalid_value" },
    { path: '["session","siwc","native_generation"]', code: "invalid_type" },
  ]);
  assert.doesNotMatch(
    inspect(entries[0]),
    /\[Array\]|private-callback-code|private-access-token/,
  );
});
