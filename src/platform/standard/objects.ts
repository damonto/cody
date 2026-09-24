/**
 * Emulates the Durable Object execution model on the standard backend. Every
 * object call runs against a fresh instance while holding the object's lock
 * (in-process queue plus a Redis lock across processes), and follow-up work
 * registered with `waitUntil` finishes before the lock is released, which
 * mirrors the single-threaded object runtime the coordination code expects.
 *
 * Storage is pluggable per namespace: Redis for short-lived coordination
 * state and SQL for state that must survive restarts and cache eviction.
 */
import { errorMessage, logWarn } from "../../shared/log.ts";
import type { ObjectNamespace } from "../bindings.ts";
import type {
  AlarmHandler,
  ObjectContext,
  ObjectListOptions,
  ObjectStorage,
  ObjectTransaction,
} from "../object-context.ts";
import type { RedisClient, RedisWriteCommand } from "./redis.ts";
import type { BackgroundTasks } from "./tasks.ts";

const LOCK_TTL_MS = 30_000;
const LOCK_RENEW_MS = 10_000;
const LOCK_WAIT_MS = 60_000;
const ALARM_LEASE_MS = 60_000;
const ALARM_RETRY_MS = 10_000;
const ALARM_BATCH = 50;

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

export interface ObjectChange {
  /** Removes every stored key before applying the other changes. */
  readonly clear?: boolean;
  readonly deletes: readonly string[];
  readonly puts: readonly (readonly [string, string])[];
  /** `undefined` leaves the alarm unchanged; `null` removes it. */
  readonly alarm?: number | null;
}

/** Raw per-object storage; values are JSON text. */
export interface ObjectBackend {
  /** Pins the storage revision for one invocation, fencing stale writers. */
  scope?(namespace: string, name: string): Promise<ObjectBackend>;
  get(namespace: string, name: string, key: string): Promise<string | null>;
  list(
    namespace: string,
    name: string,
    options: ObjectListOptions,
  ): Promise<[string, string][]>;
  commit(namespace: string, name: string, change: ObjectChange): Promise<void>;
  getAlarm(namespace: string, name: string): Promise<number | null>;
  dueAlarms(namespace: string, now: number, limit: number): Promise<string[]>;
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Applies list options to unordered entries (Redis hashes, memory maps). */
export function selectEntries(
  entries: Iterable<[string, string]>,
  options: ObjectListOptions,
): [string, string][] {
  const selected = [...entries]
    .filter(
      ([key]) =>
        (options.prefix === undefined || key.startsWith(options.prefix)) &&
        (options.startAfter === undefined || key > options.startAfter),
    )
    .sort((a, b) => compareKeys(a[0], b[0]));
  return options.limit === undefined
    ? selected
    : selected.slice(0, options.limit);
}

export class RedisObjectBackend implements ObjectBackend {
  constructor(
    private readonly redis: RedisClient,
    private readonly prefix = "cody",
  ) {}

  private hashKey(namespace: string, name: string): string {
    return `${this.prefix}:o:${namespace}:${name}`;
  }

  private alarmKey(namespace: string): string {
    return `${this.prefix}:a:${namespace}`;
  }

  get(namespace: string, name: string, key: string): Promise<string | null> {
    return this.redis.hget(this.hashKey(namespace, name), key);
  }

  async list(
    namespace: string,
    name: string,
    options: ObjectListOptions,
  ): Promise<[string, string][]> {
    return selectEntries(
      Object.entries(await this.redis.hgetall(this.hashKey(namespace, name))),
      options,
    );
  }

  async commit(
    namespace: string,
    name: string,
    change: ObjectChange,
  ): Promise<void> {
    const hash = this.hashKey(namespace, name);
    const commands: RedisWriteCommand[] = [];
    if (change.clear) commands.push(["del", hash]);
    for (const key of change.deletes) commands.push(["hdel", hash, key]);
    for (const [key, value] of change.puts)
      commands.push(["hset", hash, key, value]);
    if (change.alarm === null)
      commands.push(["zrem", this.alarmKey(namespace), name]);
    else if (change.alarm !== undefined)
      commands.push(["zadd", this.alarmKey(namespace), change.alarm, name]);
    await this.redis.multi(commands);
  }

  getAlarm(namespace: string, name: string): Promise<number | null> {
    return this.redis.zscore(this.alarmKey(namespace), name);
  }

