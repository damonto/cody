import { useEffect, useRef, useState } from "react";
import type { ProxyTestResult } from "../../../../src/admin/proxy-test-schema";
import { testProxyNode } from "./api";

export type ProxyTestState =
  | { status: "pending" }
  | { status: "success"; result: ProxyTestResult }
  | { status: "error"; message: string };

/** The owning row is keyed by draft version and proxy ID within its group. */
export function useProxyTest(
  groupId: string,
  proxyId: string,
  version: number,
) {
  const [state, setState] = useState<ProxyTestState>();
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      pending.current?.abort();
    };
  }, []);

  const test = async (): Promise<void> => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    const update = (state: ProxyTestState): void => {
      if (!controller.signal.aborted) {
        setState(state);
      }
    };
    update({ status: "pending" });
    try {
      const result = await testProxyNode(
        groupId,
        proxyId,
        version,
        controller.signal,
      );
      update({ status: "success", result });
    } catch (error) {
      update({
        status: "error",
        message: error instanceof Error ? error.message : "Proxy test failed",
      });
    } finally {
      if (pending.current === controller) {
        pending.current = null;
      }
    }
  };
  return { state, test };
}
