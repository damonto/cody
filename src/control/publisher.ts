import { ZodError } from "zod";
import { validationMessage } from "../billing/schema.ts";
import { ConfigError } from "../config/store.ts";
import type { Bindings } from "../platform/bindings.ts";
import type { ObjectContext } from "../platform/object-context.ts";
import {
  ControlConflict,
  ControlInputError,
  ControlStore,
  type DraftView,
} from "./store.ts";

import type { PublisherReply } from "./schema.ts";
export type { PublisherReply } from "./schema.ts";

/** Serializes control-plane writes only; inference never calls this object. */
export class ConfigPublisherCore {
  private mutations: Promise<unknown> = Promise.resolve();

  constructor(
    protected readonly ctx: ObjectContext,
    protected readonly env: Bindings,
  ) {
    // The runtime waits for initialization and resets the object if it fails.
    void ctx.blockConcurrencyWhile(async () => {
      await ctx.storage.transaction(async (transaction) => {
        if (
          (await transaction.get("pending_revision")) !== undefined &&
          (await transaction.getAlarm()) === null
        ) {
          await transaction.setAlarm(Date.now() + 10_000);
        }
      });
    });
  }

  private async stage(revision: number): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      await transaction.put("pending_revision", revision);
      await transaction.setAlarm(Date.now() + 10_000);
    });
  }
  private store(): ControlStore {
    return new ControlStore(
      this.env.CODY_DB,
      this.env.CODY_CONFIG_KV,
      this.env.CONFIG_ENCRYPTION_KEY,
      this.env.CONFIG_KEY,
    );
  }

  private async reply(operation: () => Promise<DraftView>): Promise<string> {
    try {
      return JSON.stringify({
        ok: true,
        data: await operation(),
      } satisfies PublisherReply);
    } catch (error) {
      if (error instanceof ControlConflict)
        return JSON.stringify({
          ok: false,
          status: 409,
          error: error.message,
        } satisfies PublisherReply);
      if (
        error instanceof ConfigError ||
        error instanceof ControlInputError ||
        error instanceof ZodError
      ) {
        return JSON.stringify({
          ok: false,
          status: 400,
          error:
            error instanceof ZodError
              ? validationMessage(error)
              : error.message,
        } satisfies PublisherReply);
      }
      throw error;
    }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.mutations.then(operation);
    this.mutations = task.catch(() => {});
    return task;
  }
  private async recover(): Promise<void> {
    const pending = await this.ctx.storage.get<number>("pending_revision");
    if (pending === undefined) return;
    await this.ctx.storage.setAlarm(Date.now() + 10_000);
    await this.store().publishRevision(pending);
    await this.ctx.storage.transaction(async (transaction) => {
      await transaction.delete("pending_revision");
      await transaction.deleteAlarm();
    });
  }
  getDraft(): Promise<string> {
    return this.reply(() => this.store().view());
  }
  saveDraft(config: string, version: number, actor: string): Promise<string> {
    return this.reply(() =>
      this.serial(async () => {
        await this.recover();
        return this.store().save(JSON.parse(config) as unknown, version, actor);
      }),
    );
  }
  publish(version: number, actor: string): Promise<string> {
    return this.reply(() =>
      this.serial(async () => {
        await this.recover();
        const revision = await this.store().createRevision(version, actor);
        await this.stage(revision);
        await this.recover();
        return this.store().view();
      }),
    );
  }
  rollback(revision: number, version: number, actor: string): Promise<string> {
    return this.reply(() =>
      this.serial(async () => {
        await this.recover();
        const config = await this.store().revision(revision);
        const saved = await this.store().save(config, version, actor);
        const next = await this.store().createRevision(
          saved.version,
          actor,
          revision,
        );
        await this.stage(next);
        await this.recover();
        return this.store().view();
      }),
    );
  }
  alarm(): Promise<void> {
    return this.serial(() => this.recover());
  }
}