  async dueAlarms(
    namespace: string,
    now: number,
    limit: number,
  ): Promise<string[]> {
    return [
      ...(await this.redis.zrangebyscore(this.alarmKey(namespace), now, limit)),
    ];
  }
}

/** Single-process storage for objects whose lifetime is one connection. */
export class MemoryObjectBackend implements ObjectBackend {
  private readonly objects = new Map<string, Map<string, string>>();
  private readonly alarms = new Map<string, Map<string, number>>();

  private object(namespace: string, name: string): Map<string, string> {
    const id = `${namespace}\u0000${name}`;
    let object = this.objects.get(id);
    if (!object) {
      object = new Map();
      this.objects.set(id, object);
    }
    return object;
  }

  async get(
    namespace: string,
    name: string,
    key: string,
  ): Promise<string | null> {
    return this.object(namespace, name).get(key) ?? null;
  }

  async list(
    namespace: string,
    name: string,
    options: ObjectListOptions,
  ): Promise<[string, string][]> {
    return selectEntries(this.object(namespace, name), options);
  }

  async commit(
    namespace: string,
    name: string,
    change: ObjectChange,
  ): Promise<void> {
    const object = this.object(namespace, name);
    if (change.clear) object.clear();
    for (const key of change.deletes) object.delete(key);
    for (const [key, value] of change.puts) object.set(key, value);
    if (change.alarm !== undefined) {
      let alarms = this.alarms.get(namespace);
      if (!alarms) {
        alarms = new Map();
        this.alarms.set(namespace, alarms);
      }
      if (change.alarm === null) alarms.delete(name);
      else alarms.set(name, change.alarm);
    }
    if (object.size === 0) this.objects.delete(`${namespace}\u0000${name}`);
  }

  async getAlarm(namespace: string, name: string): Promise<number | null> {
    return this.alarms.get(namespace)?.get(name) ?? null;
  }

  async dueAlarms(
    namespace: string,
    now: number,
    limit: number,
  ): Promise<string[]> {
    return [...(this.alarms.get(namespace) ?? [])]
      .filter(([, at]) => at <= now)
      .sort((a, b) => a[1] - b[1])
      .slice(0, limit)
      .map(([name]) => name);
  }
}

// ---------------------------------------------------------------------------
// Storage API over a backend
// ---------------------------------------------------------------------------

/** Alarm bookkeeping shared by an object's storage and its transactions. */
export class AlarmState {
  /** `undefined` outside alarm runs; the visible alarm time while one runs. */
  override: number | null | undefined = undefined;

  constructor(
    private readonly backend: ObjectBackend,
    private readonly namespace: string,
    private readonly name: string,
    private readonly onChange?: (at: number | null) => void,
  ) {}

  read(): Promise<number | null> {
    if (this.override !== undefined) return Promise.resolve(this.override);
    return this.backend.getAlarm(this.namespace, this.name);
  }

  applied(alarm: number | null): void {
    if (this.override !== undefined) this.override = alarm;
    this.onChange?.(alarm);
  }
}

function parseValue<T>(raw: string | null | undefined): T | undefined {
  return raw === null || raw === undefined ? undefined : (JSON.parse(raw) as T);
}

class BackedTransaction implements ObjectTransaction {
  private readonly puts = new Map<string, string>();
  private readonly deletes = new Set<string>();
  private alarm: { value: number | null } | undefined;

  constructor(
    private readonly backend: ObjectBackend,
    private readonly namespace: string,
    private readonly name: string,
    private readonly alarms: AlarmState,
  ) {}

