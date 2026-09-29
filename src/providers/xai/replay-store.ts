import { z } from "zod";
import type { ObjectStorage } from "../../platform/object-context.ts";

const TTL = 60 * 60 * 1000;
const CHUNK_SIZE = 64 * 1024;
const metaSchema = z.object({
  version: z.string(),
  expires: z.number(),
  chunks: z.number().int().min(0).max(64),
});
export interface XaiReplaySnapshot {
  version: string;
  value: string | null;
}

/** Used at dedicated xai-replay:* object addresses; no account or affinity state is shared. */
export class XaiReplayStore {
  constructor(private readonly storage: ObjectStorage) {}
  begin(): Promise<XaiReplaySnapshot> {
    return this.storage.transaction(async (tx) => {
      const raw = await tx.get("xai_replay");
      const previous = raw === undefined ? undefined : metaSchema.parse(raw);
      const alive = previous && previous.expires > Date.now();
      const parts: string[] = [];
      for (let i = 0; i < (previous?.chunks ?? 0); i++) {
        if (alive)
          parts.push(z.string().parse(await tx.get(`xai_replay:${i}`)));
        else await tx.delete(`xai_replay:${i}`);
      }
      const version = crypto.randomUUID();
      const expires = Date.now() + TTL;
      await tx.put("xai_replay", {
        version,
        expires,
        chunks: alive ? previous.chunks : 0,
      });
      await tx.setAlarm(expires);
      return { version, value: parts.length ? parts.join("") : null };
    });
  }
  commit(version: string, value: string | null): Promise<boolean> {
    z.string().uuid().parse(version);
    z.string()
      .max(CHUNK_SIZE * 64)
      .nullable()
      .parse(value);
    return this.storage.transaction(async (tx) => {
      const raw = await tx.get("xai_replay");
      if (raw === undefined) return false;
      const previous = metaSchema.parse(raw);
      if (previous.version !== version || previous.expires <= Date.now())
        return false;
      const chunks = value === null ? 0 : Math.ceil(value.length / CHUNK_SIZE);
      for (let i = 0; i < Math.max(previous.chunks, chunks); i++) {
        if (value !== null && i < chunks)
          await tx.put(
            `xai_replay:${i}`,
            value.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
          );
        else await tx.delete(`xai_replay:${i}`);
      }
      const expires = Date.now() + TTL;
      await tx.put("xai_replay", { version, expires, chunks });
      await tx.setAlarm(expires);
      return true;
    });
  }
  alarm(): Promise<boolean> {
    return this.storage.transaction(async (tx) => {
      const raw = await tx.get("xai_replay");
      if (raw === undefined) return false;
      const meta = metaSchema.parse(raw);
      if (meta.expires > Date.now()) {
        await tx.setAlarm(meta.expires);
        return true;
      }
      for (let i = 0; i < meta.chunks; i++) await tx.delete(`xai_replay:${i}`);
      await tx.delete("xai_replay");
      await tx.deleteAlarm();
      return true;
    });
  }
}
