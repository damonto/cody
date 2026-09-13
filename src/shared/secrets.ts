export const SECRET_PLACEHOLDER = "__CODY_SECRET_UNCHANGED__";

export function createClientKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const suffix = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sk-cody-${suffix}`;
}