  async get<T = unknown>(key: string): Promise<T | undefined>;
  async get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  async get<T = unknown>(
    keyOrKeys: string | string[],
  ): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(keyOrKeys)) {
      const result = new Map<string, T>();
      for (const key of keyOrKeys) {
        const value = await this.get<T>(key);
        if (value !== undefined) result.set(key, value);
      }
      return result;
    }
    const staged = this.puts.get(keyOrKeys);
    if (staged !== undefined) return parseValue<T>(staged);
    if (this.deletes.has(keyOrKeys)) return undefined;
    return parseValue<T>(
      await this.backend.get(this.namespace, this.name, keyOrKeys),
    );
  }

  async list<T = unknown>(
    options: ObjectListOptions = {},
  ): Promise<Map<string, T>> {
    const stored = new Map(
      await this.backend.list(this.namespace, this.name, {
        ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
        ...(options.startAfter === undefined
          ? {}
          : { startAfter: options.startAfter }),
      }),
    );
    for (const key of this.deletes) stored.delete(key);
    for (const [key, value] of this.puts) stored.set(key, value);
    return new Map(
      selectEntries(stored, options).map(([key, value]) => [
        key,
        JSON.parse(value) as T,
      ]),
    );
  }

  getAlarm(): Promise<number | null> {
    if (this.alarm) return Promise.resolve(this.alarm.value);
    return this.alarms.read();
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.deletes.delete(key);
    this.puts.set(key, JSON.stringify(value));
  }

  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    let removed = 0;
    for (const key of keys) {
      const existed =
        this.puts.has(key) ||
        (!this.deletes.has(key) &&
          (await this.backend.get(this.namespace, this.name, key)) !== null);
      this.puts.delete(key);
      this.deletes.add(key);
      if (existed) removed += 1;
    }
    return Array.isArray(keyOrKeys) ? removed : removed > 0;
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarm = { value: Number(scheduledTime) };
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = { value: null };
  }

  async commit(): Promise<void> {
    if (!this.alarm && this.puts.size === 0 && this.deletes.size === 0) return;
    await this.backend.commit(this.namespace, this.name, {
      deletes: [...this.deletes],
      puts: [...this.puts],
      ...(this.alarm ? { alarm: this.alarm.value } : {}),
    });
    if (this.alarm) this.alarms.applied(this.alarm.value);
  }
}

export class BackedObjectStorage implements ObjectStorage {
  private operations: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly backend: ObjectBackend,
    private readonly namespace: string,
    private readonly name: string,
    readonly alarms: AlarmState,
  ) {}

  // Direct operations must wait for transactions as well as for each other.
  // Transaction callbacks use their own staged view and never enter this queue.
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation);
    this.operations = result.catch(() => undefined);
    return result;
  }

  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  get<T = unknown>(
    keyOrKeys: string | string[],
  ): Promise<T | undefined | Map<string, T>> {
    return this.enqueue(async () => {
      if (Array.isArray(keyOrKeys)) {
        const result = new Map<string, T>();
        for (const key of keyOrKeys) {
          const value = parseValue<T>(
            await this.backend.get(this.namespace, this.name, key),
          );
          if (value !== undefined) result.set(key, value);
        }
        return result;
      }
      return parseValue<T>(
        await this.backend.get(this.namespace, this.name, keyOrKeys),
      );
    });
  }

  list<T = unknown>(options: ObjectListOptions = {}): Promise<Map<string, T>> {
    return this.enqueue(
      async () =>
        new Map(
          (await this.backend.list(this.namespace, this.name, options)).map(
            ([key, value]) => [key, JSON.parse(value) as T],
          ),
        ),
    );
  }

  getAlarm(): Promise<number | null> {
    return this.enqueue(() => this.alarms.read());
  }

  put<T>(key: string, value: T): Promise<void> {
    const serialized = JSON.stringify(value);
    return this.enqueue(() =>
      this.backend.commit(this.namespace, this.name, {
        deletes: [],
        puts: [[key, serialized]],
      }),
    );
  }

  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    const keys = Array.isArray(keyOrKeys)
      ? [...new Set(keyOrKeys)]
      : [keyOrKeys];
    return this.enqueue(async () => {
      let removed = 0;
      for (const key of keys) {
        if ((await this.backend.get(this.namespace, this.name, key)) !== null)
          removed += 1;
      }
      await this.backend.commit(this.namespace, this.name, {
        deletes: keys,
        puts: [],
      });
      return Array.isArray(keyOrKeys) ? removed : removed > 0;
    });
  }

  setAlarm(scheduledTime: number | Date): Promise<void> {
    const at = Number(scheduledTime);
    return this.enqueue(async () => {
      await this.backend.commit(this.namespace, this.name, {
        deletes: [],
        puts: [],
        alarm: at,
      });
      this.alarms.applied(at);
    });
  }

  deleteAlarm(): Promise<void> {
    return this.enqueue(async () => {
      await this.backend.commit(this.namespace, this.name, {
        deletes: [],
        puts: [],
        alarm: null,
      });
      this.alarms.applied(null);
    });
  }

  transaction<T>(
    closure: (transaction: ObjectTransaction) => Promise<T>,
  ): Promise<T> {
    return this.enqueue(async () => {
      const transaction = new BackedTransaction(
        this.backend,
        this.namespace,
        this.name,
        this.alarms,
      );
      const result = await closure(transaction);
      await transaction.commit();
      return result;
    });
  }

  deleteAll(): Promise<void> {
    return this.enqueue(async () => {
      await this.backend.commit(this.namespace, this.name, {
        clear: true,
        deletes: [],
        puts: [],
        alarm: null,
      });
      this.alarms.applied(null);
    });
  }
}

