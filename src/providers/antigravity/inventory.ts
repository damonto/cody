import { ProviderType } from "../../config/values.ts";
import type { AccountState } from "../oauth/provider.ts";
import type { QuotaSnapshot } from "../oauth/schema.ts";
import { safeError } from "../oauth/state.ts";
import {
  type AntigravityClient,
  parseModels,
  parseQuota,
  parseSubscription,
} from "./api.ts";
import {
  AntigravityVerificationError,
  mergeVerification,
} from "./verification.ts";
import { antigravityCredentialSchema } from "./account-schema.ts";

export class AntigravityInventory {
  constructor(
    private readonly state: AccountState<typeof ProviderType.Antigravity>,
    private readonly client: () => Promise<
      Pick<AntigravityClient, "models" | "quota" | "load">
    >,
  ) {}
  async models() {
    const token = antigravityCredentialSchema.parse(await this.state.resolve());
    return parseModels(
      await (await this.client()).models(token.token, token.project_id),
    );
  }
  verification(error: unknown) {
    return error instanceof AntigravityVerificationError
      ? error.verification
      : undefined;
  }
  async quota(generation: number): Promise<void> {
    const token = antigravityCredentialSchema.parse(await this.state.resolve());
    let groups: QuotaSnapshot["groups"] | undefined;
    let subscription: QuotaSnapshot["subscription"] | undefined;
    const errors = new Set<string>();
    const verification: NonNullable<QuotaSnapshot["verification"]> = [];
    // Independent transports, serialized so a six-account batch has at most six requests in flight.
    // Preparation and parsing belong to each operation's failure boundary too.
    try {
      groups = parseQuota(
        await (await this.client()).quota(token.token, token.project_id),
      );
    } catch (error) {
      errors.add(safeError(error));
      if (error instanceof AntigravityVerificationError)
        verification.push(...error.verification);
    }
    try {
      subscription = parseSubscription(
        await (await this.client()).load(token.token),
      );
    } catch (error) {
      errors.add(safeError(error));
      if (error instanceof AntigravityVerificationError)
        verification.push(...error.verification);
    }
    await this.state.update(generation, (account) => {
      if (groups !== undefined) {
        account.quota.groups = groups;
        account.quota.updated_at = Date.now();
      }
      if (subscription !== undefined) account.quota.subscription = subscription;
      account.quota.last_error = [...errors].join(" ") || null;
      account.quota.verification = verification.length
        ? mergeVerification(verification)
        : undefined;
    });
  }
}
