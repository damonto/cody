export class ControlConflict extends Error {
  override name = "ControlConflict";
}
export class ControlInputError extends Error {
  override name = "ControlInputError";
}

export class ControlNotFound extends Error {
  override name = "ControlNotFound";
}
export function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new ControlNotFound(`${name} does not exist`);
  return value;
}
