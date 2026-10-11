import { z } from "zod";
import {
  TABLES,
  PAGE_SIZE,
  TABLE_KEYS,
  objectRefSchema,
  canonical,
  hash,
  TransferError,
  type TransferTable,
  type TransferEndpoint,
  type TransferResult,
  type ObjectRef,
} from "./protocol.ts";

export const transferStateSchema = z
  .strictObject({
    format: z.literal(2),
    id: z.uuid(),
    source: z.string(),
    target: z.string(),
    schema: z.string(),
    phase: z.enum([
      "prepared",
      "pausing",
      "tables",
      "objects",
      "verifying",
      "activating",
      "completed",
      "aborting",
      "aborted",
    ]),
    page_size: z.number().int().min(1).max(PAGE_SIZE),
    import_digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .default(null),
    table: z.number().int().min(0).max(TABLES.length),
    cursor: z.array(z.union([z.string(), z.number()])).nullable(),
    intent: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    object: z.number().int().nonnegative(),
    objects: z.array(objectRefSchema),
    alarms: z.record(z.string(), z.number().int().nonnegative().nullable()),
  })
  .refine(
    (state) => state.object <= state.objects.length,
    "Invalid object cursor",
  )
  .refine(
    (state) =>
      !state.cursor ||
      (state.table < TABLES.length &&
        state.cursor.length === TABLE_KEYS[TABLES[state.table]].length),
    "Invalid table cursor",
  );
export type TransferState = z.infer<typeof transferStateSchema>;
export interface TransferJournal {
  state: TransferState;
  save(): Promise<void>;
}

export function newState(
  id: string,
  source: string,
  target: string,
  schema: string,
): TransferState {
  return {
    format: 2,
    id,
    source,
    target,
    schema,
    phase: "prepared",
    page_size: PAGE_SIZE,
    import_digest: null,
    table: 0,
    cursor: null,
    intent: null,
    object: 0,
    objects: [],
    alarms: {},
  };
}
const refKey = (ref: ObjectRef) => `${ref.kind}:${ref.name}`;

export async function tableDigest(
  endpoint: TransferEndpoint,
  table: TransferTable,
) {
  let cursor: TransferState["cursor"] = null;
  let chain = "",
    count = 0;
  do {
    const page: TransferResult<"read"> = await endpoint.call({
      action: "read",
      table,
      cursor,
    });
    chain = await hash([chain, page.rows]);
    count += page.rows.length;
    cursor = page.next_cursor;
  } while (cursor !== null);
  return { count, digest: await hash([chain, count]) };
}

