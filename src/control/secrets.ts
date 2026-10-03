import { z } from "zod";
import type { GatewayConfig } from "../config/types.ts";
import type { SqlDatabase } from "../platform/bindings.ts";
import { record } from "../telemetry/usage.ts";
import { SECRET_PLACEHOLDER } from "../shared/secrets.ts";
import { encryptConfig } from "./crypto.ts";
import { ControlInputError } from "./errors.ts";
import type { SecretVersion } from "./entities.ts";
export { SECRET_PLACEHOLDER } from "../shared/secrets.ts";
const objectSchema = z.record(z.string(), z.unknown());

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function secretReference(id: string): string {
  return `__cody_secret:${id}`;
}
export function secretId(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("__cody_secret:")) return;
  return z.uuid().parse(value.slice("__cody_secret:".length));
}

function entries(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const item = record(entry);
        return item ? [item] : [];
      })
    : [];
}

/** Preserve secrets by stable provider/credential/client IDs, never by array position. */
export function restoreSecrets(value: unknown, previous: unknown): unknown {
  const restored: unknown = structuredClone(value);
  const input = record(restored);
  const old = record(previous);
  if (!input) throw new ControlInputError("Configuration must be an object");
  delete input.revision;
  const restore = (
    entry: Record<string, unknown>,
    existing: Record<string, unknown> | undefined,
    field = "api_key",
  ): void => {
    if (entry[field] === SECRET_PLACEHOLDER) {
      if (
        typeof existing?.[field] !== "string" ||
        existing[field] === SECRET_PLACEHOLDER
      )
        throw new ControlInputError("A new credential requires a secret value");
      entry[field] = existing[field];
    }
  };
  for (const group of entries(input.proxy_groups)) {
    const existing = entries(old?.proxy_groups).find(
      (item) => item.id === group.id,
    );
    for (const proxy of entries(group.proxies))
      restore(
        proxy,
        entries(existing?.proxies).find((item) => item.id === proxy.id),
        "password",
      );
  }
  for (const provider of entries(input.providers)) {
    const existing = entries(old?.providers).find(
      (item) => item.id === provider.id,
    );
    if (existing && existing.type !== provider.type)
      throw new ControlInputError(
        "A provider's type cannot be changed; create a new provider",
      );
    for (const credential of entries(provider.credentials)) {
      const oldCredential = entries(existing?.credentials).find(
        (item) => item.id === credential.id,
      );
      const auth = record(credential.auth);
      const oldAuth = record(oldCredential?.auth);
      if (auth)
        restore(auth, auth.type === oldAuth?.type ? oldAuth : undefined);
    }
  }
  for (const client of entries(input.api_keys))
    restore(
      client,
      entries(old?.api_keys).find((item) => item.id === client.id),
    );
  const search = record(input.web_search);
  if (search) {
    const oldSearch = record(old?.web_search);
    restore(search, search.mode === oldSearch?.mode ? oldSearch : undefined);
  }
  return restored;
}

const isSecretField = (name: string): boolean =>
  name === "api_key" || name === "password";

export function maskSecrets(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(maskSecrets);
  const input = record(value);
  if (!input)
    return typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
      ? value
      : null;
  return Object.fromEntries(
    Object.entries(input).map(([name, entry]) => [
      name,
      isSecretField(name) && typeof entry === "string" && entry
        ? SECRET_PLACEHOLDER
        : maskSecrets(entry),
    ]),
  );
}