export class StandardObjectContext implements ObjectContext {
  private readonly initializing: Promise<unknown>[] = [];
  private readonly pending = new Set<Promise<unknown>>();

  constructor(readonly storage: BackedObjectStorage) {}

  waitUntil(promise: Promise<unknown>): void {
    const settled = promise.then(
      () => undefined,
      (error: unknown) => {
        logWarn("object.background.failed", { error: errorMessage(error) });
      },
    );
    this.pending.add(settled);
    void settled.finally(() => this.pending.delete(settled));
  }

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    const task = callback();
    this.initializing.push(task);
    void task.catch(() => undefined);
    return task;
  }

  /** Mirrors the runtime waiting for constructor initialization to finish. */
  async ready(): Promise<void> {
    while (this.initializing.length > 0) {
      await Promise.all(this.initializing.splice(0));
    }
  }

  /** The object stays busy until its follow-up work has settled. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }
}

/**
 * Runs an alarm handler with Durable Object semantics: `getAlarm()` reads
 * null while it runs, and the alarm is cleared unless the handler set a new
 * one. A failing handler is retried after a delay.
 */
export async function runAlarmHandler(
  storage: BackedObjectStorage,
  handler: AlarmHandler,
  now: () => number,
): Promise<void> {
  const alarms = storage.alarms;
  alarms.override = null;
  try {
    await handler.alarm();
    if (alarms.override === null) await storage.deleteAlarm();
  } catch (error) {
    logWarn("object.alarm.failed", { error: errorMessage(error) });
    if (alarms.override === null) {
      await storage.setAlarm(now() + ALARM_RETRY_MS);
    }
  } finally {
    alarms.override = undefined;
  }
}

// ---------------------------------------------------------------------------
// Locks and runtime
// ---------------------------------------------------------------------------

export interface ObjectLock {
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

export interface ObjectLocks {
  acquire(key: string): Promise<ObjectLock>;
}

export class ObjectLockTimeoutError extends Error {
  override name = "ObjectLockTimeoutError";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cross-process mutual exclusion with a renewed, owner-checked Redis lease. */
export class RedisObjectLocks implements ObjectLocks {
  constructor(
    private readonly redis: RedisClient,
    private readonly prefix = "cody",
    private readonly now: () => number = () => Date.now(),
  ) {}

  async acquire(name: string): Promise<ObjectLock> {
    const key = `${this.prefix}:l:${name}`;
    const token = crypto.randomUUID();
    const deadline = this.now() + LOCK_WAIT_MS;
    let delay = 5;
    while (!(await this.redis.set(key, token, { nx: true, px: LOCK_TTL_MS }))) {
      if (this.now() >= deadline) {
        throw new ObjectLockTimeoutError(`object lock timed out: ${name}`);
      }
      await sleep(delay + Math.floor(Math.random() * delay));
      delay = Math.min(delay * 2, 200);
    }
    let lost = false;
    const renewal = setInterval(() => {
      void this.redis
        .expireIfEquals(key, token, LOCK_TTL_MS)
        .then((renewed) => {
          if (!renewed) lost = true;
        })
        .catch(() => {
          lost = true;
        });
    }, LOCK_RENEW_MS);
    renewal.unref?.();
    return {
      assertHeld: async () => {
        if (lost || (await this.redis.get(key)) !== token)
          throw new Error("Object lock was lost");
      },
      release: async () => {
        clearInterval(renewal);
        await this.redis.deleteIfEquals(key, token).catch(() => false);
      },
    };
  }
}

export type ObjectFactory<T> = (ctx: ObjectContext, name: string) => T;

export interface ObjectNamespaceOptions {
  readonly backend: ObjectBackend;
  /** Objects with alarms are woken by `runDueAlarms` and on access. */
  readonly alarms?: boolean;
}

interface NamespaceRegistration {
  readonly backend: ObjectBackend;
  readonly runAlarm?: (name: string, now: number) => Promise<number>;
}

/** A typed call boundary: the stub exposes only the methods it actually binds. */
export type ObjectInvoker<T> = <R>(
  operation: (instance: T) => R | Promise<R>,
) => Promise<R>;

function hasAlarm(instance: object): instance is AlarmHandler {
  return "alarm" in instance && typeof instance.alarm === "function";
}

export interface ObjectRuntimeOptions {
  readonly locks: ObjectLocks;
  readonly tasks: BackgroundTasks;
  readonly now?: () => number;
  /** Called whenever an object schedules an alarm in this process. */
  readonly onAlarmScheduled?: (at: number) => void;
}

export class ObjectRuntime {
  private readonly namespaces = new Map<string, NamespaceRegistration>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly now: () => number;

