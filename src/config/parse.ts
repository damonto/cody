import { configurationError, configurationSchema } from "./schema.ts";
import type { GatewayConfig } from "./types.ts";

export class ConfigError extends Error {
  override name = "ConfigError";
}
export function parseConfig(value: unknown): GatewayConfig {
  const result = configurationSchema.safeParse(value);
  if (!result.success) throw new ConfigError(configurationError(result.error));
  return result.data;
}
