import { timingSafeEqual } from "node:crypto";

/** Compare fixed-length digests on both Workers and Node. */
export async function equalSecret(
  left: string,
  right: string,
): Promise<boolean> {
  const digest = (value: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  return timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
}
