/** ChatGPT plan identifiers reported by Codex tokens and `/wham/usage`. */
const PLAN_LABELS: Readonly<Record<string, string>> = {
  guest: "Guest",
  free_workspace: "Free workspace",
  free: "Free",
  go: "Go",
  plus: "Plus",
  prolite: "Pro 5x",
  "pro-lite": "Pro 5x",
  pro_lite: "Pro 5x",
  pro_5x: "Pro 5x",
  pro: "Pro 20x",
  pro_20x: "Pro 20x",
  promax: "Pro (Max)",
  team: "Team",
  self_serve_business_prolite: "Business 5x",
  business_premium_5x: "Business 5x",
  self_serve_business_usage_based: "Business PAYG",
  business_usage_based: "Business PAYG",
  business: "Business",
  ent26: "Enterprise",
  hc: "Enterprise",
  enterprise: "Enterprise",
  enterprise_cbp_automation: "Enterprise Automation",
  enterprise_automation: "Enterprise Automation",
  enterprise_cbp_usage_based: "Enterprise PAYG",
  education: "Education",
  quorum: "Quorum",
  k12: "K12",
  edu: "Edu",
  edu_plus: "Edu Plus",
  edu_pro: "Edu Pro",
};

export function planLabel(plan: string | null | undefined): string {
  if (!plan) return "Unknown plan";
  const key = plan.trim().toLowerCase();
  return PLAN_LABELS[key] ?? key.replaceAll("_", " ");
}

const DAY_MS = 86_400_000;

/** Whole days until an ISO timestamp, or null when it is unknown. */
export function daysUntil(
  value: string | null | undefined,
  now: number,
): number | null {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp)
    ? Math.ceil((timestamp - now) / DAY_MS)
    : null;
}

export type Tone = "ok" | "warn" | "bad";

/** Remaining quota colour: empty is red, under 20% is amber. */
export function remainingTone(percent: number): Tone {
  if (percent <= 0) return "bad";
  if (percent < 20) return "warn";
  return "ok";
}

/** Subscription expiry colour: three days or less is red, a week is amber. */
export function expiryTone(days: number): Tone {
  if (days <= 3) return "bad";
  if (days <= 7) return "warn";
  return "ok";
}

export const toneText: Readonly<Record<Tone, string>> = {
  ok: "text-emerald-700 dark:text-emerald-300",
  warn: "text-amber-700 dark:text-amber-300",
  bad: "text-red-700 dark:text-red-300",
};
export const toneBar: Readonly<Record<Tone, string>> = {
  ok: "[&>[data-slot=progress-indicator]]:bg-emerald-500",
  warn: "[&>[data-slot=progress-indicator]]:bg-amber-500",
  bad: "[&>[data-slot=progress-indicator]]:bg-red-500",
};

const MINUTE_MS = 60_000;
/** Display units in minutes, largest first. */
const UNITS = [
  ["d", 1440],
  ["h", 60],
  ["m", 1],
] as const;

/** The largest unit plus the next one when it is not zero, such as `2h 5m` or `3d`. */
function span(minutes: number): string {
  const index = UNITS.findIndex(([, size]) => minutes >= size);
  if (index === -1) return "<1m";
  const [unit, size] = UNITS[index];
  const major = `${Math.floor(minutes / size)}${unit}`;
  const next = UNITS.at(index + 1);
  if (!next) return major;
  const minor = Math.floor((minutes % size) / next[1]);
  return minor ? `${major} ${minor}${next[0]}` : major;
}

/** A compact relative time such as `in 2h 5m` or `3d ago`. */
export function relative(timestamp: number, now: number): string {
  const delta = timestamp - now;
  const text = span(Math.round(Math.abs(delta) / MINUTE_MS));
  return delta >= 0 ? `in ${text}` : `${text} ago`;
}
