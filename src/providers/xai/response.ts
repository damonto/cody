import { ProviderRequestError } from "../errors.ts";
import {
  notifyUpstreamMetadata,
  responseMetadata,
  isTerminalResponse,
} from "../../telemetry/inference-metadata.ts";
import { apiError } from "../../gateway/http/http.ts";
import { ApiProtocol } from "../../gateway/protocol-values.ts";
import { readBodyWithinLimit } from "../../gateway/http/body.ts";
import { object, text, type Wire } from "./json.ts";
import { xaiErrorDetails } from "./errors.ts";
import { xaiEvents } from "./sse.ts";
import { ResponseEncoder, type EncodingOptions } from "./response-encoder.ts";
export { xaiUsage } from "./response-encoder.ts";
export { xaiEvents } from "./sse.ts";
export async function convertResponse(
  response: Response,
  options: EncodingOptions,
): Promise<Response> {
  const protocol = options.anthropic
    ? ApiProtocol.Anthropic
    : ApiProtocol.Openai;
  if (!response.ok) {
    const data = await readBodyWithinLimit(
      response.body,
      1024 * 1024,
      response.headers.get("content-length"),
      undefined,
      options.signal,
    );
    let error: Wire = {};
    try {
      error = object(JSON.parse(new TextDecoder().decode(data)));
    } catch {
      /* safe generic error */
    }
    const details = xaiErrorDetails(error);
    const message = details.message || "xAI upstream request failed";
    const result = apiError(protocol, response.status, message, {
      code:
        response.status === 426
          ? "client_outdated"
          : details.code || "upstream_error",
    });
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) result.headers.set("retry-after", retryAfter);
    return result;
  }
  if (!response.body)
    throw new ProviderRequestError("xAI returned an empty stream", 502);
  const abort = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, abort.signal])
    : abort.signal;
  const encoder = new ResponseEncoder(options);
  const source = xaiEvents(response.body, signal);
  async function* translated() {
    try {
      for await (const event of source) {
        notifyUpstreamMetadata(
          options.observe,
          responseMetadata(event, ApiProtocol.Openai),
          isTerminalResponse(event),
        );
        for (const output of await encoder.accept(event)) yield output;
        if (encoder.terminal) break;
      }
      if (!encoder.terminal)
        throw new ProviderRequestError(
          "xAI stream ended without a terminal event",
          502,
        );
    } finally {
      await source.return(undefined);
    }
  }
  const iterator = translated();
  if (!options.stream) {
    for await (const _event of iterator) {
      /* Same state machine, bounded final output. */
    }
    if (encoder.result?.status === "failed")
      return apiError(protocol, 502, "xAI inference failed", {
        code: "upstream_error",
      });
    return Response.json(encoder.result);
  }
  const bytes = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) {
            controller.close();
            return;
          }
          controller.enqueue(
            bytes.encode(
              `event: ${text(next.value.type)}\ndata: ${JSON.stringify(next.value)}\n\n`,
            ),
          );
        } catch {
          const error = options.anthropic
            ? {
                type: "error",
                error: {
                  type: "api_error",
                  message: "xAI stream ended unexpectedly",
                },
              }
            : {
                type: "error",
                code: "upstream_stream_error",
                message: "xAI stream ended unexpectedly",
              };
          controller.enqueue(
            bytes.encode(`event: error\ndata: ${JSON.stringify(error)}\n\n`),
          );
          controller.close();
        }
      },
      async cancel(reason) {
        abort.abort(reason);
        await iterator.return(undefined);
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    },
  );
}
