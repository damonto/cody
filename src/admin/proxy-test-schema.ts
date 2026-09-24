import { z } from "zod";

// Browser-safe contract: keep configuration and reporting schemas out of here.
export const proxyTestResultSchema = z.strictObject({
  ip: z.union([z.ipv4(), z.ipv6()]),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable(),
});

export type ProxyTestResult = z.output<typeof proxyTestResultSchema>;
