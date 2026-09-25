import type { Bindings } from "../platform/bindings.ts";

export async function audit(
  env: Pick<Bindings, "CODY_DB">,
  actor: string,
  action: string,
): Promise<void> {
  await env.CODY_DB.prepare(
    "INSERT INTO audit_log (id, created_at, actor, action) VALUES (?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), Date.now(), actor, action)
    .run();
}
