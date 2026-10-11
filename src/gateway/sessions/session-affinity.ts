import { SessionAffinityStatus } from "../routing/values.ts";
import { XaiReplayStore } from "../../providers/xai/replay-store.ts";

import { nextRotationCredential } from "../health/health.ts";
import { configureLogging, errorMessage, logWarn } from "../../shared/log.ts";
import {
  mapWithConcurrency,
  PROVIDER_FAN_OUT_CONCURRENCY,
} from "../../shared/concurrency.ts";
import {
  affinitySessionDigest,
  affinitySelectionIsHighestPriority,
  chooseAffinityCandidate,
  resolveStoredAffinity,
  SESSION_AFFINITY_TTL_MS,
  type AffinityProviderCandidate,
  type AffinitySelection,
  type SessionAffinityRecord,
  type SessionAffinityRegistration,
  type SessionAffinityResolution,
} from "../routing/affinity.ts";
import type {
  Bindings,
  ClearedSessionAffinityBinding,
  SessionAffinityResolveOptions,
} from "../../platform/bindings.ts";
import type {
  ObjectContext,
  ObjectTransaction,
  ObjectStorageReader,
} from "../../platform/object-context.ts";

const AFFINITY_STORAGE_KEY = "affinity";
const CONTEXT_OWNER_STORAGE_KEY = "context_owner";
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

interface AffinityTransactionResult {
  resolution: SessionAffinityResolution | undefined;
  obsolete: SessionAffinityRecord[];
}

interface ContextOwnerRecord {
  client_id: string;
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
    (record.model === undefined ||
      record.model === null ||
      (typeof record.model === "string" && record.model.trim() !== "")) &&
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
    model: record.model ?? null,
    session_digest: record.session_digest,
    session_id: record.session_id,
    binding_id: record.binding_id,
    created_at: record.created_at,
    generation: record.generation,
  };
}

function storageKey(
  record: Pick<SessionAffinityRecord, "model" | "session_digest">,
): string {
  return record.model == null
    ? AFFINITY_STORAGE_KEY
    : `${AFFINITY_STORAGE_KEY}:${record.session_digest}`;
}

async function records(
  storage: ObjectStorageReader,
): Promise<SessionAffinityRecord[]> {
  return [
    ...(await storage.list<unknown>({ prefix: AFFINITY_STORAGE_KEY })).values(),
  ].filter(validRecord);
}

function matchesSession(
  record: SessionAffinityRecord,
  registration: SessionAffinityRegistration,
): boolean {
  return (
    record.registry_name === registration.registry_name &&
    record.session_id === registration.session_id
  );
}

function active(
  record: SessionAffinityRecord | undefined,
  now: number,
): record is SessionAffinityRecord {
  return (
    record !== undefined && record.updated_at + SESSION_AFFINITY_TTL_MS > now
  );
}

/** Context pins take precedence over every requested model. Legacy ordinary
 * bindings have no model attribution and must never be adopted by a model. */
async function currentBinding(
  storage: ObjectStorageReader,
  registration: SessionAffinityRegistration,
  now: number,
): Promise<SessionAffinityRecord | undefined> {
  const session = await storage.get<unknown>(AFFINITY_STORAGE_KEY);
  if (
    validRecord(session) &&
    session.context_management &&
    matchesSession(session, registration) &&
    active(session, now)
  )
    return session;
  const model = await storage.get<unknown>(storageKey(registration));
  return validRecord(model) &&
    model.model === registration.model &&
    matchesSession(model, registration) &&
    model.session_digest === registration.session_digest
    ? model
    : undefined;
}

async function scheduleExpiry(
  transaction: ObjectTransaction,
  change?: {
    previous: readonly SessionAffinityRecord[];
    next: SessionAffinityRecord | undefined;
  },
): Promise<void> {
  const alarm = await transaction.getAlarm();
  // A write cannot move the nearest deadline unless it changes a record at
  // that deadline or introduces an earlier one. Avoid listing unrelated models.
  if (
    change &&
    alarm !== null &&
    !change.previous.some(
      (record) => record.updated_at + SESSION_AFFINITY_TTL_MS === alarm,
    )
  ) {
    if (change.next) {
      const expiresAt = change.next.updated_at + SESSION_AFFINITY_TTL_MS;
      if (expiresAt < alarm) await transaction.setAlarm(expiresAt);
    }
    return;
  }
  let nearest = Infinity;
  for (const record of await records(transaction)) {
    nearest = Math.min(nearest, record.updated_at + SESSION_AFFINITY_TTL_MS);
  }
  if (nearest === Infinity) await transaction.deleteAlarm();
  else if (nearest !== alarm) await transaction.setAlarm(nearest);
}

