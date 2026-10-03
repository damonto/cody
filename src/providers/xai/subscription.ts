import { decodeJwt } from "jose";
import { z } from "zod";
import type { QuotaSnapshot } from "../oauth/schema.ts";
import { OAuthError } from "../oauth/schema.ts";

// Grok Build's prod_auth.SubscriptionTier mapping; missing tier is not Free.
const tiers = [
  ["free", "Free"],
  ["supergrok", "SuperGrok"],
  ["x_basic", "X Basic"],
  ["x_premium", "X Premium"],
  ["x_premium_plus", "X Premium+"],
  ["supergrok_heavy", "SuperGrok Heavy"],
  ["supergrok_lite", "SuperGrok Lite"],
  ["supergrok_plus", "SuperGrok Plus"],
] as const;

const settingsSchema = z.object({
  subscription_tier_display: z.string().nullable().optional(),
  subscription_tier: z.string().nullable().optional(),
  allow_access: z.boolean().nullable().optional(),
});
export type XaiSettings = z.output<typeof settingsSchema>;
export function parseSettings(value: unknown): XaiSettings {
  const result = settingsSchema.safeParse(value);
  if (!result.success)
    throw new OAuthError("Invalid xAI settings response", 502);
  return result.data;
}

export function xaiSubscription(
  token: string,
  subject: string,
  settings: XaiSettings | null,
): QuotaSnapshot["subscription"] {
  const name =
    settings?.subscription_tier_display?.trim() ||
    settings?.subscription_tier?.trim();
  if (name) {
    const key = name.toLowerCase().replaceAll(" ", "_");
    const tier = tiers.find(
      ([id, label]) => id === key || label.toLowerCase() === name.toLowerCase(),
    );
    return {
      tier_id: tier?.[0] ?? key,
      tier_name: tier?.[1] ?? name,
      credits: [],
    };
  }
  try {
    const claims = decodeJwt(token);
    if (
      claims.sub !== subject ||
      (claims.iss && claims.iss !== "https://auth.x.ai") ||
      (claims.exp !== undefined && claims.exp * 1000 <= Date.now())
    )
      return null;
    const tier = claims.tier;
    if (typeof tier !== "number" || !Number.isSafeInteger(tier) || tier < 0)
      return null;
    const known = tiers[tier];
    return {
      tier_id: known?.[0] ?? `xai_tier_${tier}`,
      tier_name: known?.[1] ?? `Tier ${tier}`,
      credits: [],
    };
  } catch {
    return null;
  }
}
