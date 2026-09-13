import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { SECRET_PLACEHOLDER } from "../../../src/shared/secrets";

export interface CredentialSource {
  value: string;
  reveal: (signal: AbortSignal) => Promise<string>;
}

type CredentialStatus = "idle" | "revealing" | "copying" | "copied";

interface CredentialState {
  visible: boolean;
  revealedKey: string | null;
  status: CredentialStatus;
}

const INITIAL_STATE: CredentialState = {
  visible: false,
  revealedKey: null,
  status: "idle",
};

async function writeClipboard(
  value: string | Promise<string>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (typeof value === "string") {
    await navigator.clipboard.writeText(value);
  } else if (
    typeof ClipboardItem === "function" &&
    typeof navigator.clipboard.write === "function"
  ) {
    const data = value.then((text) => {
      signal.throwIfAborted();
      return new Blob([text], { type: "text/plain" });
    });
    // Start the write within the click's user activation, before fetching finishes.
    // Observe both promises even if clipboard access is rejected immediately.
    await Promise.all([data, writeClipboardItem(data)]);
  } else {
    const text = await value;
    signal.throwIfAborted();
    await navigator.clipboard.writeText(text);
  }
}

async function writeClipboardItem(data: Promise<Blob>): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ "text/plain": data })]);
}

export function useCredential({ value, reveal }: CredentialSource) {
  const [state, setState] = useState(INITIAL_STATE);
  const active = useRef<AbortController | null>(null);
  const stored = value === SECRET_PLACEHOLDER;
  useEffect(
    () => () => {
      active.current?.abort();
      active.current = null;
    },
    [],
  );

  function cancelRequest() {
    active.current?.abort();
    active.current = null;
  }
  function startRequest(status: "revealing" | "copying") {
    cancelRequest();
    const controller = new AbortController();
    active.current = controller;
    setState((current) => ({ ...current, status }));
    return controller;
  }
  function finishRequest(
    controller: AbortController,
    status: "idle" | "copied",
  ) {
    if (active.current !== controller) return;
    cancelRequest();
    setState((current) => ({ ...current, status }));
  }
  function clearRevealedKey() {
    cancelRequest();
    setState((current) => ({ ...INITIAL_STATE, visible: current.visible }));
  }
  function hide() {
    cancelRequest();
    setState(INITIAL_STATE);
  }
  function readKey(signal: AbortSignal) {
    return stored ? (state.revealedKey ?? reveal(signal)) : value;
  }
  async function show() {
    const controller = startRequest("revealing");
    try {
      const text = await readKey(controller.signal);
      if (controller.signal.aborted) return;
      setState((current) => ({
        ...current,
        visible: true,
        revealedKey: stored ? text : null,
      }));
    } catch (error) {
      if (!controller.signal.aborted)
        toast.error(
          error instanceof Error ? error.message : "Could not read the API key",
        );
    } finally {
      finishRequest(controller, "idle");
    }
  }
  async function copy() {
    if (!navigator.clipboard) {
      toast.error("Clipboard unavailable");
      return;
    }
    const controller = startRequest("copying");
    let status: "idle" | "copied" = "idle";
    let readError: unknown;
    try {
      const source = readKey(controller.signal);
      const text =
        typeof source === "string"
          ? source
          : source.catch((error: unknown) => {
              readError = error;
              throw error;
            });
      await writeClipboard(text, controller.signal);
      if (controller.signal.aborted) return;
      status = "copied";
      toast.success("Copied to clipboard");
    } catch {
      if (!controller.signal.aborted)
        toast.error(
          readError instanceof Error
            ? readError.message
            : "Clipboard unavailable",
        );
    } finally {
      finishRequest(controller, status);
    }
  }
  function toggle() {
    if (state.visible || state.status === "revealing") {
      hide();
    } else {
      void show();
    }
  }
  return {
    visible: state.visible,
    text: stored ? (state.revealedKey ?? "") : value,
    status: state.status,
    clearRevealedKey,
    hide,
    toggle,
    copy: () => {
      void copy();
    },
  };
}