export async function resolveSecrets(
  value: unknown,
  db: SqlDatabase,
  decrypt: (ciphertext: string) => Promise<unknown>,
): Promise<unknown> {
  const result: unknown = structuredClone(value);
  const references = new Map<
    string,
    Array<{ object: Record<string, unknown>; key: string }>
  >();
  function visit(input: unknown): void {
    if (Array.isArray(input)) {
      input.forEach(visit);
      return;
    }
    if (!input || typeof input !== "object") return;
    const object = objectSchema.parse(input);
    // Work on the original object, after checking its external shape.
    for (const [key, entry] of Object.entries(object)) {
      const id =
        key === "api_key" || key === "password" ? secretId(entry) : undefined;
      if (id) {
        const slots = references.get(id) ?? [];
        slots.push({ object: input as Record<string, unknown>, key });
        references.set(id, slots);
      } else visit(entry);
    }
  }
  visit(result);
  const ids = [...references.keys()];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const values = await db
      .prepare(
        `SELECT id, ciphertext FROM secret_versions WHERE id IN (${batch.map(() => "?").join(",")}) AND revoked_at IS NULL`,
      )
      .bind(...batch)
      .all();
    const secrets = z
      .array(z.object({ id: z.string(), ciphertext: z.string() }))
      .parse(values.results);
    if (secrets.length !== batch.length)
      throw new Error("A configuration secret is missing or revoked");
    for (const secret of secrets) {
      const text = z.string().parse(await decrypt(secret.ciphertext));
      for (const slot of references.get(secret.id) ?? [])
        slot.object[slot.key] = text;
    }
  }
  return result;
}

export async function sealConfiguration(
  config: GatewayConfig,
  previous: GatewayConfig,
  previousRefs: GatewayConfig,
  encryptionKey: string,
  now: number,
): Promise<{ sealed: GatewayConfig; secrets: SecretVersion[] }> {
  const secrets: SecretVersion[] = [];
  const sealed = structuredClone(config);
  const seal = async (
    ownerId: string,
    field: string,
    value: string,
    previousValue: unknown,
    previousRef: unknown,
  ) => {
    if (secretId(value) || value === SECRET_PLACEHOLDER)
      throw new ControlInputError(
        "Secret references cannot be supplied as credentials",
      );
    if (value === previousValue && secretId(previousRef))
      return String(previousRef);
    const id = crypto.randomUUID();
    secrets.push({
      id,
      owner_id: ownerId,
      field,
      ciphertext: await encryptConfig(value, encryptionKey),
      created_at: now,
      revoked_at: null,
    });
    return secretReference(id);
  };
  for (const group of sealed.proxy_groups)
    for (const node of group.proxies) {
      if (!node.password) continue;
      const old = previous.proxy_groups
        .find((g) => g.id === group.id)
        ?.proxies.find((n) => n.id === node.id);
      const oldRef = previousRefs.proxy_groups
        .find((g) => g.id === group.id)
        ?.proxies.find((n) => n.id === node.id);
      node.password = await seal(
        node.id,
        "password",
        node.password,
        old?.password,
        oldRef?.password,
      );
    }
  for (const provider of sealed.providers)
    for (const credential of provider.credentials) {
      if (credential.auth.type !== "api_key") continue;
      const old = previous.providers
        .find((p) => p.id === provider.id)
        ?.credentials.find((c) => c.id === credential.id)?.auth;
      const oldRef = previousRefs.providers
        .find((p) => p.id === provider.id)
        ?.credentials.find((c) => c.id === credential.id)?.auth;
      credential.auth.api_key = await seal(
        credential.id,
        "api_key",
        credential.auth.api_key,
        old?.type === "api_key" ? old.api_key : undefined,
        oldRef?.type === "api_key" ? oldRef.api_key : undefined,
      );
    }
  for (const client of sealed.api_keys)
    client.api_key = await seal(
      client.id,
      "api_key",
      client.api_key,
      previous.api_keys.find((c) => c.id === client.id)?.api_key,
      previousRefs.api_keys.find((c) => c.id === client.id)?.api_key,
    );
  if (sealed.web_search.mode !== "proxy")
    sealed.web_search.api_key = await seal(
      "web_search",
      "api_key",
      sealed.web_search.api_key,
      previous.web_search.mode === sealed.web_search.mode
        ? previous.web_search.api_key
        : undefined,
      previousRefs.web_search.mode === sealed.web_search.mode
        ? previousRefs.web_search.api_key
        : undefined,
    );
  return { sealed, secrets };
}
