import type {
  AccountHealth,
  QuotaSnapshot,
} from "../../../../src/providers/oauth/schema";
import { antigravityVariant } from "../../../../src/shared/antigravity-models";

export function quotaModelGroups(
  groups: QuotaSnapshot["groups"],
): QuotaSnapshot["groups"] {
  const result = new Map<string, QuotaSnapshot["groups"][number]>();
  for (const group of groups) {
    const variant = antigravityVariant(group.model ?? group.id);
    const id = variant?.family ?? group.id;
    const entry = result.get(id) ?? {
      ...group,
      id,
      label: variant ? id : group.label,
      buckets: [],
    };
    entry.buckets.push(
      ...group.buckets.map((bucket) => ({
        ...bucket,
        id: `${group.id}:${bucket.id}`,
        label: variant
          ? `${variant.level.charAt(0).toUpperCase()}${variant.level.slice(1)}`
          : bucket.label,
      })),
    );
    result.set(id, entry);
  }
  return [...result.values()];
}

export function cooldownModelGroups(
  blocks: NonNullable<AccountHealth["model_cooldowns"]>,
) {
  const result = new Map<
    string,
    {
      model: string;
      label: string;
      blocks: ((typeof blocks)[number] & { label: string })[];
    }
  >();
  for (const block of blocks) {
    const variant = antigravityVariant(block.model);
    const model = variant?.family ?? block.model;
    const entry = result.get(model) ?? {
      model,
      label: model,
      blocks: [],
    };
    entry.blocks.push({ ...block, label: variant?.level ?? "" });
    result.set(model, entry);
  }
  return [...result.values()];
}
