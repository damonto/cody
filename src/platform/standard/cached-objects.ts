import { z } from "zod";
import type { SqlDatabase } from "../bindings.ts";
import type { ObjectListOptions } from "../object-context.ts";
import {
  RedisObjectBackend,
  selectEntries,
  type ObjectBackend,
  type ObjectChange,
  type ObjectLock,
} from "./objects.ts";
import type { RedisClient, RedisWriteCommand } from "./redis.ts";
import { SqlObjectBackend } from "./sql-objects.ts";

const CACHE_TTL_MS = 5 * 60_000;
const revisionSchema = z.string().uuid();
const entriesSchema = z.array(z.tuple([z.string(), z.string()]));

export function objectCacheKey(
  prefix: string,
  namespace: string,
  name: string,
): string {
  return `${prefix}:cache:v1:${namespace}:${name}`;
}

export function isReplayObject(namespace: string, name: string): boolean {
  return namespace === "affinity" && name.startsWith("xai-replay:");
}

/**
 * SQL remains durable; a clean Redis revision serves reads without querying SQL.
 * Mark the cache dirty BEFORE a SQL commit. A crash leaves it dirty; recovery
 * advances the SQL fence before reading, rejecting an old owner's delayed write.
 * Publication and cache fills compare both the lease owner and cache revision.
 * Revision hashes are deleted on replacement and expire independently on eviction.
 */
export class CachedSqlObjectBackend implements ObjectBackend {
  private readonly sql: SqlObjectBackend;
  private readonly replay: RedisObjectBackend;

  constructor(
    private readonly db: SqlDatabase,
    private readonly redis: RedisClient,
    private readonly prefix = "cody",
  ) {
    this.sql = new SqlObjectBackend(db);
    this.replay = new RedisObjectBackend(redis, prefix);
  }

  async scope(
    namespace: string,
    name: string,
    lock?: ObjectLock,
  ): Promise<ObjectBackend> {
    if (!lock?.condition)
      throw new Error("Cached object storage requires a fenced lock");
    if (isReplayObject(namespace, name))
      return this.replay.scope(namespace, name, lock);
    return this.durableScope(namespace, name, lock);
  }

  private async durableScope(
    namespace: string,
    name: string,
    lock: ObjectLock,
  ): Promise<CachedObjectScope> {
    if (!lock.condition)
      throw new Error("Cached object storage requires a fenced lock");
    const key = objectCacheKey(this.prefix, namespace, name);
    const previous = await this.redis.get(key);
    const parsed = revisionSchema.safeParse(previous);
    let sql: SqlObjectBackend;
    if (parsed.success) {
      sql = new SqlObjectBackend(this.db, parsed.data);
    } else {
      const dirty = `recovering:${crypto.randomUUID()}`;
      if (
        !(await this.redis.compareAndWrite(
          [lock.condition, { key, value: previous }],
          [["set", key, dirty, CACHE_TTL_MS]],
        ))
      )
        throw new Error("Object cache recovery lost its lock");
      sql = await this.sql.claim(namespace, name);
      if (
        !(await this.redis.compareAndWrite(
          [lock.condition, { key, value: dirty }],
          [["set", key, sql.revision, CACHE_TTL_MS]],
        ))
      )
        throw new Error("Object cache recovery lost its lock");
    }
    return new CachedObjectScope(sql, this.redis, key, namespace, name, lock);
  }

  get(namespace: string, name: string, key: string): Promise<string | null> {
    return this.sql.get(namespace, name, key);
  }
  list(
    namespace: string,
    name: string,
    options: ObjectListOptions,
  ): Promise<[string, string][]> {
    return this.sql.list(namespace, name, options);
  }
  commit(): Promise<void> {
    return Promise.reject(
      new Error("Cached object writes require a scoped lock"),
    );
  }
  getAlarm(namespace: string, name: string): Promise<number | null> {
    return this.sql.getAlarm(namespace, name);
  }
  async dueAlarms(
    namespace: string,
    now: number,
    limit: number,
  ): Promise<string[]> {
    const durable = await this.sql.dueAlarms(
      namespace,
      now,
      limit,
      namespace === "affinity" ? "xai-replay:" : undefined,
    );
    if (namespace !== "affinity") return durable;
    // Replay is disposable Redis state; SQL is never a replay recovery source.
    const replay = await this.replay.dueAlarms(namespace, now, limit);
    return [...new Set([...durable, ...replay])];
  }
}

interface CachedPage {
  readonly options: ObjectListOptions;
  readonly entries: [string, string][];
}

