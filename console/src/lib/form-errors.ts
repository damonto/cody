export function validationErrors(value: unknown): { message: string }[] {
  if (typeof value === "string") return [{ message: value }];
  if (Array.isArray(value)) return value.flatMap(validationErrors);
  if (!value || typeof value !== "object") return [];
  if ("message" in value && typeof value.message === "string")
    return [{ message: value.message }];
  return Object.values(value).flatMap(validationErrors);
}

export function fieldErrors(field: {
  state: { meta: { errors: readonly unknown[] } };
}) {
  return validationErrors(field.state.meta.errors);
}
