import assert from "node:assert/strict";
import test from "node:test";
import { apiKeySchema } from "../src/admin/credential-schema.ts";
import { clientSchema } from "../src/config/schema.ts";
import { SECRET_PLACEHOLDER } from "../src/shared/secrets.ts";

test("credential responses share configuration secret normalization", () => {
  for (const api_key of ["example-key", "  example-key \n", "密钥"]) {
    const expected = clientSchema.shape.api_key.parse(api_key);
    assert.deepEqual(apiKeySchema.parse({ api_key }), { api_key: expected });
  }
});

test("credential responses reject malformed payloads and masked secrets", () => {
  for (const value of [
    null,
    [],
    "example-key",
    {},
    { api_key: undefined },
    { api_key: null },
    { api_key: 1 },
    { api_key: "" },
    { api_key: " \n\t" },
    { api_key: SECRET_PLACEHOLDER },
    { api_key: ` ${SECRET_PLACEHOLDER} ` },
    { api_key: "example-key", extra: true },
  ]) {
    assert.equal(apiKeySchema.safeParse(value).success, false);
  }
});
