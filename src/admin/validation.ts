import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import { validationMessage } from "../billing/schema.ts";

/** Never serialize Zod's input data: configuration payloads contain secrets. */
export function validate<
  T extends z.ZodType,
  Target extends keyof ValidationTargets,
>(target: Target, schema: T) {
  return zValidator(target, schema, (result) => {
    if (!result.success) {
      throw new HTTPException(400, {
        message: validationMessage(result.error),
      });
    }
  });
}
