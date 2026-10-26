import { compareStrings } from "../shared/compare.ts";
import { z } from "zod";

export const TRANSFER_VERSION = 1;
// D1 uses native file import/export; SQL adapters exchange bounded bulk pages.
export const PAGE_SIZE = 1000;
export { MAX_TRANSFER_BYTES } from "../shared/payload-limits.ts";
export const TABLE_KEYS = {
  secret_versions: ["id"],
  proxy_groups: ["id"],
  providers: ["id"],
  oauth_accounts: ["account_ref"],
  provider_credentials: ["id"],
  clients: ["id"],
  client_providers: ["client_id", "provider_id"],
  proxy_nodes: ["id"],
  provider_models: ["id"],
  model_routes: ["id"],
  model_route_providers: ["route_id", "provider_id"],
  model_prices: ["id"],
  settings: ["name"],
  config_snapshots: ["version"],
  model_price_versions: ["id"],
  config_operations: ["id"],
  audit_log: ["id"],
  requests: ["request_id"],
  request_attempts: ["request_id", "attempt"],
  usage_hourly: [
    "hour",
    "client_id",
    "provider_id",
    "credential_id",
    "model",
    "kind",
    "currency",
  ],
  config_meta: ["id"],
} as const;
export type TransferTable = keyof typeof TABLE_KEYS;
export const TABLES = Object.keys(TABLE_KEYS) as TransferTable[];
export const rowSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.null()]),
);
export type TransferRow = z.infer<typeof rowSchema>;
export const objectRefSchema = z.strictObject({
  kind: z.literal("oauth"),
  name: z.string().min(1).max(4096),
});
export type ObjectRef = z.infer<typeof objectRefSchema>;
export const objectSnapshotSchema = z.strictObject({
  ref: objectRefSchema,
  entries: z.array(z.tuple([z.string(), z.unknown()])),
  alarm: z.number().int().nonnegative().nullable(),
});
export type ObjectSnapshot = z.infer<typeof objectSnapshotSchema>;
const page = {
  table: z.enum(TABLES),
  cursor: z.array(z.union([z.string(), z.number()])).nullable(),
};
export const commandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("preflight"),
    challenge: z.string().min(32).max(128),
  }),
  z.strictObject({
    action: z.enum(["prepare", "inventory", "validate"]),
  }),
  z.strictObject({
    action: z.literal("read"),
    ...page,
    limit: z.number().int().min(1).max(PAGE_SIZE).optional(),
  }),
  z.strictObject({
    action: z.literal("write"),
    ...page,
    rows: z.array(rowSchema).max(PAGE_SIZE),
    next_cursor: page.cursor,
    digest: z.string().length(64),
  }),
  z.strictObject({
    action: z.literal("object_ids"),
    refs: z.array(objectRefSchema).max(50),
  }),
  z.strictObject({ action: z.literal("read_object"), ref: objectRefSchema }),
  z.strictObject({
    action: z.literal("write_object"),
    snapshot: objectSnapshotSchema,
    digest: z.string().length(64),
  }),
  z.strictObject({
    action: z.literal("schedule"),
    ref: objectRefSchema,
    alarm: objectSnapshotSchema.shape.alarm,
  }),
]);
export type TransferCommand = z.infer<typeof commandSchema>;
export type TransferAction = TransferCommand["action"];
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const okSchema = z.strictObject({ ok: z.literal(true) });
const resultSchemas = {
  preflight: z.strictObject({
    version: z.number().int().positive(),
    platform: z.enum(["cloudflare", "standard"]),
    schema: digestSchema,
    fingerprint: digestSchema,
    key_proof: digestSchema,
    empty: z.boolean(),
  }),
  prepare: okSchema,
  inventory: z.strictObject({
    objects: z.array(objectRefSchema),
    skipped: z.record(z.string(), z.number().int().nonnegative()).default({}),
    orphaned_oauth: z.array(z.string().min(1)).default([]),
  }),
  validate: okSchema,
  read: z.strictObject({
    rows: z.array(rowSchema).max(PAGE_SIZE),
    next_cursor: page.cursor,
    digest: digestSchema,
  }),
  write: okSchema,
  object_ids: z.strictObject({ ids: z.array(digestSchema).max(50) }),
  read_object: z.strictObject({
    snapshot: objectSnapshotSchema,
    digest: digestSchema,
  }),
  write_object: okSchema,
  schedule: okSchema,
} satisfies Record<TransferAction, z.ZodType>;
export type TransferResult<A extends TransferAction = TransferAction> = z.infer<
  (typeof resultSchemas)[A]
>;

/** Validate both local adapter results and replies crossing the preview/IPC boundary. */
export function parseTransferResult<A extends TransferAction>(
  action: A,
  value: unknown,
): TransferResult<A>;
export function parseTransferResult(
  action: TransferAction,
  value: unknown,
): TransferResult {
  const result = resultSchemas[action].safeParse(value);
  if (!result.success)
    throw new TransferError(`Invalid transfer response: ${action}`);
  return result.data;
}

export interface TransferEndpoint {
  call<A extends TransferAction>(
    command: TransferCommand & { action: A },
  ): Promise<TransferResult<A>>;
  databaseSnapshot?(
    onProgress: (message: string) => void,
  ): Promise<TransferEndpoint>;
  importDatabase?(
    source: TransferEndpoint,
    saveIntent: (digest: string) => Promise<void>,
    onProgress: (message: string) => void,
  ): Promise<void>;
}

export class TransferError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

/** Include only fixed diagnostics: driver/RPC messages can contain secrets or rows. */
export function transferFailure(
  error: unknown,
  context: string,
): TransferError {
  let reason = "Storage or runtime operation failed";
  if (error instanceof TransferError)
    return new TransferError(`${context}: ${error.message}`, error.status);
  if (error instanceof z.ZodError)
    reason = "Data does not match the transfer schema";
  else if (error instanceof Error) {
    if (
      /no such (table|column)|does not exist/i.test(error.message) &&
      /D1_ERROR|SQLITE_ERROR|relation|column/i.test(error.message)
    )
      reason = "Database schema is incomplete; apply this release's migrations";
    else if (
      /too many (SQL )?queries|exceeded.*(?:limit|quota)/i.test(error.message)
    )
      reason = "Database or runtime limit exceeded";
    else if (/^D1_(?:ERROR|EXEC_ERROR):/.test(error.message))
      reason =
        "D1 rejected the query; check database availability, permissions and migrations";
    else if (error instanceof TypeError) reason = "Runtime TypeError";
    else if (error instanceof SyntaxError)
      reason = "Invalid JSON or stored data";
    else if (error instanceof DOMException)
      reason = "Cryptographic or platform operation failed";
  }
  return new TransferError(`${context}: ${reason}`, 503);
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}
export async function hash(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(value)),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function keyProof(
  encodedKey: string,
  challenge: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(encodedKey), (c) => c.charCodeAt(0)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const proof = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`cody-transfer:${challenge}`),
  );
  return Array.from(new Uint8Array(proof), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
