import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { SocksProxyConfig } from "../config/types.ts";
import { discardBody, readBodyWithinLimit } from "../gateway/http/body.ts";
import { SocksProxyError } from "../gateway/proxies/errors.ts";
import {
  socksFetch,
  type SocksStage,
} from "../gateway/transport/socks-fetch.ts";
import {
  proxyTestResultSchema,
  type ProxyTestResult,
} from "./proxy-test-schema.ts";

const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const ipInfoSchema = z.object({
  ip: proxyTestResultSchema.shape.ip,
  country: proxyTestResultSchema.shape.country.catch(null),
});

function transportErrorMessage(error: unknown, stage: SocksStage): string {
  if (error instanceof SocksProxyError && error.scope === "target") {
    return "The SOCKS5 proxy could not connect to IPinfo.";
  }
  switch (stage) {
    case "proxy":
      return "Could not connect or authenticate to the SOCKS5 proxy.";
    case "upstream":
      return "Could not establish a secure connection to IPinfo.";
    case "request":
      return "Could not read a valid IPinfo response.";
  }
}

/** A manual diagnostic uses exactly this node and never reads or writes routing health. */
export async function testProxy(
  proxy: SocksProxyConfig,
  clientSignal: AbortSignal,
): Promise<ProxyTestResult> {
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), TIMEOUT_MS);
  const signal = AbortSignal.any([clientSignal, deadline.signal]);
  let stage: SocksStage = "proxy";
  let response: Response | undefined;
  try {
    signal.throwIfAborted();
    response = await socksFetch(
      new Request("https://ipinfo.io/json", {
        headers: { accept: "application/json" },
        redirect: "manual",
        signal,
      }),
      proxy,
      {
        connectTimeoutMs: TIMEOUT_MS,
        clientSignal,
        onStage(value) {
          stage = value;
        },
      },
    );
    if (!response.ok) {
      throw new HTTPException(502, {
        message: `IPinfo returned HTTP ${response.status}. Try again later.`,
      });
    }
    const bytes = await readBodyWithinLimit(
      response.body,
      MAX_RESPONSE_BYTES,
      response.headers.get("content-length"),
      undefined,
      signal,
    );
    const result = ipInfoSchema.safeParse(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
    if (!result.success) {
      throw new HTTPException(502, {
        message: "IPinfo returned an invalid IP address.",
      });
    }
    return result.data;
  } catch (error) {
    clientSignal.throwIfAborted();
    if (deadline.signal.aborted) {
      throw new HTTPException(504, {
        message: "Proxy test timed out after 15 seconds.",
      });
    }
    if (error instanceof HTTPException) throw error;
    // Never forward raw transport errors or IPinfo bodies: they may contain secrets.
    throw new HTTPException(502, {
      message: transportErrorMessage(error, stage),
    });
  } finally {
    clearTimeout(timeout);
    await discardBody(response?.body ?? null);
  }
}
