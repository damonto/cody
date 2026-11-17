import { z } from "zod";

const grant = {
  grant_hash: z.string().regex(/^[a-f0-9]{64}$/),
  started_at: z.number().int().nonnegative(),
};
export const codexRefreshSchema = z
  .discriminatedUnion("status", [
    z.object({ ...grant, status: z.literal("pending") }),
    z.object({
      ...grant,
      status: z.literal("completed"),
      rotated: z.boolean(),
    }),
  ])
  .nullable()
  .default(null);

export function codexRefreshBlocked(
  refresh: z.output<typeof codexRefreshSchema>,
): boolean {
  return !!refresh && (refresh.status === "pending" || !refresh.rotated);
}

export function parseEarliestRefreshAt(value: unknown): number | undefined {
  let time: number;
  if (typeof value === "number") time = value * 1000;
  else if (typeof value === "string" && value.trim()) {
    const seconds = Number(value);
    time = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value);
  } else return undefined;
  if (Number.isSafeInteger(time) && time >= 0 && time <= 8_640_000_000_000_000)
    return time;
  return undefined;
}