/** All remote writes are replayable; fsync the intent before sending each batch. */
export async function transferInstances(
  source: TransferEndpoint,
  target: TransferEndpoint,
  journal: TransferJournal,
  onProgress: (message: string) => void = () => {},
) {
  const state = journal.state;
  const phase = async (value: TransferState["phase"]) => {
    state.phase = value;
    await journal.save();
  };
  const reportSkippedObjects = (inventory: TransferResult<"inventory">) => {
    if (inventory.orphaned_oauth.length)
      onProgress(
        `Ignoring ${inventory.orphaned_oauth.length} stale OAuth index reference(s) without a provider or credential/history references (best effort)`,
      );
    for (const [binding, count] of Object.entries(inventory.skipped))
      onProgress(
        `Skipping ${count} unmapped persistent object(s) in ${binding} (best effort)`,
      );
  };
  if (state.phase === "aborting")
    throw new TransferError(
      "Abort has started; use --abort to finish restoring the source",
    );
  if (state.phase === "aborted")
    throw new TransferError(
      "This task was aborted; discard its target before starting again",
    );
  if (state.phase === "completed") return;
  let inventory: TransferResult<"inventory"> | undefined;
  if (state.phase === "prepared") {
    await target.call({ action: "prepare" });
    inventory = await source.call({ action: "inventory" });
    state.objects = inventory.objects;
    reportSkippedObjects(inventory);
    await phase("pausing");
  }
  if (state.phase === "pausing") {
    if (!inventory) {
      inventory = await source.call({ action: "inventory" });
      if (canonical(state.objects) !== canonical(inventory.objects))
        throw new TransferError(
          "Source object inventory changed during transfer",
        );
      reportSkippedObjects(inventory);
    }
    for (const ref of state.objects) {
      const key = refKey(ref);
      if (!(key in state.alarms)) {
        state.alarms[key] = (
          await source.call({ action: "read_object", ref })
        ).snapshot.alarm;
        await journal.save();
      }
      await source.call({ action: "schedule", ref, alarm: null });
    }
    await phase("tables");
  }
  const databaseSource = ["tables", "objects", "verifying"].includes(
    state.phase,
  )
    ? ((await source.databaseSnapshot?.(onProgress)) ?? source)
    : source;
  if (state.phase === "tables" && target.importDatabase) {
    await target.importDatabase(
      databaseSource,
      async (digest) => {
        if (state.import_digest && state.import_digest !== digest)
          throw new TransferError(
            "Source changed since the interrupted import; stop the task",
          );
        state.import_digest = digest;
        await journal.save();
      },
      onProgress,
    );
    state.intent = null;
    state.cursor = null;
    state.table = TABLES.length;
    await phase("objects");
  }
  if (state.phase === "tables") {
    while (state.table < TABLES.length) {
      const table = TABLES[state.table],
        cursor = state.cursor;
      if (!state.intent) state.page_size = PAGE_SIZE;
      const page = await databaseSource.call({
        action: "read",
        table,
        cursor,
        limit: state.page_size,
      });
      if (state.intent && state.intent !== page.digest)
        throw new TransferError(
          "Source changed since the interrupted batch; stop the task",
        );
      state.intent = page.digest;
      await journal.save();
      await target.call({ action: "write", table, cursor, ...page });
      state.intent = null;
      state.cursor = page.next_cursor;
      if (state.cursor === null) {
        state.table++;
        onProgress(`${table}: copied`);
      }
      await journal.save();
      onProgress(`${table}: copied a batch of ${page.rows.length} rows`);
    }
    await phase("objects");
  }
  if (state.phase === "objects") {
    while (state.object < state.objects.length) {
      const ref = state.objects[state.object];
      const value = await source.call({ action: "read_object", ref });
      if (state.intent && state.intent !== value.digest)
        throw new TransferError("Object changed since the interrupted batch");
      state.intent = value.digest;
      await journal.save();
      await target.call({ action: "write_object", ...value });
      state.intent = null;
      state.object++;
      await journal.save();
    }
    await phase("verifying");
  }
  if (state.phase === "verifying") {
    await target.call({ action: "validate" });
    const inventory = await source.call({ action: "inventory" });
    if (canonical(inventory.objects) !== canonical(state.objects))
      throw new TransferError(
        "Source object inventory changed during transfer",
      );
    reportSkippedObjects(inventory);
    const databaseTarget =
      (await target.databaseSnapshot?.(onProgress)) ?? target;
    for (const table of TABLES) {
      const before = await tableDigest(databaseSource, table),
        after = await tableDigest(databaseTarget, table);
      if (canonical(before) !== canonical(after))
        throw new TransferError(`Verification failed: ${table}`);
      onProgress(`${table}: verified ${before.count} rows`);
    }
    for (const ref of state.objects) {
      const before = await source.call({ action: "read_object", ref }),
        after = await target.call({ action: "read_object", ref });
      if (before.digest !== after.digest)
        throw new TransferError("Object verification failed");
    }
    // Persist before enabling the first alarm, so an ACK loss cannot allow abort.
    await phase("activating");
  }
  if (state.phase === "activating") {
    for (const ref of state.objects) {
      await target.call({
        action: "schedule",
        ref,
        alarm: state.alarms[refKey(ref)] ?? null,
      });
    }
    await phase("completed");
  }
}

export async function abortTransfer(
  source: TransferEndpoint,
  target: TransferEndpoint,
  journal: TransferJournal,
) {
  const state = journal.state;
  if (state.phase === "aborted") return;
  if (["activating", "completed"].includes(state.phase))
    throw new TransferError(
      "Target scheduling has been enabled; do not restart the old source",
    );
  // Persist the decision before restarting any source alarm. An interrupted
  // abort must never be resumed as a forward transfer.
  state.phase = "aborting";
  await journal.save();
  for (const ref of state.objects) {
    if (!(refKey(ref) in state.alarms)) continue;
    await target.call({ action: "schedule", ref, alarm: null });
    await source.call({
      action: "schedule",
      ref,
      alarm: state.alarms[refKey(ref)],
    });
  }
  state.phase = "aborted";
  await journal.save();
}
