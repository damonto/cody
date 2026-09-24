import type { GatewayConfig } from "../../config/types.ts";
import { abortable } from "../../shared/abort.ts";
import { logInfo, type RequestLogContext } from "../../shared/log.ts";
import type { HealthExecutionContext } from "../health/health.ts";
import type { UpstreamTransport } from "../transport/index.ts";
import {
  DEFAULT_SOCKS_CONNECT_TIMEOUT_MS,
  socksFetch,
  type SocksFetchOptions,
  type SocksStage,
} from "../transport/socks-fetch.ts";
import type { ProxyGroupReference } from "./configuration.ts";
import {
  ProxyUnavailableError,
  SocksProxyError,
  proxyErrorDetails,
} from "./errors.ts";
import { ProxyGroupClient } from "./group-client.ts";
import type { ProxyLease } from "./schema.ts";
import type { Bindings } from "../../platform/bindings.ts";

export interface ProxyTransportContext {
  readonly config: Pick<GatewayConfig, "proxy_groups" | "revision">;
  readonly env: Pick<Bindings, "PROXY_GROUP">;
  readonly context?: HealthExecutionContext | undefined;
  readonly requestLog?: RequestLogContext | undefined;
  readonly requestId?: string | undefined;
  readonly clientSignal: AbortSignal;
  readonly socks?: SocksFetchOptions;
}

type ProxyPhase = "selecting" | "recording_health" | SocksStage;
type SwitchReason = "proxy_failure" | "target_rejected";
type ConnectionOutcome =
  "connected" | SwitchReason | ProxyUnavailableError["code"];

function setupTimeout(phase: ProxyPhase): Error {
  switch (phase) {
    case "selecting":
    case "recording_health":
      return new ProxyUnavailableError("proxy_state_unavailable");
    case "proxy":
      return new SocksProxyError("SOCKS5 connection timed out");
    case "upstream":
    case "request":
      return new Error("Upstream TLS connection timed out");
  }
}

/** A transport belongs to one logical request, including its configured HTTP retries. */
export function createProxyTransport(
  reference: ProxyGroupReference,
  runtime?: ProxyTransportContext,
): UpstreamTransport {
  let phase: ProxyPhase = "selecting";
  let selected: ProxyLease | undefined;
  // The reason also records whether this request has spent its single switch allowance.
  let switchReason: SwitchReason | undefined;
  const tried = new Set<string>();
  const group = runtime?.config.proxy_groups.find(
    (entry) => entry.id === reference.groupId,
  );

  const log = (outcome: ConnectionOutcome, proxyId?: string): void => {
    const fields = {
      group_id: reference.groupId,
      proxy_id: proxyId,
      strategy: group?.strategy,
      ...reference.owner,
      outcome,
      stage: phase,
      switched: switchReason !== undefined,
      switch_reason: switchReason,
    };
    // Catalog fan-out shares a request log. Append instead of replacing another provider's attempts.
    runtime?.requestLog?.append("proxy_connections", fields);
    logInfo("proxy.connection", { request_id: runtime?.requestId, ...fields });
  };

  if (!runtime?.env.PROXY_GROUP || !group) {
    const error = new ProxyUnavailableError(
      runtime?.env.PROXY_GROUP
        ? "proxy_group_unavailable"
        : "proxy_state_unavailable",
    );
    return {
      async send(request) {
        request.signal.throwIfAborted();
        log(error.code);
        throw error;
      },
      proxyFailure: proxyErrorDetails,
    };
  }

  const state = new ProxyGroupClient(group, reference.owner, {
    config: runtime.config,
    namespace: runtime.env.PROXY_GROUP,
    context: runtime.context,
    requestId: runtime.requestId,
  });
  const awaitHealth = !runtime.context?.waitUntil;
  const socksOptions = runtime.socks ?? {};
  const select = async (signal: AbortSignal): Promise<ProxyLease> => {
    phase = "selecting";
    try {
      return await state.select([...tried], signal);
    } catch (error) {
      if (error instanceof ProxyUnavailableError) {
        log(error.code);
      }
      throw error;
    }
  };

  return {
    proxyFailure(error) {
      if (phase === "upstream" || phase === "request") {
        return undefined;
      }
      if (
        error instanceof SocksProxyError ||
        error instanceof ProxyUnavailableError
      ) {
        return proxyErrorDetails(error);
      }
      // An outer deadline can win before the socket or RPC has finished unwinding.
      return proxyErrorDetails(setupTimeout(phase));
    },
    async send(request) {
      request.signal.throwIfAborted();
      phase = selected ? "proxy" : "selecting";
      const budget =
        socksOptions.connectTimeoutMs ?? DEFAULT_SOCKS_CONNECT_TIMEOUT_MS;
      const deadline = Date.now() + budget;
      const setup = new AbortController();
      const timer = setTimeout(() => setup.abort(setupTimeout(phase)), budget);
      const signal = AbortSignal.any([request.signal, setup.signal]);
      try {
        const outgoing = new Request(request, { signal });
        selected ??= await select(signal);
        for (;;) {
          signal.throwIfAborted();
          const lease = selected;
          const node = group.proxies.find(
            (proxy) => proxy.id === lease.proxy_id,
          );
          if (!node) {
            throw new ProxyUnavailableError("proxy_group_unavailable");
          }
          tried.add(node.id);
          const eventId = crypto.randomUUID();
          let success: Promise<boolean> | undefined;
          phase = "proxy";
          try {
            return await socksFetch(outgoing, node, {
              ...socksOptions,
              clientSignal: runtime.clientSignal,
              connectTimeoutMs: Math.max(1, deadline - Date.now()),
              onStage(stage) {
                phase = stage;
                if (stage === "request") {
                  clearTimeout(timer);
                }
              },
              onTunnelEstablished() {
                log("connected", node.id);
                success = state.observe(lease, "success", eventId);
              },
            });
          } catch (error) {
            if (
              phase !== "proxy" ||
              !(error instanceof SocksProxyError) ||
              runtime.clientSignal.aborted
            ) {
              throw error;
            }
            const reason: SwitchReason =
              error.scope === "proxy" ? "proxy_failure" : "target_rejected";
            log(reason, node.id);
            const failure =
              error.scope === "proxy"
                ? state.observe(lease, "failure", eventId)
                : Promise.resolve(true);
            if (switchReason !== undefined || signal.aborted) {
              if (awaitHealth) {
                await failure;
              }
              throw error;
            }

            // Selection depends on this write; a storage timeout is not a proxy TCP failure.
            phase = "recording_health";
            if (!(await abortable(failure, signal))) {
              throw new ProxyUnavailableError("proxy_state_unavailable");
            }
            try {
              selected = await select(signal);
              switchReason = reason;
            } catch (selectionError) {
              if (
                selectionError instanceof ProxyUnavailableError &&
                selectionError.code === "proxy_group_unavailable"
              ) {
                throw error;
              }
              throw selectionError;
            }
          } finally {
            if (awaitHealth) {
              await success;
            }
          }
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
