import { ProviderType } from "../../config/values.ts";
import type { AccountState } from "../oauth/provider.ts";
import {
  type ClaudeClient,
  parseModels,
  parseUsage as parseClaudeUsage,
} from "./api.ts";
import { claudeCredentialSchema } from "./account-schema.ts";

export class ClaudeInventory {
  constructor(
    private readonly state: AccountState<typeof ProviderType.Claude>,
    private readonly client: () => Promise<
      Pick<ClaudeClient, "models" | "usage">
    >,
  ) {}
  async models() {
    const token = claudeCredentialSchema.parse(await this.state.resolve());
    return parseModels(await (await this.client()).models(token.token));
  }
  async quota(generation: number): Promise<void> {
    const token = claudeCredentialSchema.parse(await this.state.resolve());
    const revision = this.state.current().claude_quota_revision;
    const usage = parseClaudeUsage(
      await (await this.client()).usage(token.token),
    );
    await this.state.update(generation, (account) => {
      if (account.claude_quota_revision !== revision) return;
      account.quota = {
        ...account.quota,
        ...usage,
        updated_at: Date.now(),
        last_error: null,
        stale: false,
        subscription: {
          tier_id: account.claude?.subscription_type ?? null,
          tier_name: account.claude?.rate_limit_tier ?? null,
          credits: [],
        },
      };
    });
  }
}