class CachedObjectScope implements ObjectBackend {
  private readonly values = new Map<string, string | null>();
  private readonly pages = new Map<string, CachedPage>();
  private alarm: number | null | undefined;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly sql: SqlObjectBackend,
    private readonly redis: RedisClient,
    private readonly key: string,
    private readonly namespace: string,
    private readonly name: string,
    private readonly lock: ObjectLock,
  ) {}

  private get hash(): string {
    return `${this.key}:${this.sql.revision}`;
  }

  private async guarded(
    expected: string,
    commands: RedisWriteCommand[],
  ): Promise<void> {
    if (
      !this.lock.condition ||
      !(await this.redis.compareAndWrite(
        [this.lock.condition, { key: this.key, value: expected }],
        commands,
      ))
    )
      throw new Error("Object cache revision or lock was lost");
  }

  private async fill(field: string, value: string): Promise<void> {
    await this.guarded(this.sql.revision, [
      ["hset", this.hash, field, value],
      ["pexpire", this.hash, CACHE_TTL_MS],
    ]);
  }

  async get(
    _namespace: string,
    _name: string,
    key: string,
  ): Promise<string | null> {
    if (this.values.has(key)) return this.values.get(key) ?? null;
    const field = `item:${key}`;
    const cached = await this.redis.hget(this.hash, field);
    const value =
      cached === null
        ? await this.sql.get(this.namespace, this.name, key)
        : z.string().nullable().parse(JSON.parse(cached));
    if (cached === null) await this.fill(field, JSON.stringify(value));
    this.values.set(key, value);
    return value;
  }

  async list(
    _namespace: string,
    _name: string,
    options: ObjectListOptions,
  ): Promise<[string, string][]> {
    // Cache bounded SQL keyset pages; never fetch the entire Redis index hash.
    const field = `list:${JSON.stringify([options.prefix ?? null, options.startAfter ?? null, options.limit ?? null])}`;
    const memo = this.pages.get(field);
    if (memo) return memo.entries;
    const cached = await this.redis.hget(this.hash, field);
    const entries =
      cached === null
        ? await this.sql.list(this.namespace, this.name, options)
        : entriesSchema.parse(JSON.parse(cached));
    if (cached === null) await this.fill(field, JSON.stringify(entries));
    this.pages.set(field, { options: { ...options }, entries });
    for (const [key, value] of entries) this.values.set(key, value);
    return entries;
  }

  async getAlarm(): Promise<number | null> {
    if (this.alarm !== undefined) return this.alarm;
    const cached = await this.redis.hget(this.hash, "alarm");
    this.alarm =
      cached === null
        ? await this.sql.getAlarm(this.namespace, this.name)
        : z.number().finite().nullable().parse(JSON.parse(cached));
    if (cached === null) await this.fill("alarm", JSON.stringify(this.alarm));
    return this.alarm;
  }

  commit(
    _namespace: string,
    _name: string,
    change: ObjectChange,
  ): Promise<void> {
    const result = this.writes.then(() => this.apply(change));
    this.writes = result;
    void result.catch(() => undefined);
    return result;
  }

  private async apply(change: ObjectChange): Promise<void> {
    const oldHash = this.hash;
    const dirty = `writing:${crypto.randomUUID()}`;
    await this.guarded(this.sql.revision, [
      ["set", this.key, dirty, CACHE_TTL_MS],
    ]);
    await this.sql.commit(this.namespace, this.name, change);
    if (change.clear) this.values.clear();
    for (const key of change.deletes) this.values.set(key, null);
    for (const [key, value] of change.puts) this.values.set(key, value);
    if (change.alarm !== undefined) this.alarm = change.alarm;
    for (const [field, { options, entries }] of this.pages) {
      // A bounded page may need its next SQL row after a deletion. Only a
      // complete range can be updated without another authoritative query.
      if (options.limit !== undefined) {
        this.pages.delete(field);
        continue;
      }
      const next = new Map(change.clear ? [] : entries);
      for (const key of change.deletes) next.delete(key);
      for (const [key, value] of change.puts) next.set(key, value);
      this.pages.set(field, { options, entries: selectEntries(next, options) });
    }
    const commands: RedisWriteCommand[] = [["del", oldHash]];
    for (const [key, value] of this.values)
      commands.push(["hset", this.hash, `item:${key}`, JSON.stringify(value)]);
    if (this.alarm !== undefined)
      commands.push(["hset", this.hash, "alarm", JSON.stringify(this.alarm)]);
    for (const [field, { entries }] of this.pages)
      commands.push(["hset", this.hash, field, JSON.stringify(entries)]);
    commands.push(
      ["pexpire", this.hash, CACHE_TTL_MS],
      ["set", this.key, this.sql.revision, CACHE_TTL_MS],
    );
    await this.guarded(dirty, commands);
  }

  dueAlarms(): Promise<string[]> {
    return Promise.reject(new Error("Use the namespace alarm index"));
  }
}
