import type { QuotaSnapshot } from "../../../../src/providers/oauth/schema";
import { date } from "@/lib/format";
import { QuotaProgress } from "@/features/oauth-accounts/quota-progress";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { relative } from "./plan";

type Bucket = QuotaSnapshot["groups"][number]["buckets"][number];

/** One rate-limit window: percent remaining, a coloured bar and its reset time. */
export function QuotaWindow({
  group,
  bucket,
  now,
}: {
  group: string;
  bucket: Bucket;
  now: number;
}) {
  const resetAt = bucket.reset_at ? Date.parse(bucket.reset_at) : NaN;
  return (
    <div className="space-y-1.5">
      <QuotaProgress
        label={bucket.label}
        remainingFraction={bucket.remaining_fraction}
        ariaLabel={`${group} ${bucket.label} remaining`}
      />
      <p className="text-[11px] text-muted-foreground">
        {Number.isFinite(resetAt) ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-default">
                Resets {relative(resetAt, now)}
              </span>
            </TooltipTrigger>
            <TooltipContent>{date(resetAt)}</TooltipContent>
          </Tooltip>
        ) : (
          "Reset time unknown"
        )}
      </p>
    </div>
  );
}
