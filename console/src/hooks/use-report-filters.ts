import { useSearchParams } from "react-router-dom";
import {
  reportQuerySchema,
  type ReportQueryParams,
} from "../../../src/reporting/query";

type ReportFilterChanges = Partial<Record<keyof ReportQueryParams, string>>;
export type ChangeReportFilter = (
  key: keyof ReportQueryParams,
  value: string,
) => void;

export function useReportFilters() {
  const [search, setSearch] = useSearchParams();
  const parsed = reportQuerySchema.safeParse(Object.fromEntries(search));
  const filters = parsed.success ? parsed.data : reportQuerySchema.parse({});
  const { limit, from, to, ...rest } = filters;
  const values = {
    ...rest,
    limit: String(limit),
    from: from?.toString(),
    to: to?.toString(),
  } satisfies ReportQueryParams;
  const apply = (changes: ReportFilterChanges) =>
    setSearch((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      next.delete("cursor");
      if ("service_id" in changes && !("model" in changes))
        next.delete("model");
      if ("period" in changes && changes.period !== "custom") {
        next.delete("from");
        next.delete("to");
      }
      return next;
    });
  return {
    values,
    apply,
    change: (key: keyof ReportQueryParams, value: string) =>
      apply({ [key]: value }),
    reset: () => setSearch({}),
    invalid: parsed.success
      ? null
      : parsed.error.issues.map((issue) => issue.message).join(". "),
  };
}
