import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

const quotaStyles = {
  ok: {
    text: "text-emerald-700 dark:text-emerald-300",
    bar: "[&>[data-slot=progress-indicator]]:bg-emerald-500",
  },
  warn: {
    text: "text-amber-700 dark:text-amber-300",
    bar: "[&>[data-slot=progress-indicator]]:bg-amber-500",
  },
  bad: {
    text: "text-red-700 dark:text-red-300",
    bar: "[&>[data-slot=progress-indicator]]:bg-red-500",
  },
  unknown: {
    text: "text-muted-foreground",
    bar: "[&>[data-slot=progress-indicator]]:bg-muted-foreground",
  },
};

function quotaTone(remaining: number | null) {
  if (remaining === null) return quotaStyles.unknown;
  if (remaining === 0) return quotaStyles.bad;
  if (remaining < 20) return quotaStyles.warn;
  return quotaStyles.ok;
}

function remainingLabel(remaining: number | null): string {
  if (remaining === null) return "Unknown";
  if (remaining > 0 && remaining < 1) return "<1% left";
  return `${Math.round(remaining)}% left`;
}

/** Shared remaining-quota presentation for native provider accounts. */
export function QuotaProgress({
  label,
  remainingFraction,
  ariaLabel,
}: {
  label: string;
  remainingFraction: number | null;
  ariaLabel: string;
}) {
  const remaining = remainingFraction === null ? null : remainingFraction * 100;
  const tone = quotaTone(remaining);
  const valueLabel = remainingLabel(remaining);

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn("font-medium tabular-nums", tone.text)}>
          {valueLabel}
        </span>
      </div>
      <Progress
        value={remaining}
        className={cn("h-1.5", tone.bar)}
        aria-label={ariaLabel}
        aria-valuetext={valueLabel}
      />
    </div>
  );
}
