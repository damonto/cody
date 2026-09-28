import type { Bindings } from "../../platform/bindings.ts";
import type { AccountLimit } from "../types.ts";
import { accountReply, accountViewSchema } from "../oauth/schema.ts";
import { apiError } from "../../gateway/http/http.ts";
import type { ApiProtocol } from "../../gateway/protocol-values.ts";
import { ProviderRequestError } from "../errors.ts";

export async function recordXaiLimit(
  env: Pick<Bindings, "PROVIDER_OAUTH_ACCOUNT">,
  ref: string,
  generation: number | undefined,
  limit: AccountLimit,
): Promise<void> {
  if (generation === undefined)
    throw new ProviderRequestError("xAI account generation is missing", 500);
  let until = limit.resets_at;
  if (limit.reset_source === "fallback") {
    const view = await accountReply(
      env.PROVIDER_OAUTH_ACCOUNT.getByName(ref).run({ action: "view" }),
      accountViewSchema,
    );
    const resets =
      limit.kind === "spending"
        ? [Date.parse(view.quota.xai_billing?.billing_period_end ?? "")]
        : view.quota.groups
            .filter((group) => !group.model || group.model === limit.model)
            .flatMap((group) =>
              group.buckets
                .filter((bucket) => (bucket.used_percent ?? 0) >= 100)
                .map((bucket) => Date.parse(bucket.reset_at ?? "")),
            );
    const future = resets.filter(
      (reset) => Number.isFinite(reset) && reset > Date.now(),
    );
    if (future.length) until = Math.max(...future);
  }
  await accountReply(
    env.PROVIDER_OAUTH_ACCOUNT.getByName(ref).run({
      action: "xai_limit",
      generation,
      model: limit.model ?? null,
      kind: limit.kind ?? "subscription",
      until,
    }),
    accountViewSchema,
  );
}
export function xaiQuotaResponse(
  protocol: ApiProtocol,
  until?: number,
  requestId?: string,
): Response {
  const response = apiError(
    protocol,
    429,
    `xAI account quota exhausted${until ? ` until ${new Date(until).toISOString()}` : ""}`,
    { code: "usage_limit_reached", ...(requestId ? { requestId } : {}) },
  );
  if (until)
    response.headers.set(
      "retry-after",
      String(Math.max(1, Math.ceil((until - Date.now()) / 1000))),
    );
  return response;
}
