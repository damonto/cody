import { ControlStore } from "../control/store.ts";
import type { Bindings } from "../platform/bindings.ts";

export type AdminContext = { Bindings: Bindings; Variables: { actor: string } };
export function controlStore(env: Bindings): ControlStore {
  return new ControlStore(
    env.CODY_DB,
    env.CODY_CONFIG_KV,
    env.CONFIG_ENCRYPTION_KEY,
    env.CONFIG_KEY,
  );
}
export async function publishedConfig(env: Bindings) {
  const store = controlStore(env);
  const state = await store.state();
  return state.published_revision
    ? store.revision(state.published_revision)
    : null;
}
