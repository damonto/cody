import type { Redis } from "ioredis";
import { logWarn } from "../../shared/log.ts";
import type {
  RedisClient,
  RedisSetOptions,
  RedisWriteCommand,
} from "./redis.ts";

const RELEASE_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0';

export interface RedisConnectionOptions {
  /** Close idle connections before a serverless instance can be suspended. */
  readonly idleTimeoutMs?: number;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

/** Adapts an `ioredis` connection to the command surface used by the runtime. */
export class IoRedisClient implements RedisClient {
  private connection: Promise<Redis> | undefined;
  private pending = 0;
  private closed = false;
  private idle:
    { timer: ReturnType<typeof setTimeout>; resolve(): void } | undefined;

  constructor(
    private readonly open: () => Promise<Redis>,
    private readonly options: RedisConnectionOptions = {},
  ) {}

  private cancelIdle(): void {
    if (!this.idle) return;
    clearTimeout(this.idle.timer);
    this.idle.resolve();
    this.idle = undefined;
  }

  private scheduleIdle(): void {
    const timeout = this.options.idleTimeoutMs;
    const connection = this.connection;
    if (
      timeout === undefined ||
      !connection ||
      this.pending !== 0 ||
      this.closed
    )
      return;
    const idle = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.idle = undefined;
        this.connection = undefined;
        // Each new connection has its own client; it cannot race an old client's
        // asynchronous close event. The completed commands have no pending I/O.
        void connection
          .then((redis) => redis.disconnect())
          .then(resolve, () => {
            logWarn("redis.idle_cleanup.failed");
            resolve();
          });
      }, timeout);
      timer.unref();
      this.idle = { timer, resolve };
    });
    this.options.waitUntil?.(idle);
  }

  private async run<T>(operation: (redis: Redis) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("Redis client is closed");
    this.cancelIdle();
    this.pending += 1;
    try {
      const connection = (this.connection ??= this.open().catch(
        (error: unknown) => {
          this.connection = undefined;
          throw error;
        },
      ));
      return await operation(await connection);
    } finally {
      this.pending -= 1;
      this.scheduleIdle();
    }
  }

  async connect(): Promise<void> {
    await this.run((redis) => redis.ping());
  }

  get(key: string): Promise<string | null> {
    return this.run((redis) => redis.get(key));
  }

  async set(
    key: string,
    value: string,
    options: RedisSetOptions = {},
  ): Promise<boolean> {
    return this.run(async (redis) => {
      let result: string | null;
      if (options.nx && options.px !== undefined) {
        result = await redis.set(key, value, "PX", options.px, "NX");
      } else if (options.nx) {
        result = await redis.set(key, value, "NX");
      } else if (options.px !== undefined) {
        result = await redis.set(key, value, "PX", options.px);
      } else {
        result = await redis.set(key, value);
      }
      return result === "OK";
    });
  }

  del(key: string): Promise<number> {
    return this.run((redis) => redis.del(key));
  }

  hget(key: string, field: string): Promise<string | null> {
    return this.run((redis) => redis.hget(key, field));
  }

  hgetall(key: string): Promise<Record<string, string>> {
    return this.run((redis) => redis.hgetall(key));
  }

  async hset(key: string, fields: Record<string, string>): Promise<void> {
    if (Object.keys(fields).length === 0) return;
    await this.run((redis) => redis.hset(key, fields));
  }

  hdel(key: string, fields: readonly string[]): Promise<number> {
    if (fields.length === 0) return Promise.resolve(0);
    return this.run((redis) => redis.hdel(key, ...fields));
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    await this.run((redis) => redis.zadd(key, score, member));
  }

  async zscore(key: string, member: string): Promise<number | null> {
    const score = await this.run((redis) => redis.zscore(key, member));
    return score === null ? null : Number(score);
  }

  zrem(key: string, member: string): Promise<number> {
    return this.run((redis) => redis.zrem(key, member));
  }

  zrangebyscore(
    key: string,
    max: number,
    limit: number,
  ): Promise<readonly string[]> {
    return this.run((redis) =>
      redis.zrangebyscore(key, "-inf", max, "LIMIT", 0, limit),
    );
  }

  async multi(commands: readonly RedisWriteCommand[]): Promise<void> {
    if (commands.length === 0) return;
    await this.run(async (redis) => {
      const pipeline = redis.multi();
      for (const command of commands) {
        switch (command[0]) {
          case "set":
            pipeline.set(command[1], command[2]);
            break;
          case "del":
            pipeline.del(command[1]);
            break;
          case "hset":
            pipeline.hset(command[1], command[2], command[3]);
            break;
          case "hdel":
            pipeline.hdel(command[1], command[2]);
            break;
          case "zadd":
            pipeline.zadd(command[1], command[2], command[3]);
            break;
          case "zrem":
            pipeline.zrem(command[1], command[2]);
            break;
        }
      }
      const results = await pipeline.exec();
      const failure = results?.find(([error]) => error)?.[0];
      if (failure) throw failure;
      if (results === null) throw new Error("Redis transaction was aborted");
    });
  }

  async deleteIfEquals(key: string, expected: string): Promise<boolean> {
    const removed = await this.run((redis) =>
      redis.eval(RELEASE_SCRIPT, 1, key, expected),
    );
    return Number(removed) > 0;
  }

  async quit(): Promise<void> {
    this.closed = true;
    this.cancelIdle();
    const connection = this.connection;
    this.connection = undefined;
    if (!connection) return;
    const redis = await connection;
    try {
      await redis.quit();
    } finally {
      redis.disconnect();
    }
  }

  async expireIfEquals(
    key: string,
    expected: string,
    ttlMs: number,
  ): Promise<boolean> {
    return (
      Number(
        await this.run((redis) =>
          redis.eval(
            'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) end return 0',
            1,
            key,
            expected,
            ttlMs,
          ),
        ),
      ) > 0
    );
  }
}

export async function connectRedis(
  url: string,
  options: RedisConnectionOptions = {},
): Promise<IoRedisClient> {
  const { default: Redis } = await import("ioredis");
  const client = new IoRedisClient(async () => {
    const redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true,
      connectTimeout: 5_000,
      commandTimeout: 5_000,
    });
    redis.on("error", () => logWarn("redis.connection.failed"));
    try {
      await redis.connect();
      return redis;
    } catch (error) {
      redis.disconnect();
      throw error;
    }
  }, options);
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.quit();
    throw error;
  }
}
