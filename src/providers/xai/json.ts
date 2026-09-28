export type Wire = Record<string, unknown>;
export function isRecord(value: unknown): value is Wire {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function object(value: unknown): Wire {
  return isRecord(value) ? value : {};
}
export function records(value: unknown): Wire[] {
  return Array.isArray(value) ? value.map(object) : [];
}
export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
