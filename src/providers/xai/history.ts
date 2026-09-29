import { z } from "zod";
import type { Bindings } from "../../platform/bindings.ts";
import { encryptConfig, decryptConfig } from "../../control/crypto.ts";
import { logWarn } from "../../shared/log.ts";
import { accountReply, accountViewSchema } from "../oauth/schema.ts";
import { object, records, text, type Wire } from "./json.ts";
import { openReasoning, reasoningText, type XaiScope } from "./replay.ts";
import { translateToolCall, type ToolMapping } from "./tools.ts";

const historySchema = z.object({
  purpose: z.literal("xai-history"),
  scope: z.object({
    client_id: z.string(),
    provider_id: z.string(),
    model: z.string(),
    account_ref: z.string(),
  }),
  generation: z.number().int(),
  output: z.array(z.record(z.string(), z.unknown())).max(1024),
});

function turnKey(value: unknown): string {
  try {
    const metadata =
      typeof value === "string" ? object(JSON.parse(value)) : object(value);
    return text(metadata.prompt_cache_key)
      ? `cache:${text(metadata.prompt_cache_key)}`
      : text(metadata.window_id)
        ? `window:${text(metadata.window_id)}`
        : "";
  } catch {
    return "";
  }
}

export function historySession(
  request: Request,
  payload: Wire,
  sessionId?: string,
): string {
  if (text(payload.prompt_cache_key))
    return `cache:${text(payload.prompt_cache_key)}`;
  const metadata = object(payload.client_metadata);
  if (text(metadata["x-codex-window-id"]))
    return `window:${text(metadata["x-codex-window-id"])}`;
  return (
    turnKey(metadata["x-codex-turn-metadata"]) ||
    turnKey(request.headers.get("x-codex-turn-metadata")) ||
    (request.headers.get("x-codex-window-id")
      ? `window:${request.headers.get("x-codex-window-id")}`
      : "") ||
    (sessionId ? `session:${sessionId}` : "") ||
    (request.headers.get("session_id")
      ? `session:${request.headers.get("session_id")}`
      : "") ||
    (request.headers.get("conversation_id")
      ? `conversation:${request.headers.get("conversation_id")}`
      : "")
  );
}

function messageContent(item: Wire): string {
  return JSON.stringify(
    typeof item.content === "string"
      ? [{ type: "output_text", text: item.content }]
      : records(item.content).map((part) =>
          part.type === "refusal"
            ? { type: "refusal", refusal: part.refusal }
            : { type: "output_text", text: part.text },
        ),
  );
}

/** Match the latest assistant turn before filling omitted reasoning/calls. */
export function mergeHistory(input: Wire[], cached: Wire[]): Wire[] {
  const assistant = [...input]
    .reverse()
    .find((item) => item.type === "message" && item.role === "assistant");
  const previous = cached.find(
    (item) => item.type === "message" && item.role === "assistant",
  );
  if (
    assistant &&
    previous &&
    messageContent(assistant) !== messageContent(previous)
  )
    return input;
  const calls = new Set(
    input
      .filter((item) => item.type === "function_call")
      .map((item) => item.call_id),
  );
  const outputs = new Set(
    input
      .filter((item) => item.type === "function_call_output")
      .map((item) => item.call_id),
  );
  const additions = cached.filter((item) => {
    if (item.type === "reasoning")
      return !input.some(
        (value) =>
          value.type === "reasoning" &&
          value.encrypted_content === item.encrypted_content,
      );
    if (item.type === "message") return !assistant;
    if (item.type === "function_call")
      return !calls.has(item.call_id) && outputs.has(item.call_id);
    return false;
  });
  if (!additions.length) return input;
  const replayCalls = new Set(
    additions
      .filter((item) => item.type === "function_call")
      .map((item) => item.call_id),
  );
  let index = input.findIndex(
    (item) =>
      item.type === "function_call_output" && replayCalls.has(item.call_id),
  );
  if (index < 0 && assistant) index = input.indexOf(assistant);
  if (index < 0)
    index = input.findIndex(
      (item) =>
        item.type !== "message" ||
        !["system", "developer"].includes(text(item.role)),
    );
  if (index < 0) index = input.length;
  return [...input.slice(0, index), ...additions, ...input.slice(index)];
}

export async function prepareHistory(
  env: Pick<
    Bindings,
    "SESSION_AFFINITY" | "PROVIDER_OAUTH_ACCOUNT" | "CONFIG_ENCRYPTION_KEY"
  >,
  scope: XaiScope,
  generation: number,
  session: string,
  body: Wire,
  mappings: readonly ToolMapping[],
  accounts: readonly string[],
): Promise<((output: Wire[]) => Promise<void>) | undefined> {
  if (!session) return undefined;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([
        scope.client_id,
        scope.provider_id,
        scope.model,
        session,
      ]),
    ),
  );
  const name = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const store = env.SESSION_AFFINITY.getByName(`xai-replay:${name}`);
  try {
    const snapshot = await store.beginXaiReplay();
    if (snapshot.value) {
      const previous = historySchema.parse(
        await decryptConfig(snapshot.value, env.CONFIG_ENCRYPTION_KEY),
      );
      const source = previous.scope;
      if (
        source.client_id === scope.client_id &&
        source.provider_id === scope.provider_id &&
        source.model === scope.model &&
        accounts.includes(source.account_ref)
      ) {
        const account = await accountReply(
          env.PROVIDER_OAUTH_ACCOUNT.getByName(source.account_ref).run({
            action: "view",
          }),
          accountViewSchema,
        );
        if (account.generation === previous.generation) {
          const native: Wire[] = [];
          const outputs = new Set(
            records(body.input)
              .filter((item) => item.type === "function_call_output")
              .map((item) => item.call_id),
          );
          for (const item of previous.output) {
            if (item.type === "reasoning" && item.encrypted_content)
              native.push(
                await openReasoning(
                  text(item.encrypted_content),
                  reasoningText(item),
                  scope,
                  env.CONFIG_ENCRYPTION_KEY,
                  accounts,
                ),
              );
            else if (item.type === "message") native.push(item);
            else if (
              ["function_call", "custom_tool_call"].includes(text(item.type)) &&
              outputs.has(item.call_id)
            )
              native.push(
                translateToolCall(
                  item,
                  mappings,
                  item.type === "custom_tool_call",
                ),
              );
          }
          body.input = mergeHistory(records(body.input), native);
        }
      }
    }
    return async (output) => {
      try {
        const replayable = output.some(
          (item) =>
            (item.type === "reasoning" && item.encrypted_content) ||
            item.type === "function_call" ||
            item.type === "custom_tool_call",
        );
        const value = replayable
          ? await encryptConfig(
              { purpose: "xai-history", scope, generation, output },
              env.CONFIG_ENCRYPTION_KEY,
            )
          : null;
        await store.commitXaiReplay(snapshot.version, value);
      } catch {
        logWarn("xai.history_write.failed", {});
      }
    };
  } catch {
    logWarn("xai.history_read.failed", {});
    return undefined;
  }
}
