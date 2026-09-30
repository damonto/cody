import { DurableObject } from "cloudflare:workers";
import { gatewayApp } from "../../gateway/app.ts";
import { apiError } from "../../gateway/http/http.ts";
import {
  httpExecutionEndpoint,
  requestProtocol,
} from "../../gateway/protocol.ts";

/** One HTTP request per object; durable coordination stays in the existing objects. */
export class HttpExecution extends DurableObject<Env> {
  private readonly cancellation = new AbortController();
  private execution: Promise<Response> | undefined;
  private pipeline: Promise<void> | undefined;
  private readonly pending = new Set<Promise<unknown>>();

  async cancel(): Promise<void> {
    this.cancellation.abort(
      new DOMException("Client disconnected", "AbortError"),
    );
    await this.execution?.catch(() => {});
    await this.pipeline;
    // Cancellation can finish metering. Keep this RPC alive until its durable
    // outbox writes and health updates have settled.
    await this.drain();
  }

  private async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private background(task: Promise<unknown>): void {
    this.pending.add(task);
    this.ctx.waitUntil(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {});
  }

  override async fetch(request: Request): Promise<Response> {
    if (this.execution) {
      return apiError(
        requestProtocol(request, httpExecutionEndpoint(request)),
        409,
        "This HTTP executor has already accepted a request",
        { code: "execution_already_started" },
      );
    }
    this.execution = this.execute(request);
    return this.execution;
  }

  private async execute(request: Request): Promise<Response> {
    // Call the shared app directly, never the Worker dispatcher. All parsing,
    // authentication, provider work and stream observation execute in this DO.
    const signal = AbortSignal.any([request.signal, this.cancellation.signal]);
    const response = await gatewayApp.fetch(
      new Request(request, { signal }),
      this.env,
      {
        props: {},
        waitUntil: (task) => this.background(task),
        passThroughOnException() {
          throw new Error("HTTP execution cannot pass through exceptions");
        },
      },
    );
    if (!response.body) return response;
    if (signal.aborted) {
      await response.body.cancel().catch(() => {});
      return new Response(null, response);
    }
    let abortStream = () => {};
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        abortStream = () => controller.terminate();
      },
    });
    // pipeTo waits for an in-flight write before cancelling its source.
    // terminate closes the reader and rejects that write without waiting for
    // a disconnected client to consume buffered data.
    signal.addEventListener("abort", abortStream, { once: true });
    if (signal.aborted) abortStream();
    this.pipeline = response.body
      .pipeTo(writable, { signal, preventAbort: true })
      .catch(async (error: unknown) => {
        // Persist the failed/cancelled outcome before ending the subrequest.
        await this.drain();
        if (signal.aborted) return;
        const writer = writable.getWriter();
        try {
          // Genuine upstream failures must reach the client as stream errors.
          await writer.abort(error);
        } catch {
          // The downstream may have cancelled independently of the request signal.
        } finally {
          writer.releaseLock();
        }
      })
      .finally(() => signal.removeEventListener("abort", abortStream));
    this.ctx.waitUntil(this.pipeline);
    return new Response(readable, response);
  }
}
