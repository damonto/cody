import { ControlStore } from "../control/store.ts";

export type AdminContext = { Bindings: Env; Variables: { actor: string } };
export function controlStore(env: Env): ControlStore {
  return new ControlStore(
    env.CODY_DB,
    env.CODY_CONFIG_KV,
    env.CONFIG_ENCRYPTION_KEY,
    env.CONFIG_KEY,
  );
}
export async function publishedConfig(env: Env) {
  const store = controlStore(env);
  const state = await store.state();
  return state.published_revision
    ? store.revision(state.published_revision)
    : null;
}
