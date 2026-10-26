import { compareStrings } from "../../shared/compare.ts";
/**
 * Minimal Redis command surface used by the standard backend. `ioredis`
 * satisfies it through the adapter in `./ioredis.ts`; `MemoryRedis` is a
 * single-process implementation for tests only.
 */
export interface RedisSetOptions {
  readonly nx?: boolean;
  readonly px?: number;
}

export type RedisWriteCommand =
  | readonly ["set", string, string, number?]
  | readonly ["del", string]
  | readonly ["hset", string, string, string]
  | readonly ["hdel", string, string]
  | readonly ["zadd", string, number, string]
  | readonly ["zrem", string, string]
  | readonly ["pexpire", string, number];

export interface RedisCondition {
  readonly key: string;
  readonly value: string | null;
}

export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: RedisSetOptions): Promise<boolean>;
  del(key: string): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  hlen(key: string): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  hset(key: string, fields: Record<string, string>): Promise<void>;
  hdel(key: string, fields: readonly string[]): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<void>;
  zscore(key: string, member: string): Promise<number | null>;
  zrem(key: string, member: string): Promise<number>;
  zrangebyscore(
    key: string,
    max: number,
    limit: number,
  ): Promise<readonly string[]>;
  /** Executes the commands atomically (MULTI/EXEC). */
  multi(commands: readonly RedisWriteCommand[]): Promise<void>;
  /** Compare string values and apply all writes in one server-side operation. */
  compareAndWrite(
    conditions: readonly RedisCondition[],
    commands: readonly RedisWriteCommand[],
  ): Promise<boolean>;
  /** Deletes `key` only when it still holds `expected` (lock release). */
  deleteIfEquals(key: string, expected: string): Promise<boolean>;
  /** Renews a lock atomically without replacing a different owner. */
  expireIfEquals(
    key: string,
    expected: string,
    ttlMs: number,
  ): Promise<boolean>;
  quit(): Promise<void>;
}

export class MemoryRedis implements RedisClient {
  private readonly strings = new Map<string, string>();
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly sorted = new Map<string, Map<string, number>>();
  private readonly expirations = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  private liveString(key: string): string | undefined {
    this.expire(key);
    return this.strings.get(key);
  }

  private expire(key: string): void {
    const at = this.expirations.get(key);
    if (at !== undefined && at <= this.now()) {
      this.strings.delete(key);
      this.hashes.delete(key);
      this.sorted.delete(key);
      this.expirations.delete(key);
    }
  }

  async get(key: string): Promise<string | null> {
    return this.liveString(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    options: RedisSetOptions = {},
  ): Promise<boolean> {
    this.expire(key);
    if (options.nx && this.exists(key)) return false;
    this.expirations.delete(key);
    this.hashes.delete(key);
    this.sorted.delete(key);
    this.strings.set(key, value);
    if (options.px !== undefined)
      this.expirations.set(key, this.now() + options.px);
    return true;
  }

  async del(key: string): Promise<number> {
    this.expire(key);
    this.expirations.delete(key);
    let removed = 0;
    if (this.strings.delete(key)) removed += 1;
    if (this.hashes.delete(key)) removed += 1;
    if (this.sorted.delete(key)) removed += 1;
    return removed;
  }

  async hget(key: string, field: string): Promise<string | null> {
    this.expire(key);
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hlen(key: string): Promise<number> {
    this.expire(key);
    return this.hashes.get(key)?.size ?? 0;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    this.expire(key);
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }

  async hset(key: string, fields: Record<string, string>): Promise<void> {
    this.expire(key);
    let hash = this.hashes.get(key);
    if (!hash) {
      hash = new Map();
      this.hashes.set(key, hash);
    }
    for (const [field, value] of Object.entries(fields)) hash.set(field, value);
  }

  async hdel(key: string, fields: readonly string[]): Promise<number> {
    this.expire(key);
    const hash = this.hashes.get(key);
    if (!hash) return 0;
    let removed = 0;
    for (const field of fields) if (hash.delete(field)) removed += 1;
    if (hash.size === 0) this.hashes.delete(key);
    return removed;
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    this.expire(key);
    let set = this.sorted.get(key);
    if (!set) {
      set = new Map();
      this.sorted.set(key, set);
    }
    set.set(member, score);
  }

  async zscore(key: string, member: string): Promise<number | null> {
    this.expire(key);
    return this.sorted.get(key)?.get(member) ?? null;
  }

  async zrem(key: string, member: string): Promise<number> {
    this.expire(key);
    const set = this.sorted.get(key);
    if (!set) return 0;
    const removed = set.delete(member) ? 1 : 0;
    if (set.size === 0) this.sorted.delete(key);
    return removed;
  }

  async zrangebyscore(
    key: string,
    max: number,
    limit: number,
  ): Promise<readonly string[]> {
    this.expire(key);
    const set = this.sorted.get(key);
    if (!set) return [];
    return [...set.entries()]
      .filter(([, score]) => score <= max)
      .sort((a, b) => a[1] - b[1] || compareStrings(a[0], b[0]))
      .slice(0, limit)
      .map(([member]) => member);
  }

  async multi(commands: readonly RedisWriteCommand[]): Promise<void> {
    await this.compareAndWrite([], commands);
  }

  private exists(key: string): boolean {
    return (
      this.strings.has(key) || this.hashes.has(key) || this.sorted.has(key)
    );
  }

  async compareAndWrite(
    conditions: readonly RedisCondition[],
    commands: readonly RedisWriteCommand[],
  ): Promise<boolean> {
    // Do not yield between the comparisons and synchronous in-memory writes.
    if (
      conditions.some(
        ({ key, value }) => (this.liveString(key) ?? null) !== value,
      )
    )
      return false;
    for (const command of commands) {
      this.expire(command[1]);
      switch (command[0]) {
        case "set":
          this.expirations.delete(command[1]);
          this.hashes.delete(command[1]);
          this.sorted.delete(command[1]);
          this.strings.set(command[1], command[2]);
          if (command[3] !== undefined)
            this.expirations.set(command[1], this.now() + command[3]);
          break;
        case "del":
          this.strings.delete(command[1]);
          this.hashes.delete(command[1]);
          this.sorted.delete(command[1]);
          this.expirations.delete(command[1]);
          break;
        case "hset": {
          this.expire(command[1]);
          const fields =
            this.hashes.get(command[1]) ?? new Map<string, string>();
          fields.set(command[2], command[3]);
          this.hashes.set(command[1], fields);
          break;
        }
        case "hdel":
          this.hashes.get(command[1])?.delete(command[2]);
          break;
        case "zadd": {
          const members =
            this.sorted.get(command[1]) ?? new Map<string, number>();
          members.set(command[3], command[2]);
          this.sorted.set(command[1], members);
          break;
        }
        case "zrem":
          this.sorted.get(command[1])?.delete(command[2]);
          break;
        case "pexpire":
          if (this.exists(command[1]))
            this.expirations.set(command[1], this.now() + command[2]);
          break;
      }
    }
    return true;
  }

  async deleteIfEquals(key: string, expected: string): Promise<boolean> {
    if (this.liveString(key) !== expected) return false;
    this.strings.delete(key);
    this.expirations.delete(key);
    return true;
  }

  async quit(): Promise<void> {}

  async expireIfEquals(
    key: string,
    expected: string,
    ttlMs: number,
  ): Promise<boolean> {
    const value = this.liveString(key);
    if (value !== expected) return false;
    this.expirations.set(key, this.now() + ttlMs);
    return true;
  }
}
