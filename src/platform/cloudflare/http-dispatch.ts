import { apiError } from "../../gateway/http/http.ts";
import {
  requestProtocol,
  type HttpExecutionEndpoint,
} from "../../gateway/protocol.ts";

/** Stream the request through one executor; never replay a failed dispatch. */
export async function dispatchHttpExecution(
  request: Request,
  endpoint: HttpExecutionEndpoint,
  env: Pick<Env, "HTTP_EXECUTION">,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<Response> {
  let cancel: (() => void) | undefined;
  try {
    const id = env.HTTP_EXECUTION.newUniqueId();
    const stub = env.HTTP_EXECUTION.get(id);
    let cancelling = false;
    const cancelExecution = async () => {
      try {
        await stub.cancel();
      } catch {
        // A failed fetch/RPC may poison its stub. Cleanup is idempotent and
        // may use a fresh stub, but the inference request must never be resent.
        try {
          await env.HTTP_EXECUTION.get(id).cancel();
        } catch {
          console.warn({ event: "http.execution.cancel_failed", endpoint });
        }
      }
    };
    cancel = () => {
      if (cancelling) return;
      cancelling = true;
      ctx.waitUntil(cancelExecution());
    };
    request.signal.addEventListener("abort", cancel, { once: true });
    if (request.signal.aborted) cancel();

    // The explicit cancellation RPC lets the executor finish its usage journal
    // before the platform tears down the fetch context. Neither body is read here.
    const response = await stub.fetch(request, {
      signal: new AbortController().signal,
    });
    if (!response.body) request.signal.removeEventListener("abort", cancel);
    return response;
  } catch {
    if (cancel) {
      request.signal.removeEventListener("abort", cancel);
      // A transport failure can occur after the executor started its upstream.
      cancel();
    }
    console.error({ event: "http.execution.failed", endpoint });
    return apiError(
      requestProtocol(request, endpoint),
      502,
      "The gateway failed to execute the request",
      { code: "execution_unavailable" },
    );
  }
}
