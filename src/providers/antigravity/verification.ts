import { z } from "zod";
import {
  googleVerificationUrlSchema,
  type AntigravityVerification,
} from "../../shared/antigravity-verification.ts";
import { OAuthError } from "../oauth/schema.ts";

const record = z.record(z.string(), z.unknown());
function object(value: unknown): Record<string, unknown> {
  const parsed = record.safeParse(value);
  return parsed.success ? parsed.data : {};
}
function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // URLs belong in validated links, never in error messages or logs.
  return (
    value
      .replace(/https?:\/\/\S+/gi, "[link]")
      .trim()
      .slice(0, 1000) || null
  );
}
function url(value: unknown): string | null {
  const parsed = googleVerificationUrlSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export class AntigravityVerificationError extends OAuthError {
  readonly verification: AntigravityVerification[];
  constructor(items: AntigravityVerification[]) {
    const verification = mergeVerification(items);
    super(
      [...new Set(verification.map((item) => item.message))].join(" "),
      403,
      "account_verification_required",
    );
    this.verification = verification;
  }
}

/** Deduplicate repeated requirements without dropping distinct instructions. */
export function mergeVerification(
  items: AntigravityVerification[],
): AntigravityVerification[] {
  const merged = new Map<string, AntigravityVerification>();
  for (const item of items) {
    const key = JSON.stringify([item.reason, item.message, item.url]);
    const previous = merged.get(key);
    merged.set(key, {
      ...item,
      learn_more_url: previous?.learn_more_url ?? item.learn_more_url,
    });
  }
  return [...merged.values()];
}

interface VerificationFields {
  message: string | null;
  url: string | null;
  learn_more_url: string | null;
}

function verificationReason(
  reason: unknown,
): AntigravityVerification["reason"] | null {
  // ProtoJSON permits both enum names and numbers.
  switch (reason) {
    case 5:
    case "RESTRICTED_AGE":
      return "RESTRICTED_AGE";
    case 10:
    case "VALIDATION_REQUIRED":
      return "VALIDATION_REQUIRED";
    default:
      return null;
  }
}

function requirement(
  reason: unknown,
  fields: VerificationFields,
): AntigravityVerification | null {
  const code = verificationReason(reason);
  if (!code) return null;
  return {
    reason: code,
    message:
      fields.message ??
      (code === "RESTRICTED_AGE"
        ? "Google requires age verification. Antigravity is only available to users aged 18 or older."
        : "Google requires account verification before you can use Antigravity."),
    url:
      fields.url ??
      (code === "RESTRICTED_AGE"
        ? "https://myaccount.google.com/age-verification"
        : null),
    learn_more_url: fields.learn_more_url,
  };
}

export function tierVerificationError(
  tiers: Record<string, unknown>[],
): AntigravityVerificationError | null {
  const verification = tiers.flatMap((tier) => {
    const item = requirement(tier.reasonCode, {
      message: text(tier.validationErrorMessage) ?? text(tier.reasonMessage),
      url: url(tier.validationUrl),
      learn_more_url: url(tier.validationLearnMoreUrl),
    });
    return item ? [item] : [];
  });
  return verification.length
    ? new AntigravityVerificationError(verification)
    : null;
}

function helpVerificationUrl(
  details: Record<string, unknown>[],
): string | null {
  for (const detail of details) {
    if (
      detail["@type"] !== "type.googleapis.com/google.rpc.Help" ||
      !Array.isArray(detail.links)
    )
      continue;
    for (const link of detail.links) {
      const candidate = url(object(link).url);
      if (
        candidate &&
        ["accounts.google.com", "myaccount.google.com"].includes(
          new URL(candidate).hostname,
        )
      )
        return candidate;
    }
  }
  return null;
}

/** Google RPC errors can occur on load, onboarding, model discovery or quota. */
export function rpcVerificationError(
  error: unknown,
): AntigravityVerificationError | null {
  const data = object(error);
  if (!Array.isArray(data.details)) return null;
  const details = data.details.map(object);
  const helpUrl = helpVerificationUrl(details);
  const verification = details.flatMap((detail) => {
    if (detail["@type"] !== "type.googleapis.com/google.rpc.ErrorInfo")
      return [];
    const metadata = object(detail.metadata);
    const item = requirement(detail.reason, {
      message: text(metadata.validation_error_message) ?? text(data.message),
      // Prefer Google's specific action before the generic age-verification page.
      url: url(metadata.validation_url) ?? helpUrl,
      learn_more_url: url(metadata.validation_learn_more_url),
    });
    return item ? [item] : [];
  });
  return verification.length
    ? new AntigravityVerificationError(verification)
    : null;
}
