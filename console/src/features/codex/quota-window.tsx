import type { QuotaSnapshot } from "../../../../src/providers/oauth/schema";
import { date } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { relative, remainingTone, toneBar, toneText } from "./plan";

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
  const remaining =
    bucket.remaining_fraction === null
      ? null
      : Math.round(bucket.remaining_fraction * 100);
  const tone = remaining === null ? null : remainingTone(remaining);
  const resetAt = bucket.reset_at ? Date.parse(bucket.reset_at) : NaN;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{bucket.label}</span>
        <span
          className={cn("font-medium tabular-nums", tone && toneText[tone])}
        >
          {remaining === null ? "Unknown" : `${remaining}% left`}
        </span>
      </div>
      <Progress
        value={remaining ?? 0}
        className={cn("h-1.5", tone && toneBar[tone])}
        aria-label={`${group} ${bucket.label} remaining`}
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
