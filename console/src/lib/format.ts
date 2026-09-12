export const number = (value: number | null | undefined) =>
  value === null || value === undefined
    ? "—"
    : new Intl.NumberFormat("en-US").format(value);
export const compact = (value: number | null | undefined) =>
  value === null || value === undefined
    ? "—"
    : new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(value);
export const duration = (value: number | null | undefined) =>
  value === null || value === undefined
    ? "—"
    : value < 1000
      ? `${Math.round(value)} ms`
      : `${(value / 1000).toFixed(2)} s`;
export function money(
  nano: number | null | undefined,
  currency: string,
): string {
  if (nano === null || nano === undefined || !currency) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(nano / 1e9);
}
export const date = (
  value: number | null | undefined,
  timeZone = "Asia/Shanghai",
) =>
  value === null || value === undefined
    ? "—"
    : new Intl.DateTimeFormat("en-US", {
        timeZone,
        dateStyle: "medium",
        timeStyle: "medium",
      }).format(value);
export const label = (value: string) => value.replaceAll("_", " ");
