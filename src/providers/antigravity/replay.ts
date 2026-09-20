import { z } from "zod";
import { decryptConfig, encryptConfig } from "../../control/crypto.ts";
import { ProviderRequestError } from "../errors.ts";

export const partSchema = z
  .object({
    text: z.string().optional(),
    thought: z.boolean().optional(),
    thoughtSignature: z.string().optional(),
    functionCall: z
      .object({
        name: z.string(),
        args: z.unknown().optional(),
        id: z.string().optional(),
      })
      .optional(),
    functionResponse: z
      .object({
        name: z.string(),
        response: z.unknown(),
        id: z.string().optional(),
      })
      .optional(),
    inlineData: z.object({ mimeType: z.string(), data: z.string() }).optional(),
    fileData: z
      .object({ mimeType: z.string().optional(), fileUri: z.string() })
      .optional(),
  })
  .passthrough();
export type NativePart = z.output<typeof partSchema>;
export interface ReplayScope {
  client_id: string;
  provider_id: string;
  account_ref: string;
  model: string;
}
const replaySchema = z.object({
  purpose: z.literal("antigravity-replay"),
  scope: z.object({
    client_id: z.string(),
    provider_id: z.string(),
    account_ref: z.string(),
    model: z.string(),
  }),
  attachment: z.enum(["self", "previous"]),
  part: partSchema,
  call_id: z.string().optional(),
});
const PREFIX = "cody-ag1.";
export async function sealPart(
  part: NativePart,
  attachment: "self" | "previous",
  scope: ReplayScope,
  key: string,
  callId?: string,
): Promise<string> {
  const encrypted = await encryptConfig(
    {
      purpose: "antigravity-replay",
      scope,
      attachment,
      part,
      ...(callId ? { call_id: callId } : {}),
    },
    key,
  );
  const envelope = PREFIX + btoa(encrypted);
  if (envelope.length > 2 * 1024 * 1024)
    throw new ProviderRequestError(
      "Signed Antigravity content exceeds the replay limit",
      502,
    );
  return envelope;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
/** Native optional metadata is not part of the client's visible text/arguments. */
export function sameVisiblePart(left: NativePart, right: NativePart): boolean {
  const visible = (part: NativePart) =>
    part.functionCall
      ? {
          functionCall: {
            name: part.functionCall.name,
            args: part.functionCall.args ?? {},
          },
        }
      : { text: part.text ?? "", thought: part.thought === true };
  return canonical(visible(left)) === canonical(visible(right));
}
export async function openPart(value: string, scope: ReplayScope, key: string) {
  try {
    if (!value.startsWith(PREFIX) || value.length > 2 * 1024 * 1024)
      throw new Error("Invalid envelope");
    const replay = replaySchema.parse(
      await decryptConfig(atob(value.slice(PREFIX.length)), key),
    );
    if (
      Object.entries(scope).some(
        ([field, expected]) =>
          replay.scope[field as keyof ReplayScope] !== expected,
      )
    )
      throw new Error("Wrong scope");
    return replay;
  } catch {
    throw new ProviderRequestError(
      "Thinking signature does not belong to this client, account and model",
      400,
      "invalid_thinking_signature",
    );
  }
}
