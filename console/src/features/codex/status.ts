import { OAuthAccountViewStatus } from "../../../../src/providers/oauth/values.ts";
import { HealthCooldownReason } from "../../../../src/gateway/health/values.ts";

import { useEffect, useState } from "react";
import type { CodexProviderConfig } from "../../../../src/config/types";
import type {
  AccountHealth,
  AccountView,
  ResetCredit,
} from "../../../../src/providers/oauth/schema";
import { date, label as humanize } from "../../lib/format";
import { relative, type Tone } from "./plan";

type Credential = CodexProviderConfig["credentials"][number];
export interface HealthBadge {
  text: string;
  tone: Tone | "muted";
  title?: string;
}

/** A render-stable clock that ticks so relative times and expiries stay current. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Lowest remaining percentage across every reported window. */
function lowestRemaining(account: AccountView): number | null {
  const values = account.quota.groups.flatMap((group) =>
    group.buckets.flatMap((bucket) =>
      bucket.remaining_fraction === null ? [] : [bucket.remaining_fraction],
    ),
  );
  return values.length ? Math.round(Math.min(...values) * 100) : null;
}

export function healthBadge(
  credential: Credential,
  account: AccountView | undefined,
  health: AccountHealth | undefined,
  now: number,
): HealthBadge {
  if (credential.disabled) return { text: "Disabled", tone: "muted" };
  if (!account) return { text: "Unknown", tone: "muted" };
  if (account.status === OAuthAccountViewStatus.NeedsReauthorization)
    return { text: "Reauthorize", tone: "bad" };
  if (account.status !== OAuthAccountViewStatus.Ready)
    return { text: humanize(account.status), tone: "warn" };
  if (health && !health.available && health.cooling_until !== null) {
    const title = date(health.cooling_until);
    return health.cooldown_reason === HealthCooldownReason.Quota
      ? {
          text: `Exhausted · back ${relative(health.cooling_until, now)}`,
          tone: "bad",
          title,
        }
      : {
          text: `Cooling ${relative(health.cooling_until, now)}`,
          tone: "warn",
          title,
        };
  }
  if (account.quota.limit_reached) return { text: "Exhausted", tone: "bad" };
  const lowest = lowestRemaining(account);
  if (lowest !== null && lowest < 20)
    return { text: "Low quota", tone: "warn" };
  return { text: "Available", tone: "ok" };
}

export function creditExpiry(credit: ResetCredit): number {
  const value = credit.expires_at ? Date.parse(credit.expires_at) : NaN;
  return Number.isFinite(value) ? value : Infinity;
}
/** Spendable credits, the one expiring first leading; `redeeming` and `redeemed` ones are not. */
export function usableCredits(
  credits: readonly ResetCredit[],
  now: number,
): ResetCredit[] {
  return credits
    .filter(
      (credit) =>
        credit.status?.toLowerCase() === "available" &&
        creditExpiry(credit) > now,
    )
    .sort((left, right) => creditExpiry(left) - creditExpiry(right));
}
