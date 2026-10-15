import { ProviderType } from "../../config/values.ts";
import type { AccountState } from "../oauth/provider.ts";
import {
  type ClaudeClient,
  parseModels,
  parseUsage as parseClaudeUsage,
} from "./api.ts";
import { claudeCredentialSchema } from "./account-schema.ts";
import { mergeClaudeQuotaGroups } from "./limits.ts";

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
      let { groups, extra_usage } = usage;
      const sync = account.claude_quota_sync;
      sync.windows = sync.windows.filter(
        (window) => window.revision > revision,
      );
      const observed = new Set(sync.windows.map((window) => window.group_id));
      groups = mergeClaudeQuotaGroups(
        groups,
        account.quota.groups.filter((group) => observed.has(group.id)),
      ).groups;
      if (sync.extra_usage && sync.extra_usage.revision <= revision)
        sync.extra_usage = null;
      if (extra_usage && sync.extra_usage)
        extra_usage = {
          ...extra_usage,
          disabled_reason: sync.extra_usage.disabled_reason,
        };
      account.quota = {
        ...account.quota,
        groups,
        extra_usage,
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