  constructor(private readonly options: ObjectRuntimeOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Registers a namespace and builds typed stubs whose calls hold the object lock. */
  namespace<T extends object, S extends object>(
    namespace: string,
    factory: ObjectFactory<T>,
    bind: (invoke: ObjectInvoker<T>) => S,
    options: ObjectNamespaceOptions,
  ): ObjectNamespace<S> {
    if (this.namespaces.has(namespace))
      throw new Error(`Duplicate object namespace ${namespace}`);
    this.namespaces.set(namespace, {
      backend: options.backend,
      ...(options.alarms
        ? {
            runAlarm: (name: string, now: number) =>
              this.invoke(
                namespace,
                name,
                factory,
                options.backend,
                async (instance, storage) => {
                  // Another process may have run or moved this alarm meanwhile.
                  const scheduled = await storage.getAlarm();
                  if (scheduled === null || scheduled > now) return 0;
                  if (!hasAlarm(instance)) {
                    await storage.deleteAlarm();
                    return 0;
                  }
                  await this.leaseAlarm(storage);
                  await runAlarmHandler(storage, instance, this.now);
                  return 1;
                },
              ),
          }
        : {}),
    });
    return {
      getByName: (name) =>
        bind((operation) =>
          this.invoke(
            namespace,
            name,
            factory,
            options.backend,
            async (instance, storage) => {
              // Catch up overdue alarms on access on deployments with infrequent cron.
              if (options.alarms) await this.catchUpAlarm(instance, storage);
              return operation(instance);
            },
          ),
        ),
    };
  }

  private async catchUpAlarm(
    instance: object,
    storage: BackedObjectStorage,
  ): Promise<void> {
    if (!hasAlarm(instance)) return;
    const scheduled = await storage.getAlarm();
    if (scheduled === null || scheduled > this.now()) return;
    await this.leaseAlarm(storage);
    await runAlarmHandler(storage, instance, this.now);
  }

  private async leaseAlarm(storage: BackedObjectStorage): Promise<void> {
    // A crash while the handler runs retries once the lease expires.
    await storage.setAlarm(this.now() + ALARM_LEASE_MS);
  }

  /** Runs against a fresh instance; factory and instance types stay paired. */
  private invoke<T, R>(
    namespace: string,
    name: string,
    factory: ObjectFactory<T>,
    backend: ObjectBackend,
    operation: (instance: T, storage: BackedObjectStorage) => Promise<R> | R,
  ): Promise<R> {
    const key = `${namespace}:${name}`;
    return new Promise<R>((resolve, reject) => {
      const run = async (): Promise<void> => {
        let lock: ObjectLock;
        try {
          lock = await this.options.locks.acquire(key);
        } catch (error) {
          reject(error);
          return;
        }
        try {
          const scoped = (await backend.scope?.(namespace, name)) ?? backend;
          await lock.assertHeld();
          const storage = new BackedObjectStorage(
            scoped,
            namespace,
            name,
            new AlarmState(scoped, namespace, name, (at) => {
              if (at !== null) this.options.onAlarmScheduled?.(at);
            }),
          );
          const context = new StandardObjectContext(storage);
          try {
            const instance = factory(context, name);
            await context.ready();
            const value = await operation(instance, storage);
            await lock.assertHeld();
            // Acknowledgement need not wait for outbox delivery, but the next
            // invocation must wait for the background work and lock release.
            resolve(value);
          } catch (error) {
            reject(error);
          } finally {
            await context.drain();
          }
        } catch (error) {
          reject(error);
        } finally {
          await lock.release();
        }
      };
      const previous = this.queues.get(key) ?? Promise.resolve();
      const queued = previous.then(run, run);
      this.queues.set(key, queued);
      const cleanup = () => {
        if (this.queues.get(key) === queued) this.queues.delete(key);
      };
      void queued.then(cleanup, cleanup);
      this.options.tasks.track(queued);
    });
  }

  /** Delivers alarms that are due; returns how many handlers ran. */
  async runDueAlarms(now: number = this.now()): Promise<number> {
    let count = 0;
    for (const [namespace, registration] of this.namespaces) {
      if (!registration.runAlarm) continue;
      const due = await registration.backend.dueAlarms(
        namespace,
        now,
        ALARM_BATCH,
      );
      for (const name of due) count += await registration.runAlarm(name, now);
    }
    return count;
  }
}
