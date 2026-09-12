import { createMiddleware } from "hono/factory";
import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { BodyTooLargeError } from "../gateway/http/body.ts";
import { authenticateAdmin, safeAdminMutation } from "./auth.ts";
import type { AdminContext } from "./context.ts";

export const adminSecurity = createMiddleware<AdminContext>(
  async (context, next) => {
    context.header("cache-control", "no-store");
    context.header("x-content-type-options", "nosniff");
    context.header("referrer-policy", "no-referrer");
    context.header(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const actor = await authenticateAdmin(context.req.raw, context.env);
    if (!actor)
      return context.json(
        {
          error:
            "Administrator authentication required. Configure Cloudflare Access.",
        },
        401,
      );
    if (!safeAdminMutation(context.req.raw))
      return context.json({ error: "Invalid admin request origin" }, 403);
    context.set("actor", actor);
    await next();
    return undefined;
  },
);
export const adminError: ErrorHandler<AdminContext> = (error, context) => {
  if (error instanceof HTTPException)
    return context.json({ error: error.message }, error.status);
  if (error instanceof BodyTooLargeError)
    return context.json({ error: "Request exceeds 2 MiB" }, 413);
  if (error instanceof ZodError) {
    // Request validation is translated to HTTPException at the input boundary.
    // Remaining schema errors describe internal data; never log their input values.
    console.error({
      event: "admin.response.invalid",
      path: context.req.path,
      issues: error.issues.map(({ path, code }) => ({ path, code })),
    });
    return context.json(
      { error: "The console received invalid data. Please try again." },
      500,
    );
  }
  console.error({ event: "admin.operation.failed", name: error.name });
  return context.json(
    {
      error:
        "Control operation failed. Check D1 migrations, CONFIG_ENCRYPTION_KEY, and Worker logs.",
    },
    503,
  );
};
