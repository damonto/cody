import { ControlStore } from "../../control/store.ts";
import type { KeyValueStore, SqlDatabase } from "../bindings.ts";

const DETACHED: KeyValueStore = {
  get: async () => null,
  put: async () => {},
  delete: async () => {},
};

/**
 * The published configuration snapshot for the standard backend. SQL already
 * records the published revision in `control_state`, so the snapshot is read
 * from there (and cached per process by `loadConfig`); publication writes are
 * no-ops. Nothing can drift between a snapshot store and the control plane.
 */
export class PublishedConfigSnapshot implements KeyValueStore {
  private readonly store: ControlStore;

  constructor(
    db: SqlDatabase,
    encryptionKey: string,
    private readonly configKey: string,
  ) {
    this.store = new ControlStore(db, DETACHED, encryptionKey, configKey);
  }

  async get(key: string): Promise<string | null> {
    if (key !== this.configKey) return null;
    const state = await this.store.state();
    if (state.published_revision === null) return null;
    return JSON.stringify(await this.store.revision(state.published_revision));
  }

  async put(): Promise<void> {}

  async delete(): Promise<void> {}
}
