import { DurableObject } from "cloudflare:workers";

import {
  affinitySelectionIsHighestPriority,
  chooseAffinityCandidate,
  resolveStoredAffinity,
  SESSION_AFFINITY_TTL_MS,
  type AffinitySelection,
  type AffinityProviderCandidate,
  type SessionAffinityRecord,
  type SessionAffinityRegistration,
  type SessionAffinityResolution,
} from "../routing/affinity.ts";
import { configureLogging, errorMessage, logWarn } from "../../shared/log.ts";

const AFFINITY_STORAGE_KEY = "affinity";
const CONTEXT_OWNER_STORAGE_KEY = "context_owner";
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

interface ClearedSessionAffinityBinding {
  binding_id: string;
  generation: number;
}

interface AffinityTransactionResult {
  resolution: SessionAffinityResolution | undefined;
  obsolete?: SessionAffinityRecord;
}

interface ContextOwnerRecord {
  client_id: string;
}

interface SessionAffinityResolveOptions {
  contextManagement?: boolean;
  initialProviderIds?: readonly string[];
}

function validGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function validRecord(value: unknown): value is SessionAffinityRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<SessionAffinityRecord>;
  return (
    typeof record.provider_id === "string" &&
    record.provider_id.trim() !== "" &&
    typeof record.credential_id === "string" &&
    record.credential_id.trim() !== "" &&
    typeof record.updated_at === "number" &&
    Number.isSafeInteger(record.updated_at) &&
    record.updated_at >= 0 &&
    typeof record.binding_id === "string" &&
    record.binding_id.trim() !== "" &&
    typeof record.created_at === "number" &&
    Number.isSafeInteger(record.created_at) &&
    record.created_at >= 0 &&
    typeof record.registry_name === "string" &&
    DIGEST_PATTERN.test(record.registry_name) &&
    typeof record.session_digest === "string" &&
    DIGEST_PATTERN.test(record.session_digest) &&
    typeof record.session_id === "string" &&
    record.session_id.length > 0 &&
    typeof record.index_registered === "boolean" &&
    (record.context_management === undefined ||
      typeof record.context_management === "boolean") &&
    validGeneration(record.generation)
  );
}

function validContextOwner(value: unknown): value is ContextOwnerRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const owner = value as Partial<ContextOwnerRecord>;
  return typeof owner.client_id === "string" && owner.client_id.trim() !== "";
}

function nextBindingGeneration(
  stored: SessionAffinityRecord | undefined,
): number {
  const generation = stored?.generation ?? 0;
  if (generation >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("session affinity generation exhausted");
  }
  return generation + 1;
}

function indexEntry(record: SessionAffinityRecord) {
  return {
    session_digest: record.session_digest,
    session_id: record.session_id,
    binding_id: record.binding_id,
    created_at: record.created_at,
    generation: record.generation,
  };
}

