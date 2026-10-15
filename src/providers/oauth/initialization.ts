import { OAuthSessionStatus, OAuthAccountStatus } from "./values.ts";
import { emptyQuota, type Stored, type Session } from "./state.ts";

/** Called only within the account core's generation-fenced commit. */
export function completeAuthorization(account: Stored, pending: Session): void {
  account.connection = pending.connection;
  account.status = OAuthAccountStatus.Ready;
  account.error = null;
  account.generation++;
  account.authorization_generation++;
  account.quota = emptyQuota();
  account.models_error = null;
  pending.status = OAuthSessionStatus.Complete;
  pending.tokens = null;
  pending.state = "";
  pending.verifier = "";
}
