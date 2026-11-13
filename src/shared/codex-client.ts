/** Classify the inbound client before installing provider headers. */
export function isCodexClientRequest(
  request: Pick<Request, "headers">,
): boolean {
  return (
    request.headers.get("user-agent")?.toLowerCase().includes("codex") ?? false
  );
}

export function codexRequestMode(
  request: Pick<Request, "headers">,
  useSiwc = false,
): "native" | "siwc" {
  return codexModeForClient(
    isCodexClientRequest(request) ? "codex" : "other",
    useSiwc,
  );
}

/** One policy for routing, catalog discovery and provider preparation. */
export function codexModeForClient(
  client: "codex" | "other" | undefined,
  useSiwc: boolean,
): "native" | "siwc" {
  if (client === "codex") return "native";
  return useSiwc ? "siwc" : "native";
}
