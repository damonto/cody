import { records, text, type Wire } from "./json.ts";
import { z } from "zod";
import { decryptConfig, encryptConfig } from "../../control/crypto.ts";
import { ProviderRequestError } from "../errors.ts";
import {
  MAX_XAI_REPLAY_CIPHERTEXT_BYTES,
  MAX_XAI_REPLAY_ENVELOPE_BYTES,
} from "../../shared/payload-limits.ts";

export interface XaiScope {
  client_id: string;
  provider_id: string;
  account_ref: string;
  model: string;
}
const PREFIX = "cody-xai1.";
const schema = z.object({
  purpose: z.literal("xai-replay"),
  scope: z.object({
    client_id: z.string(),
    provider_id: z.string(),
    account_ref: z.string(),
    model: z.string(),
  }),
  item: z.record(z.string(), z.unknown()),
  visible: z.string(),
});
export function reasoningText(item: Wire): string {
  return records(item.summary)
    .map((part) => text(part.text))
    .join("");
}
export async function sealReasoning(
  item: Wire,
  visible: string,
  scope: XaiScope,
  key: string,
): Promise<string> {
  const encrypted = await encryptConfig(
    { purpose: "xai-replay", scope, item, visible },
    key,
  );
  if (encrypted.length > MAX_XAI_REPLAY_CIPHERTEXT_BYTES)
    throw new ProviderRequestError(
      "xAI reasoning exceeds the replay limit",
      502,
    );
  const envelope = PREFIX + btoa(encrypted);
  if (envelope.length > MAX_XAI_REPLAY_ENVELOPE_BYTES)
    throw new ProviderRequestError(
      "xAI reasoning exceeds the replay limit",
      502,
    );
  return envelope;
}
export async function openReasoning(
  value: string,
  visible: string,
  scope: XaiScope,
  key: string,
  accounts: readonly string[],
): Promise<Wire> {
  try {
    if (
      !value.startsWith(PREFIX) ||
      value.length > MAX_XAI_REPLAY_ENVELOPE_BYTES
    )
      throw new Error("envelope");
    const encrypted = atob(value.slice(PREFIX.length));
    if (encrypted.length > MAX_XAI_REPLAY_CIPHERTEXT_BYTES)
      throw new Error("envelope");
    const replay = schema.parse(await decryptConfig(encrypted, key));
    if (
      replay.scope.client_id !== scope.client_id ||
      replay.scope.provider_id !== scope.provider_id ||
      replay.scope.model !== scope.model ||
      !accounts.includes(scope.account_ref) ||
      !accounts.includes(replay.scope.account_ref) ||
      replay.visible !== visible
    )
      throw new Error("scope");
    return replay.item;
  } catch {
    throw new ProviderRequestError(
      "Thinking signature does not belong to this client, account pool, model and content",
      400,
      "invalid_thinking_signature",
    );
  }
}
