import { quotaIsStale, safeError } from "./state.ts";
import type { AccountMetadata, AccountState } from "./provider.ts";

interface InventoryState extends Pick<AccountState, "current" | "update"> {
  refresh(
    kind: "models" | "quota",
    generation: number,
    run: () => Promise<void>,
  ): Promise<void>;
}

/** Shared freshness, single-flight refresh and fenced error reporting. */
export class AccountInventory {
  constructor(
    private readonly state: InventoryState,
    private readonly metadata: () => AccountMetadata,
  ) {}
  refreshModels(): Promise<void> {
    const generation = this.state.current().generation;
    return this.state.refresh("models", generation, async () => {
      const inventory = this.metadata();
      try {
        const models = await inventory.models();
        await this.state.update(generation, (account) => {
          account.models = models;
          account.models_updated_at = Date.now();
          account.models_error = null;
          delete account.models_verification;
        });
      } catch (error) {
        if (this.state.current().generation === generation)
          await this.state.update(generation, (account) => {
            account.models_error = safeError(error);
            account.models_verification = inventory.verification?.(error);
          });
      }
    });
  }
  async refreshQuota(force: boolean): Promise<void> {
    if (!force && !quotaIsStale(this.state.current())) return;
    const generation = this.state.current().generation;
    await this.state.refresh("quota", generation, async () => {
      try {
        await this.metadata().quota(generation);
      } catch (error) {
        if (this.state.current().generation === generation)
          await this.state.update(generation, (account) => {
            account.quota.last_error = safeError(error);
            delete account.quota.verification;
          });
      }
    });
  }
}
