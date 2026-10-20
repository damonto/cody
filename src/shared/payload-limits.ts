const KIB = 1024;
const MIB = 1024 * KIB;

// Upload budgets apply independently to wire bytes and decoded request bodies.
export const MAX_INFERENCE_BODY_BYTES = 64 * MIB;
export const MAX_NATIVE_REQUEST_BODY_BYTES = 16 * MIB;
export const MAX_NATIVE_RESPONSE_BODY_BYTES = 16 * MIB;
export const MAX_ADMIN_BODY_BYTES = 16 * MIB;
export const MAX_SEARCH_REQUEST_BODY_BYTES = MIB;
/** Leave room for decoded text, parsed JSON and adapter copies in a 128 MB isolate. */
export const MAX_WORKER_REQUEST_BODY_BYTES = 16 * MIB;
/** Vercel Functions reject incoming payloads above 4.5 MB before application code. */
export const MAX_VERCEL_REQUEST_BODY_BYTES = 4_500_000;

// These budgets have different failure behavior; equal defaults do not couple them.
export const MAX_SSE_EVENT_BYTES = 16 * MIB;
export const MAX_RESPONSE_OBSERVATION_BYTES = 16 * MIB;
export const MAX_RETRY_INSPECTION_BYTES = 16 * MIB;
export const MAX_SEARCH_RESPONSE_BODY_BYTES = 16 * MIB;
export const MAX_SEARCH_BATCH_RESPONSE_BYTES = 16 * MIB;
export const MAX_MODEL_CATALOG_BODY_BYTES = 8 * MIB;
export const MAX_ACCOUNT_METADATA_BYTES = 8 * MIB;
export const MAX_ACCOUNT_RESPONSE_BODY_BYTES = 16 * MIB;
export const MAX_CONTROL_RESPONSE_BODY_BYTES = MIB;
export const MAX_QUOTA_ERROR_BYTES = 64 * KIB;
export const MAX_DIAGNOSTIC_RESPONSE_BYTES = 64 * KIB;
export const MAX_WEBSOCKET_OBSERVATION_BYTES = 64 * KIB;
export const MAX_VERSION_MANIFEST_BYTES = 4 * KIB;
export const MAX_UPSTREAM_ERROR_BODY_BYTES = MIB;
export const MAX_WEBSOCKET_UPGRADE_ERROR_BYTES = 32 * KIB;
export const MAX_LOGGED_UPSTREAM_ERROR_BYTES = 32 * KIB;

// Cloudflare's received-message ceiling also applies to Node and SOCKS5 transports.
export const MAX_WEBSOCKET_MESSAGE_BYTES = 32 * MIB;
export const MAX_WEBSOCKET_BUFFER_BYTES = 32 * MIB;
export const MAX_WEBSOCKET_BUFFER_MESSAGES = 1024;

// Native adapters retain separate cumulative output and signed-history budgets.
export const MAX_ANTIGRAVITY_OUTPUT_BYTES = 8 * MIB;
export const MAX_XAI_OUTPUT_BYTES = 32 * MIB;
export const MAX_REPLAY_ENVELOPE_BYTES = 16 * MIB;
export const MAX_XAI_REPLAY_CIPHERTEXT_BYTES = 8 * MIB;
export const MAX_XAI_REPLAY_ENVELOPE_BYTES = 12 * MIB;
export const MAX_COMPILED_CONFIG_BYTES = MIB;
export const MAX_TRANSFER_BYTES = 8 * MIB;

/** A runtime ceiling can only narrow an operation's application budget. */
export function requestBodyLimit(
  maxBytes: number,
  platformMaxBytes = maxBytes,
): number {
  return Math.min(maxBytes, platformMaxBytes);
}

export function formatByteLimit(bytes: number): string {
  if (bytes % MIB === 0) return `${bytes / MIB} MiB`;
  if (bytes >= 1_000_000 && bytes % 1000 === 0)
    return `${bytes / 1_000_000} MB`;
  if (bytes % KIB === 0) return `${bytes / KIB} KiB`;
  return `${bytes} bytes`;
}
