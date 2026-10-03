import { ControlStore } from "../control/store.ts";
import type { Bindings } from "../platform/bindings.ts";

export type AdminContext = { Bindings: Bindings; Variables: { actor: string } };
export function controlStore(env: Bindings): ControlStore {
  return new ControlStore(env.CODY_DB, env.CONFIG_ENCRYPTION_KEY);
}
export async function currentConfig(env: Bindings) {
  const store = controlStore(env);
  const state = await store.state();
  return state.version ? store.revision(state.version) : null;
}
