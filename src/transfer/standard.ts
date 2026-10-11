import type { SqlDatabase } from "../platform/bindings.ts";
import {
  AlarmState,
  BackedObjectStorage,
} from "../platform/standard/objects.ts";
import { SqlObjectBackend } from "../platform/standard/sql-objects.ts";
import {
  readObjectStorage,
  writeObjectStorage,
  type TransferObjects,
} from "./objects.ts";
import type { ObjectRef } from "./protocol.ts";

export function standardTransferObjects(db: SqlDatabase): TransferObjects {
  const backend = new SqlObjectBackend(db);
  const storage = (ref: ObjectRef) =>
    new BackedObjectStorage(
      backend,
      ref.kind,
      ref.name,
      new AlarmState(backend, ref.kind, ref.name),
    );
  return {
    async countUnmapped(refs) {
      const expected = new Set(refs.map((ref) => `${ref.kind}:${ref.name}`));
      const stored = (
        await db
          .prepare(
            "SELECT namespace, object_name FROM object_storage WHERE namespace = 'oauth' UNION SELECT namespace, object_name FROM object_alarms WHERE namespace = 'oauth'",
          )
          .all<{ namespace: string; object_name: string }>()
      ).results;
      const counts = new Map<string, number>();
      for (const row of stored)
        if (!expected.has(`${row.namespace}:${row.object_name}`))
          counts.set(row.namespace, (counts.get(row.namespace) ?? 0) + 1);
      return Object.fromEntries(counts);
    },
    read: (ref) => readObjectStorage(storage(ref), ref),
    write: (snapshot, digest) =>
      writeObjectStorage(storage(snapshot.ref), snapshot, digest),
    schedule: (ref, alarm) =>
      alarm === null
        ? storage(ref).deleteAlarm()
        : storage(ref).setAlarm(Math.max(Date.now() + 1000, alarm)),
    async empty() {
      return !(await db
        .prepare(
          "SELECT 1 AS present FROM object_storage WHERE namespace = 'oauth' UNION ALL SELECT 1 AS present FROM object_alarms WHERE namespace = 'oauth' LIMIT 1",
        )
        .first());
    },
  };
}
