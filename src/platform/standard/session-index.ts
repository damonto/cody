/**
 * Session affinity index over object storage. Entries are keyed by session
 * digest, so `list` order gives the same keyset pagination as the SQL table
 * used by the Cloudflare Durable Object.
 */
import { SESSION_AFFINITY_INDEX_MAX_PAGE_SIZE } from "../../gateway/routing/affinity.ts";
import type {
  SessionAffinityIndexEntry,
  SessionAffinityIndexObject,
  SessionAffinityIndexPage,
} from "../bindings.ts";
import type { ObjectContext } from "../object-context.ts";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function validateEntry(entry: SessionAffinityIndexEntry): void {
  if (
    typeof entry !== "object" ||
    entry === null ||
    typeof entry.session_digest !== "string" ||
    !DIGEST_PATTERN.test(entry.session_digest) ||
    typeof entry.session_id !== "string" ||
    entry.session_id.trim() === "" ||
    typeof entry.binding_id !== "string" ||
    entry.binding_id.trim() === "" ||
    !Number.isSafeInteger(entry.created_at) ||
    entry.created_at < 0 ||
    !Number.isSafeInteger(entry.generation) ||
    entry.generation < 1
  ) {
    throw new TypeError("invalid session affinity index entry");
  }
}

export class SessionAffinityIndexCore implements SessionAffinityIndexObject {
  constructor(private readonly ctx: ObjectContext) {}

  async register(
    entry: SessionAffinityIndexEntry,
  ): Promise<SessionAffinityIndexEntry> {
    validateEntry(entry);
    return this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<SessionAffinityIndexEntry>(
        entry.session_digest,
      );
      if (
        current === undefined ||
        entry.generation > current.generation ||
        (entry.generation === current.generation &&
          entry.binding_id === current.binding_id)
      ) {
        const stored: SessionAffinityIndexEntry = {
          session_digest: entry.session_digest,
          session_id: entry.session_id,
          binding_id: entry.binding_id,
          created_at: entry.created_at,
          generation: entry.generation,
        };
        await transaction.put(entry.session_digest, stored);
        return stored;
      }
      return current;
    });
  }

  async get(sessionDigest: string): Promise<SessionAffinityIndexEntry | null> {
    if (
      typeof sessionDigest !== "string" ||
      !DIGEST_PATTERN.test(sessionDigest)
    ) {
      return null;
    }
    return (
      (await this.ctx.storage.get<SessionAffinityIndexEntry>(sessionDigest)) ??
      null
    );
  }

  async listPage(
    cursor: string | null,
    limit: number,
  ): Promise<SessionAffinityIndexPage> {
    if (
      (cursor !== null &&
        (typeof cursor !== "string" || !DIGEST_PATTERN.test(cursor))) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > SESSION_AFFINITY_INDEX_MAX_PAGE_SIZE
    ) {
      throw new TypeError("invalid session affinity page request");
    }
    const rows = [
      ...(
        await this.ctx.storage.list<SessionAffinityIndexEntry>({
          limit: limit + 1,
          ...(cursor === null ? {} : { startAfter: cursor }),
        })
      ).values(),
    ];
    const data = rows.slice(0, limit);
    const last = data.at(-1);
    return {
      data,
      next_cursor: rows.length > limit && last ? last.session_digest : null,
    };
  }

  async remove(
    sessionDigest: string,
    bindingId: string,
    generation: number,
  ): Promise<boolean> {
    if (
      typeof sessionDigest !== "string" ||
      !DIGEST_PATTERN.test(sessionDigest) ||
      typeof bindingId !== "string" ||
      bindingId.trim() === "" ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    ) {
      return false;
    }
    return this.ctx.storage.transaction(async (transaction) => {
      const current =
        await transaction.get<SessionAffinityIndexEntry>(sessionDigest);
      if (
        !current ||
        current.binding_id !== bindingId ||
        current.generation !== generation
      ) {
        return false;
      }
      await transaction.delete(sessionDigest);
      return true;
    });
  }
}
