import { CircleAlert } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  compareUpstream,
  type MetadataDifference,
  type UpstreamObservation,
} from "../../../../src/shared/upstream-observation.ts";

const differenceLabels = {
  model: "Model mismatch",
  effort: "Reasoning effort mismatch",
  mode: "Thinking mode mismatch",
  budget_tokens: "Thinking budget mismatch",
} satisfies Record<MetadataDifference["field"], string>;

function differenceValue(
  difference: MetadataDifference,
  value: string | number,
): string {
  return difference.field === "budget_tokens"
    ? `${value} tokens`
    : String(value);
}

export function UpstreamMismatchIndicator({
  observation,
  field,
}: {
  observation: UpstreamObservation | undefined;
  field?: MetadataDifference["field"];
}) {
  const comparison = compareUpstream(observation);
  const differences = field
    ? comparison.differences.filter((difference) => difference.field === field)
    : comparison.differences;
  if (!differences.length) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={
            field ? differenceLabels[field] : "Upstream response differs"
          }
          className="inline-flex size-5 shrink-0 cursor-help items-center justify-center rounded-sm text-amber-500 outline-none hover:text-amber-600 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <CircleAlert className="size-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={6}
        className="block max-w-sm space-y-3 py-3"
      >
        {differences.map((difference) => (
          <div key={difference.field} className="space-y-1">
            <p className="font-medium">{differenceLabels[difference.field]}</p>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
              <dt className="opacity-70">Requested</dt>
              <dd className="break-all font-mono">
                {differenceValue(difference, difference.requested)}
              </dd>
              <dt className="opacity-70">Returned</dt>
              <dd className="break-all font-mono">
                {differenceValue(difference, difference.returned)}
              </dd>
            </dl>
          </div>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}
