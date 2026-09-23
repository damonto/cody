/**
 * Some upstreams only serve requests shaped like Claude Code's main loop. On
 * every `/v1/messages` request they check exactly three things, established by
 * bisecting a real client capture:
 *
 *  - the system prompt is an array whose first block is Claude Code's prompt
 *    prefix, or its attribution header immediately followed by that prefix;
 *  - `metadata.user_id` is Claude Code's JSON string with a non-empty
 *    `device_id` and a UUID `session_id`;
 *  - at least three of Claude Code's core tools are declared.
 *
 * Headers, betas, the attribution fingerprint and every other field are not
 * checked, so a request is reshaped only as far as those three rules require.
 */

const ATTRIBUTION_PREFIX = "x-anthropic-billing-header:";

/** The prompt prefix inserted when a request carries none of Claude Code's. */
export const CLAUDE_CODE_PROMPT_PREFIX =
  "You are Claude Code, Anthropic's official CLI for Claude.";

// Claude Code opens its system prompt with one of these, followed by a
// variant-specific tail that has changed across releases.
const PROMPT_PREFIX_OPENERS = [
  "You are Claude Code, Anthropic's official CLI for Claude",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK",
];

/** Tool names an upstream expects in a Claude Code request; three suffice. */
export const CLAUDE_CODE_CORE_TOOLS = [
  "Bash",
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
] as const;
const MIN_CORE_TOOLS = 3;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The conversation a request is presented as. */
export interface ClaudeCodeIdentity {
  readonly device_id: string;
  readonly session_id: string;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function textOf(block: unknown): string | undefined {
  const object = asObject(block);
  return object?.type === "text" && typeof object.text === "string"
    ? object.text
    : undefined;
}

function isPromptPrefix(text: string | undefined): boolean {
  return (
    text !== undefined &&
    PROMPT_PREFIX_OPENERS.some((opener) => text.startsWith(opener))
  );
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function stubTool(name: string): JsonObject {
  return {
    name,
    description: "Not available in this request.",
    input_schema: { type: "object", properties: {} },
  };
}

/**
 * Returns the system blocks with Claude Code's prefix in the position the
 * upstream checks, or `undefined` when the request already satisfies it.
 */
function emulatedSystem(system: unknown): unknown[] | undefined {
  const blocks: unknown[] = Array.isArray(system)
    ? [...system]
    : typeof system === "string"
      ? [{ type: "text", text: system }]
      : [];
  const index = textOf(blocks[0])?.startsWith(ATTRIBUTION_PREFIX) ? 1 : 0;
  if (Array.isArray(system) && isPromptPrefix(textOf(blocks[index]))) {
    return undefined;
  }
  blocks.splice(index, 0, { type: "text", text: CLAUDE_CODE_PROMPT_PREFIX });
  return blocks;
}

/**
 * Returns the metadata with a `user_id` the upstream accepts, or `undefined`
 * when the request already carries one. A usable device id or UUID session id
 * of the request's own is kept; the synthetic identity fills the rest.
 */
function emulatedMetadata(
  metadata: unknown,
  identity: ClaudeCodeIdentity,
): JsonObject | undefined {
  const fields = asObject(metadata) ?? {};
  let user: JsonObject | undefined;
  if (typeof fields.user_id === "string") {
    try {
      user = asObject(JSON.parse(fields.user_id) as unknown);
    } catch {
      user = undefined;
    }
  }
  const deviceId =
    typeof user?.device_id === "string" && user.device_id !== ""
      ? user.device_id
      : undefined;
  const sessionId = isUuid(user?.session_id) ? user.session_id : undefined;
  if (deviceId !== undefined && sessionId !== undefined) return undefined;
  const { device_id: _device, session_id: _session, ...rest } = user ?? {};
  return {
    ...fields,
    user_id: JSON.stringify({
      device_id: deviceId ?? identity.device_id,
      account_uuid:
        typeof rest.account_uuid === "string" ? rest.account_uuid : "",
      ...rest,
      session_id: sessionId ?? identity.session_id,
    }),
  };
}

/**
 * Reshapes a request so an upstream gating on Claude Code traffic accepts it,
 * or returns `undefined` when the request already passes and can be forwarded
 * byte for byte. Missing core tools are declared as stubs; a request that
 * offered no tools also gets `tool_choice: none` so the stubs are never used.
 */
export function emulateClaudeCodeRequest(
  payload: Readonly<JsonObject>,
  identity: ClaudeCodeIdentity,
): JsonObject | undefined {
  const emulated: JsonObject = { ...payload };
  let changed = false;

  const system = emulatedSystem(payload.system);
  if (system) {
    emulated.system = system;
    changed = true;
  }

  const metadata = emulatedMetadata(payload.metadata, identity);
  if (metadata) {
    emulated.metadata = metadata;
    changed = true;
  }

  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const names = new Set<unknown>(
    tools.map((tool: unknown) => asObject(tool)?.name),
  );
  const missing = CLAUDE_CODE_CORE_TOOLS.filter((name) => !names.has(name));
  if (CLAUDE_CODE_CORE_TOOLS.length - missing.length < MIN_CORE_TOOLS) {
    emulated.tools = [...tools, ...missing.map(stubTool)];
    if (tools.length === 0 && payload.tool_choice === undefined) {
      emulated.tool_choice = { type: "none" };
    }
    changed = true;
  }

  return changed ? emulated : undefined;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function uuidFromBytes(bytes: Uint8Array): string {
  const value = Uint8Array.from(bytes.subarray(0, 16));
  value[6] = (value[6] & 0x0f) | 0x40;
  value[8] = (value[8] & 0x3f) | 0x80;
  const text = hex(value);
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

const derived = new Map<string, Promise<ClaudeCodeIdentity>>();

async function deriveIdentity(clientId: string): Promise<ClaudeCodeIdentity> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`cody claude-code identity ${clientId}`),
    ),
  );
  return { device_id: hex(digest), session_id: uuidFromBytes(digest) };
}

/**
 * The identity a request without one is presented as: a device stable per
 * client API key and, unless the request already named a UUID session, one
 * stable conversation per client, so probes never open a new upstream session.
 */
export function syntheticClaudeCodeIdentity(
  clientId: string,
  sessionId?: string,
): Promise<ClaudeCodeIdentity> {
  let pending = derived.get(clientId);
  if (!pending) {
    pending = deriveIdentity(clientId);
    derived.set(clientId, pending);
    pending.catch(() => derived.delete(clientId));
  }
  return isUuid(sessionId)
    ? pending.then((identity) => ({ ...identity, session_id: sessionId }))
    : pending;
}
