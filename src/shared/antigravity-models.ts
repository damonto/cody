import { ProviderType } from "../config/values.ts";

export const antigravityThinkingLevels = ["low", "medium", "high"] as const;
export type AntigravityThinkingLevel =
  (typeof antigravityThinkingLevels)[number];

interface AntigravityVariant {
  family: string;
  level: AntigravityThinkingLevel;
}

export function antigravityVariant(
  model: string,
): AntigravityVariant | undefined {
  const match = /^(gemini-.+)-(low|medium|high)$/.exec(model);
  if (!match || /-(?:low|medium|high)$/.test(match[1])) return undefined;
  const level = antigravityThinkingLevels.find((value) => value === match[2]);
  return level ? { family: match[1], level } : undefined;
}

export function antigravityFamilyModels(
  models: readonly string[],
  family: string,
): string[] {
  if (models.includes(family) || antigravityVariant(family)) return [];
  return antigravityThinkingLevels
    .map((level) => `${family}-${level}`)
    .filter(
      (model) =>
        models.includes(model) && antigravityVariant(model)?.family === family,
    );
}

export function antigravityModelGroups(
  models: readonly string[],
): Map<string, string[]> {
  const configured = new Set(models);
  const groups = new Map<string, string[]>();
  for (const model of configured) {
    const variant = antigravityVariant(model);
    const id =
      variant && !configured.has(variant.family) ? variant.family : model;
    const group = groups.get(id) ?? [];
    group.push(model);
    groups.set(id, group);
  }
  for (const [id, variants] of groups) {
    if (!configured.has(id))
      groups.set(id, antigravityFamilyModels(variants, id));
  }
  return groups;
}

interface ProviderModels {
  readonly type: ProviderType;
  readonly models: readonly string[];
}

export function providerModelNames(provider: ProviderModels): string[] {
  return provider.type === ProviderType.Antigravity
    ? [
        ...new Set([
          ...antigravityModelGroups(provider.models).keys(),
          ...provider.models,
        ]),
      ]
    : [...provider.models];
}

export function supportsProviderModel(
  provider: ProviderModels,
  model: string,
): boolean {
  return (
    provider.models.includes(model) ||
    (provider.type === ProviderType.Antigravity &&
      antigravityFamilyModels(provider.models, model).length > 0)
  );
}

/** Public model choices never expose physical thinking variants. */
export function publicProviderModels(provider: ProviderModels): string[] {
  return provider.type === ProviderType.Antigravity
    ? [...antigravityModelGroups(provider.models).keys()]
    : [...provider.models];
}

export function publicProviderModel(
  provider: ProviderModels,
  model: string,
): string {
  const variant =
    provider.type === ProviderType.Antigravity
      ? antigravityVariant(model)
      : undefined;
  return variant && !provider.models.includes(variant.family)
    ? variant.family
    : model;
}