async function invalidateIndex(
  transaction: ObjectTransaction,
  record: SessionAffinityRecord,
): Promise<void> {
  // A rejected conditional delete may remove a stale index row afterwards.
  // Let the next resolve repair the surviving binding without rebinding it.
  if (record.index_registered)
    await transaction.put(storageKey(record), {
      ...record,
      index_registered: false,
    });
}

export class SessionAffinityCore {
  beginXaiReplay() {
    return new XaiReplayStore(this.ctx.storage).begin();
  }
  commitXaiReplay(version: string, value: string | null) {
    return new XaiReplayStore(this.ctx.storage).commit(version, value);
  }
  constructor(
    protected readonly ctx: ObjectContext,
    protected readonly env: Bindings,
  ) {
    configureLogging(this.env.LOG_LEVEL);
  }

  async resolve(
    candidates: AffinityProviderCandidate[],
    preferred: AffinitySelection | undefined,
    registration: SessionAffinityRegistration,
    options: SessionAffinityResolveOptions = {},
  ): Promise<SessionAffinityResolution | undefined> {
    if (!options.roundRobinProviderIds?.length)
      return this.resolveBinding(candidates, preferred, registration, options);
    // Only account election calls the shared rotation object. Serialize
    // that short RPC with the binding write so concurrent frames in the same
    // session cannot reserve multiple positions. No upstream I/O runs here.
    return this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const current = await currentBinding(this.ctx.storage, registration, now);
      const stored = active(current, now) ? current : undefined;
      const eligible =
        options.modelProviderIds === undefined
          ? candidates
          : candidates.filter((candidate) =>
              options.modelProviderIds?.includes(candidate.provider_id),
            );
      if (
        stored &&
        (stored.context_management ||
          resolveStoredAffinity(stored, eligible, preferred).status ===
            SessionAffinityStatus.Hit)
      )
        return this.resolveBinding(
          candidates,
          preferred,
          registration,
          options,
        );
      const selected = chooseAffinityCandidate(eligible);
      const provider = eligible.find(
        (candidate) => candidate.provider_id === selected?.provider_id,
      );
      if (
        provider &&
        options.roundRobinProviderIds?.includes(provider.provider_id)
      ) {
        const priority = Math.max(
          ...provider.credentials.map((credential) => credential.priority),
        );
        const credentialId = await nextRotationCredential(
          this.env,
          provider.provider_id,
          provider.credentials
            .filter((credential) => credential.priority === priority)
            .map((credential) => credential.credential_id),
          true,
        );
        if (credentialId)
          preferred = {
            provider_id: provider.provider_id,
            credential_id: credentialId,
          };
      }
      return this.resolveBinding(candidates, preferred, registration, options);
    });
  }

  private async resolveBinding(
    candidates: AffinityProviderCandidate[],
    preferred: AffinitySelection | undefined,
    registration: SessionAffinityRegistration,
    options: SessionAffinityResolveOptions,
  ): Promise<SessionAffinityResolution | undefined> {
    const modelProviderIds = options.modelProviderIds;
    const modelRegistration: SessionAffinityRegistration = {
      registry_name: registration.registry_name,
      session_id: registration.session_id,
      model: registration.model,
      session_digest: registration.session_digest,
    };
    const contextRegistration: SessionAffinityRegistration =
      options.contextManagement === true
        ? {
            ...modelRegistration,
            model: null,
            session_digest: await affinitySessionDigest(
              registration.session_id,
            ),
          }
        : modelRegistration;
    const shouldPinContext = (selection: AffinitySelection): boolean =>
      options.contextManagement === true &&
      candidates.some(
        (candidate) =>
          candidate.provider_id === selection.provider_id &&
          candidate.supports_context_management,
      );
    const result =
      await this.ctx.storage.transaction<AffinityTransactionResult>(
        async (transaction) => {
          const now = Date.now();
          const current = await currentBinding(transaction, registration, now);
          const stored = active(current, now) ? current : undefined;
          const obsolete: SessionAffinityRecord[] = [];
          const remove = async (record: SessionAffinityRecord) => {
            await transaction.delete(storageKey(record));
            obsolete.push(record);
          };
          const finish = async (
            resolution: SessionAffinityResolution | undefined,
          ): Promise<AffinityTransactionResult> => {
            if (resolution?.context_management) {
              // Promotion atomically makes the context pin the only binding.
              // Subsequent context hits need neither cleanup nor a full scan.
              if (!stored?.context_management) {
                for (const record of await records(transaction)) {
                  if (record.model != null) await remove(record);
                }
              }
              await transaction.setAlarm(
                resolution.updated_at + SESSION_AFFINITY_TTL_MS,
              );
            } else {
              await scheduleExpiry(transaction, {
                previous: current ? [...obsolete, current] : obsolete,
                next: resolution,
              });
            }
            return { resolution, obsolete };
          };
          // Old ordinary bindings cannot be assigned to a requested model. Keep
          // deployed context pins, and retire expired or unattributed records.
          const legacy = await transaction.get<unknown>(AFFINITY_STORAGE_KEY);
          if (legacy !== undefined && !validRecord(legacy))
            await transaction.delete(AFFINITY_STORAGE_KEY);
          if (
            validRecord(legacy) &&
            (!active(legacy, now) ||
              (!legacy.context_management && legacy.model === undefined))
          )
            await remove(legacy);

          if (stored?.context_management) {
            const provider = candidates.find(
              (candidate) => candidate.provider_id === stored.provider_id,
            );
            if (
              !provider?.supports_context_management ||
              !provider.credentials.some(
                (key) => key.credential_id === stored.credential_id,
              )
            ) {
              return finish({
                ...stored,
                status: SessionAffinityStatus.Blocked,
              });
            }
            const next: SessionAffinityRecord = {
              ...stored,
              model: null,
              context_management: true,
              updated_at: now,
            };
            await transaction.put(AFFINITY_STORAGE_KEY, next);
            return finish({ ...next, status: SessionAffinityStatus.Hit });
          }
          const modelCandidates =
            modelProviderIds === undefined
              ? candidates
              : candidates.filter((candidate) =>
                  modelProviderIds.includes(candidate.provider_id),
                );
          const decision = stored
            ? resolveStoredAffinity(stored, modelCandidates, preferred)
            : {
                selection: affinitySelectionIsHighestPriority(
                  preferred,
                  modelCandidates,
                )
                  ? preferred
                  : chooseAffinityCandidate(modelCandidates),
                status: SessionAffinityStatus.Created,
              };
          if (!decision.selection) {
            if (current) await remove(current);
            return finish(undefined);
          }
          const contextManagement = shouldPinContext(decision.selection);
          const rebound = decision.status === SessionAffinityStatus.Rebound;
          const changed = !stored || rebound || contextManagement;
          const next: SessionAffinityRecord = {
            ...stored,
            ...decision.selection,
            ...(contextManagement ? contextRegistration : modelRegistration),
            updated_at: now,
            binding_id:
              stored && !changed ? stored.binding_id : crypto.randomUUID(),
            created_at: stored && !rebound ? stored.created_at : now,
            generation:
              stored && !changed
                ? stored.generation
                : nextBindingGeneration(current),
            index_registered:
              stored !== undefined && !changed && stored.index_registered,
            ...(contextManagement ? { context_management: true } : {}),
          };
          if (current && !stored) await remove(current);
          if (stored && rebound && !contextManagement) obsolete.push(stored);
          await transaction.put(storageKey(next), next);
          return finish({ ...next, status: decision.status });
        },
      );
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
    obsolete: SessionAffinityRecord[],
    resolution: SessionAffinityResolution | undefined,
  ): void {
    if (!obsolete.length && (!resolution || resolution.index_registered)) {
      return;
    }
    const task = (async () => {
      for (const record of obsolete) await this.unregister(record);
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
              const rawCurrent = await transaction.get<unknown>(
                storageKey(candidate),
              );
              const current = validRecord(rawCurrent) ? rawCurrent : undefined;
              if (
                current &&
                current.binding_id === candidate.binding_id &&
                current.registry_name === candidate.registry_name &&
                current.session_digest === candidate.session_digest &&
                current.session_id === candidate.session_id &&
                current.generation === candidate.generation
              ) {
                await transaction.put(storageKey(candidate), {
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
            const rawCurrent = await transaction.get<unknown>(
              storageKey(candidate),
            );
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
            await transaction.put(storageKey(candidate), next);
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

  async getStatus(
    sessionDigest?: string,
  ): Promise<SessionAffinityRecord | null> {
    const stored = await this.readScoped(this.ctx.storage, sessionDigest);
    return active(stored, Date.now()) ? stored : null;
  }

  private async readScoped(
    storage: ObjectStorageReader,
    sessionDigest?: string,
  ): Promise<SessionAffinityRecord | undefined> {
    if (sessionDigest !== undefined) {
      const model = await storage.get<unknown>(
        `${AFFINITY_STORAGE_KEY}:${sessionDigest}`,
      );
      if (validRecord(model) && model.session_digest === sessionDigest)
        return model;
    }
    const session = await storage.get<unknown>(AFFINITY_STORAGE_KEY);
    return validRecord(session) &&
      (sessionDigest === undefined || session.session_digest === sessionDigest)
      ? session
      : undefined;
  }

  async clear(): Promise<void> {
    const cleared = await this.ctx.storage.transaction(async (transaction) => {
      const current = await records(transaction);
      for (const record of current)
        await transaction.delete(storageKey(record));
      await scheduleExpiry(transaction);
      return current;
    });
    for (const record of cleared) await this.unregister(record);
  }

  async clearIfBindingId(
    bindingId: string,
    generation: number,
    sessionDigest?: string,
  ): Promise<boolean> {
    if (
      typeof bindingId !== "string" ||
      bindingId.trim() === "" ||
      !validGeneration(generation)
    )
      return false;
    return this.ctx.storage.transaction(async (transaction) => {
      const current = await this.readScoped(transaction, sessionDigest);
      if (!current) return false;
      if (
        current.binding_id !== bindingId ||
        current.generation !== generation
      ) {
        await invalidateIndex(transaction, current);
        return false;
      }
      await transaction.delete(storageKey(current));
      await scheduleExpiry(transaction);
      return true;
    });
  }

  async clearManaged(
    registration: SessionAffinityRegistration,
    allModels = false,
  ): Promise<ClearedSessionAffinityBinding[]> {
    const index = this.env.SESSION_AFFINITY_INDEX.getByName(
      registration.registry_name,
    );
    const snapshots = (await records(this.ctx.storage)).filter(
      (record) =>
        matchesSession(record, registration) &&
        (allModels ||
          (record.session_digest === registration.session_digest &&
            (record.model ?? null) === registration.model)),
    );
    // Read the index before entering the storage transaction. Fence deletions
    // against its observed version, or the record snapshot when unindexed.
    // A stale index row is removed without deleting its replacement binding.
    const targets = await mapWithConcurrency(
      snapshots,
      PROVIDER_FAN_OUT_CONCURRENCY,
      async (record) => ({
        record,
        indexed: await index.get(record.session_digest),
      }),
    );
    const cleared = await this.ctx.storage.transaction(async (transaction) => {
      const cleared: ClearedSessionAffinityBinding[] = [];
      for (const { record, indexed } of targets) {
        const current = await transaction.get<unknown>(storageKey(record));
        const expected =
          indexed?.session_id === record.session_id ? indexed : record;
        if (!validRecord(current) || !matchesSession(current, registration))
          continue;
        if (
          current.binding_id !== expected.binding_id ||
          current.generation !== expected.generation
        ) {
          await invalidateIndex(transaction, current);
          continue;
        }
        await transaction.delete(storageKey(current));
        cleared.push({
          session_digest: current.session_digest,
          binding_id: current.binding_id,
          generation: current.generation,
        });
      }
      await scheduleExpiry(transaction);
      return cleared;
    });
    for (const { record, indexed } of targets) {
      const obsolete = indexed ?? record;
      await index.remove(
        obsolete.session_digest,
        obsolete.binding_id,
        obsolete.generation,
      );
    }
    return cleared;
  }

  async alarm(): Promise<void> {
    if (await new XaiReplayStore(this.ctx.storage).alarm()) return;
    const expired = await this.ctx.storage.transaction(async (transaction) => {
      const now = Date.now();
      const expired = (await records(transaction)).filter(
        (record) => !active(record, now),
      );
      for (const record of expired)
        await transaction.delete(storageKey(record));
      await scheduleExpiry(transaction);
      return expired;
    });
    for (const record of expired) await this.unregister(record);
  }
}
