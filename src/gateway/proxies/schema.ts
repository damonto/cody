import { z } from "zod";
import { identifierSchema, proxyStrategySchema } from "../../config/schema.ts";

const timestamp = z.number().int().nonnegative();
export const proxyOwnerSchema = z.strictObject({
  provider_id: identifierSchema,
  credential_id: identifierSchema.optional(),
});
export type ProxyOwner = z.output<typeof proxyOwnerSchema>;

// Connection fingerprints identify changed endpoints/auth without storing secrets in the DO.
export const proxyGroupSnapshotSchema = z.strictObject({
  id: identifierSchema,
  revision: timestamp,
  strategy: proxyStrategySchema,
  proxies: z
    .array(
      z.strictObject({
        id: identifierSchema,
        priority: z.number().int(),
        disabled: z.boolean(),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .refine(
      (nodes) => new Set(nodes.map((node) => node.id)).size === nodes.length,
      "Proxy IDs must be unique",
    ),
});
export type ProxyGroupSnapshot = z.output<typeof proxyGroupSnapshotSchema>;

export const proxyLeaseSchema = z.strictObject({
  proxy_id: identifierSchema,
  generation: z.uuid(),
});
export type ProxyLease = z.output<typeof proxyLeaseSchema>;
export const proxySelectionSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("selected"), lease: proxyLeaseSchema }),
  z.strictObject({ status: z.enum(["unavailable", "stale_configuration"]) }),
]);
export type ProxySelection = z.output<typeof proxySelectionSchema>;
export const proxySelectInputSchema = z.strictObject({
  group: proxyGroupSnapshotSchema,
  owner: proxyOwnerSchema,
  exclude: z.array(identifierSchema).max(2).default([]),
});
export const proxyOutcomeSchema = z.strictObject({
  lease: proxyLeaseSchema,
  event_id: z.uuid(),
  observed_at: timestamp,
  outcome: z.enum(["success", "failure"]),
});
export type ProxyOutcome = z.output<typeof proxyOutcomeSchema>;

export const storedProxyHealthSchema = z.strictObject({
  generation: z.uuid(),
  failures: z.array(z.strictObject({ id: z.uuid(), at: timestamp })).max(3),
  last_success_at: timestamp.nullable(),
  cooling_until: timestamp.nullable(),
});
export type StoredProxyHealth = z.output<typeof storedProxyHealthSchema>;

export const proxyGroupStatusSchema = z.object({
  group_id: identifierSchema,
  proxies: z.array(
    z.object({
      id: identifierSchema,
      status: z.enum(["healthy", "cooling", "disabled"]),
      failures: timestamp,
      cooling_until: timestamp.nullable(),
    }),
  ),
  bindings: z.array(
    proxyOwnerSchema.extend({
      proxy_id: identifierSchema,
      created_at: timestamp,
    }),
  ),
});
export type ProxyGroupStatus = z.output<typeof proxyGroupStatusSchema>;
export const proxyGroupsStatusSchema = z.object({
  items: z.array(proxyGroupStatusSchema),
});
