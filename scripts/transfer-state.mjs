import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve, join } from "node:path";
import { z } from "zod";
import { transferStateSchema } from "../src/transfer/runner.ts";
import { TransferError } from "../src/transfer/protocol.ts";

/** The state file contains cursors/digests/schedules, never rows or credentials. */
export async function openState(directory, id, initial) {
  if (!z.uuid().safeParse(id).success)
    throw new TransferError("Invalid task ID");
  const folder = resolve(directory);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const filename = join(folder, `${id}.json`),
    lockname = `${filename}.lock`;
  for (;;) {
    try {
      const lock = await open(lockname, "wx", 0o600);
      try {
        await lock.writeFile(
          JSON.stringify({ host: hostname(), pid: process.pid }),
        );
        await lock.sync();
      } finally {
        await lock.close();
      }
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = JSON.parse(await readFile(lockname, "utf8"));
      if (owner.host !== hostname() || !Number.isInteger(owner.pid))
        throw new TransferError("State file is locked on another host");
      try {
        process.kill(owner.pid, 0);
        throw new TransferError("Another CLI process owns this task");
      } catch (probe) {
        if (probe.code !== "ESRCH") throw probe;
      }
      await unlink(lockname);
    }
  }
  let state;
  try {
    try {
      state = transferStateSchema.parse(
        JSON.parse(await readFile(filename, "utf8")),
      );
    } catch (error) {
      if (error.code !== "ENOENT" || !initial) throw error;
      state = transferStateSchema.parse(initial);
    }
    if (state.id !== id)
      throw new TransferError("Local state has a different task ID");
  } catch {
    await unlink(lockname);
    throw new TransferError(
      "Local state is missing or invalid (including retired transfer formats); start a new task with a fresh target",
    );
  }
  return {
    state,
    filename,
    async save() {
      const contents =
        JSON.stringify(transferStateSchema.parse(this.state), null, 2) + "\n";
      const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(contents);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, filename);
      const parent = await open(folder, "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    },
    async close() {
      await unlink(lockname);
    },
  };
}
