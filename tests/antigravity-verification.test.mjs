import assert from "node:assert/strict";
import test from "node:test";
import {
  AntigravityClient,
  onboardingTier,
  parseSubscription,
} from "../src/providers/antigravity/api.ts";
import { AntigravityVerificationError } from "../src/providers/antigravity/verification.ts";
import { configureLogging } from "../src/shared/log.ts";

const challenge =
  "https://accounts.google.com/signin/continue?authuser=1&state=private-challenge%2Bvalue";
const help = "https://support.google.com/accounts?p=al_alert";
function rpcError(url = challenge) {
  return {
    code: 403,
    message: `Verify your account at ${url}`,
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "VALIDATION_REQUIRED",
        domain: "cloudcode-pa.googleapis.com",
        metadata: {
          validation_error_message: "Verify your account to continue.",
          validation_url: url,
          validation_learn_more_url: help,
        },
      },
    ],
  };
}

test("age and account verification take priority over user-managed project requirements", async () => {
  const result = {
    allowedTiers: [
      {
        id: "standard-tier",
        isDefault: true,
        userDefinedCloudaicompanionProject: true,
      },
    ],
    ineligibleTiers: [
      { tierId: "free-tier", reasonCode: "RESTRICTED_AGE" },
      {
        tierId: "free-tier",
        reasonCode: "VALIDATION_REQUIRED",
        validationErrorMessage: "Complete the account check.",
        validationUrl: challenge,
        validationLearnMoreUrl: help,
      },
    ],
  };
  const check = (error) => {
    assert.ok(error instanceof AntigravityVerificationError);
    assert.match(error.message, /age verification/);
    assert.match(error.message, /Complete the account check/);
    assert.doesNotMatch(error.message, /project|private-challenge/);
    assert.deepEqual(
      error.verification.map((item) => item.url),
      ["https://myaccount.google.com/age-verification", challenge],
    );
    assert.equal(error.verification[1].learn_more_url, help);
    return true;
  };
  assert.throws(() => onboardingTier(result), check);
  await assert.rejects(
    new AntigravityClient(async () => Response.json(result)).load("token"),
    check,
  );
  // Ineligibility for a different tier must not block an assigned project.
  const assigned = { ...result, cloudaicompanionProject: "assigned-project" };
  assert.deepEqual(
    await new AntigravityClient(async () => Response.json(assigned)).load(
      "token",
    ),
    assigned,
  );
});

test("Google RPC verification survives HTTP and operation errors without logging the challenge", async (t) => {
  const logs = [];
  configureLogging("warn");
  t.after(() => configureLogging("off"));
  t.mock.method(console, "warn", (...args) => logs.push(args));
  for (const operation of ["load", "onboard", "quota", "models"]) {
    const client = new AntigravityClient(async () =>
      Response.json({ error: rpcError() }, { status: 403 }),
    );
    await assert.rejects(client[operation]("token", "project"), (error) => {
      assert.equal(error.code, "account_verification_required");
      assert.equal(error.message, "Verify your account to continue.");
      assert.equal(error.verification[0].url, challenge);
      return true;
    });
  }
  const client = new AntigravityClient(async () =>
    Response.json({ done: true, error: rpcError() }),
  );
  await assert.rejects(client.onboard("token", "free-tier"), {
    code: "account_verification_required",
  });
  assert.match(JSON.stringify(logs), /VALIDATION_REQUIRED/);
  assert.doesNotMatch(
    JSON.stringify(logs),
    /private-challenge|signin\/continue/,
  );
});

test("verification links reject untrusted origins while preserving Google's signed query", async () => {
  for (const candidate of [
    "javascript:alert(1)",
    "http://accounts.google.com/check",
    "https://accounts.google.com.evil.test/check",
    "https://accounts.google.com@evil.test/",
    "https://user:pass@accounts.google.com/check",
    "https://accounts.google.com:8443/check",
  ]) {
    const client = new AntigravityClient(async () =>
      Response.json({ error: rpcError(candidate) }, { status: 403 }),
    );
    await assert.rejects(client.load("token"), (error) => {
      assert.equal(error.verification[0].url, null);
      return true;
    });
  }
  const error = rpcError();
  delete error.details[0].metadata.validation_url;
  delete error.details[0].metadata.validation_error_message;
  error.details.push({
    "@type": "type.googleapis.com/google.rpc.Help",
    links: [{ url: challenge }],
  });
  await assert.rejects(
    new AntigravityClient(async () =>
      Response.json({ error }, { status: 403 }),
    ).quota("token", "project"),
    (error) => {
      assert.equal(error.verification[0].url, challenge);
      assert.equal(error.message, "Verify your account at [link]");
      return true;
    },
  );
});

test("proto3 credit amounts distinguish zero defaults, invalid values and absent inventories", () => {
  const values = [
    undefined,
    null,
    0,
    "0",
    "9007199254740993",
    "",
    "unavailable",
    1.5,
    Number.NaN,
    {},
    9007199254740992,
  ];
  const result = parseSubscription({
    paidTier: {
      id: "pro",
      availableCredits: values.map((value) => ({
        creditType: "GOOGLE_ONE_AI",
        ...(value === undefined ? {} : { creditAmount: value }),
      })),
    },
  });
  assert.deepEqual(
    result.credits.map((item) => item.amount),
    ["0", "0", 0, "0", "9007199254740993", null, null, null, null, null, null],
  );
  assert.deepEqual(
    parseSubscription({ currentTier: { id: "free-tier" } }).credits,
    [],
  );
  assert.deepEqual(
    parseSubscription({
      current_tier: {
        id: "pro",
        available_credits: [{ credit_type: "GOOGLE_ONE_AI" }, null],
      },
    }).credits,
    [{ type: "GOOGLE_ONE_AI", amount: "0" }],
  );
});

test("age verification prefers Google's specific Help link and metadata link over the generic page", async () => {
  for (const explicit of [
    undefined,
    "https://myaccount.google.com/age-verification?authuser=2",
  ]) {
    const error = rpcError(explicit);
    error.details[0].reason = "RESTRICTED_AGE";
    if (!explicit) delete error.details[0].metadata.validation_url;
    error.details.push({
      "@type": "type.googleapis.com/google.rpc.Help",
      links: [
        { url: help },
        { url: "https://accounts.google.com.evil.test/" },
        { url: challenge },
      ],
    });
    await assert.rejects(
      new AntigravityClient(async () =>
        Response.json({ error }, { status: 403 }),
      ).load("token"),
      (error) => {
        assert.equal(error.verification[0].url, explicit ?? challenge);
        return true;
      },
    );
  }
});

test("repeated verification details merge help links while distinct instructions remain visible", async () => {
  const error = rpcError();
  const original = structuredClone(error.details[0]);
  delete error.details[0].metadata.validation_learn_more_url;
  error.details.push(original, {
    ...original,
    metadata: {
      ...original.metadata,
      validation_error_message: "Check your Google account details.",
    },
  });
  await assert.rejects(
    new AntigravityClient(async () =>
      Response.json({ error }, { status: 403 }),
    ).quota("token", "project"),
    (error) => {
      assert.equal(error.verification.length, 2);
      assert.equal(error.verification[0].learn_more_url, help);
      assert.equal(
        error.message,
        "Verify your account to continue. Check your Google account details.",
      );
      return true;
    },
  );
});
