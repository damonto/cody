/**
 * Minimal Redis command surface used by the standard backend. `ioredis`
 * satisfies it through the adapter in `./ioredis.ts`; `MemoryRedis` is a
 * single-process implementation for tests and for running without Redis.
 */
export interface RedisSetOptions {
  readonly nx?: boolean;
  readonly px?: number;
}

export type RedisWriteCommand =
  | readonly ["set", string, string]
  | readonly ["del", string]
  | readonly ["hset", string, string, string]
  | readonly ["hdel", string, string]
  | readonly ["zadd", string, number, string]
  | readonly ["zrem", string, string];

export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: RedisSetOptions): Promise<boolean>;
  del(key: string): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
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

interface MemoryString {
  value: string;
  expiresAt: number | undefined;
}

export class MemoryRedis implements RedisClient {
  private readonly strings = new Map<string, MemoryString>();
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly sorted = new Map<string, Map<string, number>>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  private liveString(key: string): MemoryString | undefined {
    const entry = this.strings.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.strings.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.liveString(key)?.value ?? null;
  }

  async set(
    key: string,
    value: string,
    options: RedisSetOptions = {},
  ): Promise<boolean> {
    if (options.nx && this.liveString(key)) return false;
    this.strings.set(key, {
      value,
      expiresAt: options.px === undefined ? undefined : this.now() + options.px,
    });
    return true;
  }

  async del(key: string): Promise<number> {
    let removed = 0;
    if (this.strings.delete(key)) removed += 1;
    if (this.hashes.delete(key)) removed += 1;
    if (this.sorted.delete(key)) removed += 1;
    return removed;
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }

  async hset(key: string, fields: Record<string, string>): Promise<void> {
    let hash = this.hashes.get(key);
    if (!hash) {
      hash = new Map();
      this.hashes.set(key, hash);
    }
    for (const [field, value] of Object.entries(fields)) hash.set(field, value);
  }

  async hdel(key: string, fields: readonly string[]): Promise<number> {
    const hash = this.hashes.get(key);
    if (!hash) return 0;
    let removed = 0;
    for (const field of fields) if (hash.delete(field)) removed += 1;
    if (hash.size === 0) this.hashes.delete(key);
    return removed;
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    let set = this.sorted.get(key);
    if (!set) {
      set = new Map();
      this.sorted.set(key, set);
    }
    set.set(member, score);
  }

  async zscore(key: string, member: string): Promise<number | null> {
    return this.sorted.get(key)?.get(member) ?? null;
  }

  async zrem(key: string, member: string): Promise<number> {
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
    const set = this.sorted.get(key);
    if (!set) return [];
    return [...set.entries()]
      .filter(([, score]) => score <= max)
      .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, limit)
      .map(([member]) => member);
  }

  async multi(commands: readonly RedisWriteCommand[]): Promise<void> {
    for (const command of commands) {
      switch (command[0]) {
        case "set":
          await this.set(command[1], command[2]);
          break;
        case "del":
          await this.del(command[1]);
          break;
        case "hset":
          await this.hset(command[1], { [command[2]]: command[3] });
          break;
        case "hdel":
          await this.hdel(command[1], [command[2]]);
          break;
        case "zadd":
          await this.zadd(command[1], command[2], command[3]);
          break;
        case "zrem":
          await this.zrem(command[1], command[2]);
          break;
      }
    }
  }

  async deleteIfEquals(key: string, expected: string): Promise<boolean> {
    if (this.liveString(key)?.value !== expected) return false;
    this.strings.delete(key);
    return true;
  }

  async quit(): Promise<void> {}

  async expireIfEquals(
    key: string,
    expected: string,
    ttlMs: number,
  ): Promise<boolean> {
    const value = this.liveString(key);
    if (value?.value !== expected) return false;
    value.expiresAt = this.now() + ttlMs;
    return true;
  }
}
