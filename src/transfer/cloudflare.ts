import type { TransferObjects } from "./objects.ts";
import { TransferError } from "./protocol.ts";

export function cloudflareTransferObjects(env: Env): TransferObjects {
  const account = (ref: { kind: string; name: string }) => {
    if (ref.kind !== "oauth")
      throw new TransferError("Only OAuth objects are transferred");
    return env.PROVIDER_OAUTH_ACCOUNT.getByName(ref.name);
  };
  return {
    async ids(refs) {
      return refs.map((ref) =>
        env.PROVIDER_OAUTH_ACCOUNT.idFromName(ref.name).toString(),
      );
    },
    read: (ref) => account(ref).transferRead(ref),
    write: (snapshot, digest) =>
      account(snapshot.ref).transferWrite(snapshot, digest),
    schedule: (ref, alarm) => account(ref).transferSchedule(alarm),
    // The CLI checks the target OAuth namespace through the account API.
    async empty() {
      return true;
    },
  };
}