export class SessionAffinity extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    configureLogging(this.env.LOG_LEVEL);
  }

  async resolve(
    candidates: AffinityProviderCandidate[],
    preferred: AffinitySelection | undefined,
    registration: SessionAffinityRegistration,
    options: SessionAffinityResolveOptions = {},
  ): Promise<SessionAffinityResolution | undefined> {
    const contextManagement = options.contextManagement === true;
    const initialProviderIds = options.initialProviderIds;
    if (contextManagement) {
      candidates = candidates.filter(
        (candidate) => candidate.supports_context_management,
      );
    }
    const now = Date.now();
    const result: AffinityTransactionResult =
      await this.ctx.storage.transaction(async (transaction) => {
        const rawStored = await transaction.get<unknown>(AFFINITY_STORAGE_KEY);
        const current = validRecord(rawStored) ? rawStored : undefined;
        const stored =
          current &&
          current.registry_name === registration.registry_name &&
          current.session_digest === registration.session_digest &&
          current.session_id === registration.session_id
            ? current
            : undefined;
        const storedActive =
          stored !== undefined &&
          stored.updated_at + SESSION_AFFINITY_TTL_MS > now;
        if (storedActive) {
          if (stored.context_management || contextManagement) {
            const provider = candidates.find(
              (candidate) => candidate.provider_id === stored.provider_id,
            );
            if (
              !provider?.supports_context_management ||
              !provider.credentials.some(
                (key) => key.credential_id === stored.credential_id,
              )
            ) {
              return { resolution: { ...stored, status: "blocked" as const } };
            }
            const next = {
              ...stored,
              context_management: true,
              updated_at: now,
            };
            await transaction.put(AFFINITY_STORAGE_KEY, next);
            return { resolution: { ...next, status: "hit" as const } };
          }
          const decision = resolveStoredAffinity(stored, candidates, preferred);
          if (!decision.selection) {
            await transaction.delete(AFFINITY_STORAGE_KEY);
            return { resolution: undefined, obsolete: stored };
          }
          const rotateBinding = decision.status === "rebound";
          const next: SessionAffinityRecord = rotateBinding
            ? {
                ...stored,
                ...decision.selection,
                updated_at: now,
                binding_id: crypto.randomUUID(),
                created_at: now,
                generation: nextBindingGeneration(stored),
                index_registered: false,
              }
            : {
                ...stored,
                ...decision.selection,
                updated_at: now,
              };
          await transaction.put(AFFINITY_STORAGE_KEY, next);
          return {
            resolution: { ...next, status: decision.status },
            ...(rotateBinding ? { obsolete: stored } : {}),
          };
        }

        const initialCandidates =
          initialProviderIds === undefined
            ? candidates
            : candidates.filter((candidate) =>
                initialProviderIds.includes(candidate.provider_id),
              );
        const selected = affinitySelectionIsHighestPriority(
          preferred,
          initialCandidates,
        )
          ? preferred
          : chooseAffinityCandidate(initialCandidates);
        if (!selected) {
          await transaction.delete(AFFINITY_STORAGE_KEY);
          return {
            resolution: undefined,
            ...(current ? { obsolete: current } : {}),
          };
        }
        const next: SessionAffinityRecord = {
          ...selected,
          updated_at: now,
          binding_id: crypto.randomUUID(),
          created_at: now,
          generation: nextBindingGeneration(current),
          registry_name: registration.registry_name,
          session_digest: registration.session_digest,
          session_id: registration.session_id,
          index_registered: false,
          ...(contextManagement ? { context_management: true } : {}),
        };
        await transaction.put(AFFINITY_STORAGE_KEY, next);
        return {
          resolution: { ...next, status: "created" as const },
          ...(current ? { obsolete: current } : {}),
        };
      });

    try {
      if (result.resolution) {
        await this.ctx.storage.setAlarm(
          result.resolution.updated_at + SESSION_AFFINITY_TTL_MS,
        );
      } else {
        await this.ctx.storage.deleteAlarm();
      }
    } catch (error) {
      logWarn("affinity.alarm_update.failed", { error: errorMessage(error) });
    }
    this.scheduleIndexSync(result.obsolete, result.resolution);
    return result.resolution;
  }

  // A raw upstream session ID must never be claimed by two gateway clients.
  // Ownership outlives affinity expiry because the upstream may retain history.
  async claimContextSession(clientId: string): Promise<boolean> {
    if (clientId.trim() === "") {
      return false;
    }
    return this.ctx.storage.transaction(async (transaction) => {
      const owner = await transaction.get<unknown>(CONTEXT_OWNER_STORAGE_KEY);
      if (owner !== undefined) {
        return validContextOwner(owner) && owner.client_id === clientId;
      }
      await transaction.put(CONTEXT_OWNER_STORAGE_KEY, { client_id: clientId });
      return true;
    });
  }

  async releaseContextSession(
    clientId: string,
  ): Promise<"released" | "missing" | "forbidden"> {
    // A release is explicit, after upstream history is erased and writers stop.
    // Keep the ownership check and full storage reclamation in one input gate.
    return this.ctx.blockConcurrencyWhile(async () => {
      const owner = await this.ctx.storage.get<unknown>(
        CONTEXT_OWNER_STORAGE_KEY,
      );
      if (owner === undefined) {
        return "missing";
      }
      if (!validContextOwner(owner) || owner.client_id !== clientId) {
        return "forbidden";
      }
      await this.ctx.storage.deleteAll();
      return "released";
    });
  }

  private scheduleIndexSync(
    obsolete: SessionAffinityRecord | undefined,
    resolution: SessionAffinityResolution | undefined,
  ): void {
    if (!obsolete && (!resolution || resolution.index_registered)) {
      return;
    }
    const task = (async () => {
      if (obsolete) {
        await this.unregister(obsolete);
      }
      if (resolution && !resolution.index_registered) {
        await this.ensureIndexed(resolution);
      }
    })().catch((error) => {
      logWarn("affinity.index_sync.failed", { error: errorMessage(error) });
    });
    this.ctx.waitUntil(task);
  }

  private async ensureIndexed(record: SessionAffinityRecord): Promise<void> {
    let candidate = record;
    try {
      const index = this.env.SESSION_AFFINITY_INDEX.getByName(
        record.registry_name,
      );
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const indexed = await index.register(indexEntry(candidate));
        if (
          indexed.binding_id === candidate.binding_id &&
          indexed.session_id === candidate.session_id &&
          indexed.created_at === candidate.created_at &&
          indexed.generation === candidate.generation
        ) {
          const retained = await this.ctx.storage.transaction(
            async (transaction) => {
              const rawCurrent =
                await transaction.get<unknown>(AFFINITY_STORAGE_KEY);
              const current = validRecord(rawCurrent) ? rawCurrent : undefined;
              if (
                current &&
                current.binding_id === candidate.binding_id &&
                current.registry_name === candidate.registry_name &&
                current.session_digest === candidate.session_digest &&
                current.session_id === candidate.session_id &&
                current.generation === candidate.generation
              ) {
                await transaction.put(AFFINITY_STORAGE_KEY, {
                  ...current,
                  index_registered: true,
                });
                return true;
              }
              return false;
            },
          );
          if (!retained) {
            await index.remove(
              candidate.session_digest,
              candidate.binding_id,
              candidate.generation,
            );
          }
          return;
        }

        if (indexed.generation < candidate.generation) {
          return;
        }
        const replacement = await this.ctx.storage.transaction(
          async (transaction) => {
            const rawCurrent =
              await transaction.get<unknown>(AFFINITY_STORAGE_KEY);
            const current = validRecord(rawCurrent) ? rawCurrent : undefined;
            if (
              !current ||
              current.binding_id !== candidate.binding_id ||
              current.registry_name !== candidate.registry_name ||
              current.session_digest !== candidate.session_digest ||
              current.session_id !== candidate.session_id
            ) {
              return undefined;
            }
            const generation = Math.max(current.generation, indexed.generation);
            if (generation >= Number.MAX_SAFE_INTEGER) {
              return undefined;
            }
            const next: SessionAffinityRecord = {
              ...current,
              generation: generation + 1,
              index_registered: false,
            };
            await transaction.put(AFFINITY_STORAGE_KEY, next);
            return next;
          },
        );
        if (!replacement) {
          await index.remove(
            candidate.session_digest,
            candidate.binding_id,
            candidate.generation,
          );
          return;
        }
        candidate = replacement;
      }
      logWarn("affinity.index_register.conflict", {
        session_digest: candidate.session_digest,
      });
    } catch (error) {
      logWarn("affinity.index_register.failed", {
        session_digest: record.session_digest,
        error: errorMessage(error),
      });
    }
  }

  private async unregister(record: SessionAffinityRecord): Promise<void> {
    try {
      await this.env.SESSION_AFFINITY_INDEX.getByName(
        record.registry_name,
      ).remove(record.session_digest, record.binding_id, record.generation);
    } catch (error) {
      logWarn("affinity.index_remove.failed", {
        session_digest: record.session_digest,
        error: errorMessage(error),
      });
    }
  }

  async getStatus(): Promise<SessionAffinityRecord | null> {
    const stored = await this.ctx.storage.get<unknown>(AFFINITY_STORAGE_KEY);
    if (
      !validRecord(stored) ||
      stored.updated_at + SESSION_AFFINITY_TTL_MS <= Date.now()
    ) {
      return null;
    }
    return stored;
  }

  async clear(): Promise<void> {
    const stored = await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<unknown>(AFFINITY_STORAGE_KEY);
      await transaction.delete(AFFINITY_STORAGE_KEY);
      await transaction.deleteAlarm();
      return current;
    });
    if (validRecord(stored)) {
      await this.unregister(stored);
    }
  }

  async clearIfBindingId(
    bindingId: string,
    generation: number,
  ): Promise<boolean> {
    if (
      typeof bindingId !== "string" ||
      bindingId.trim() === "" ||
      !validGeneration(generation)
    ) {
      return false;
    }
    return this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<unknown>(AFFINITY_STORAGE_KEY);
      if (
        !validRecord(current) ||
        current.binding_id !== bindingId ||
        current.generation !== generation
      ) {
        return false;
      }
      await transaction.delete(AFFINITY_STORAGE_KEY);
      await transaction.deleteAlarm();
      return true;
    });
  }

  async clearManaged(
    registration: SessionAffinityRegistration,
  ): Promise<ClearedSessionAffinityBinding | null> {
    return this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<unknown>(AFFINITY_STORAGE_KEY);
      if (
        !validRecord(current) ||
        current.registry_name !== registration.registry_name ||
        current.session_digest !== registration.session_digest ||
        current.session_id !== registration.session_id
      ) {
        return null;
      }
      await transaction.delete(AFFINITY_STORAGE_KEY);
      await transaction.deleteAlarm();
      return {
        binding_id: current.binding_id,
        generation: current.generation,
      };
    });
  }

  override async alarm(): Promise<void> {
    const expired = await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<unknown>(AFFINITY_STORAGE_KEY);
      if (!validRecord(current)) {
        await transaction.delete(AFFINITY_STORAGE_KEY);
        await transaction.deleteAlarm();
        return undefined;
      }
      const expiresAt = current.updated_at + SESSION_AFFINITY_TTL_MS;
      if (expiresAt <= Date.now()) {
        await transaction.delete(AFFINITY_STORAGE_KEY);
        await transaction.deleteAlarm();
        return current;
      }
      await transaction.setAlarm(expiresAt);
      return undefined;
    });
    if (expired) {
      await this.unregister(expired);
    }
  }
}
