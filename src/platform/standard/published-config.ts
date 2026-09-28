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
 * no-ops. Public metadata has its own Redis namespace and never replaces SQL configuration.
 */
export class PublishedConfigSnapshot implements KeyValueStore {
  private readonly store: ControlStore;

  constructor(
    db: SqlDatabase,
    encryptionKey: string,
    private readonly configKey: string,
    private readonly metadata: KeyValueStore = DETACHED,
  ) {
    this.store = new ControlStore(db, DETACHED, encryptionKey, configKey);
  }

  async get(key: string): Promise<string | null> {
    if (key !== this.configKey)
      return key.startsWith("metadata:") ? this.metadata.get(key) : null;
    const state = await this.store.state();
    if (state.published_revision === null) return null;
    return JSON.stringify(await this.store.revision(state.published_revision));
  }

  async put(key: string, value: string): Promise<void> {
    if (key !== this.configKey && key.startsWith("metadata:"))
      await this.metadata.put(key, value);
  }

  async delete(key: string): Promise<void> {
    if (key !== this.configKey && key.startsWith("metadata:"))
      await this.metadata.delete(key);
  }
}
