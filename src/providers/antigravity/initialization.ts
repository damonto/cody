import { z } from "zod";
import { antigravityVerificationSchema } from "../../shared/antigravity-verification.ts";
import {
  connectionSchema,
  identitySchema,
  tokenSchema,
  OAuthError,
} from "../oauth/schema.ts";
import { onboardingTier, projectId, type AntigravityClient } from "./api.ts";

export const PROJECT_INITIALIZATION_TTL_MS = 10 * 60_000;
export const projectInitializationSchema = z.object({
  tokens: tokenSchema,
  identity: identitySchema,
  connection: connectionSchema,
  stage: z.enum(["project", "onboard"]),
  tier: z.string(),
  attempts: z.number().int().nonnegative(),
  next_at: z.number(),
  deadline: z.number(),
  error: z.string().nullable(),
  verification: z.array(antigravityVerificationSchema).optional(),
  last_result: z.string().nullable(),
});
export type ProjectInitialization = z.output<
  typeof projectInitializationSchema
>;
type ProjectProgress = Pick<
  ProjectInitialization,
  "stage" | "tier" | "last_result"
>;
export type ProjectStep =
  | { kind: "ready"; project_id: string }
  | { kind: "pending"; progress: ProjectProgress };

/** One upstream step. The account object owns token rotation and fenced writes. */
export async function pollProject(
  client: Pick<AntigravityClient, "load" | "onboard">,
  project: ProjectInitialization,
): Promise<ProjectStep> {
  const token = project.tokens.access_token;
  if (project.stage === "onboard") {
    const result = await client.onboard(token, project.tier);
    if (result.done === true) {
      const id = projectId(result.response);
      if (!id)
        throw new OAuthError(
          "Google completed onboarding without assigning a project ID; check account project requirements before retrying",
          502,
          "project_id_missing",
        );
      return { kind: "ready", project_id: id };
    }
    return {
      kind: "pending",
      progress: {
        stage: "onboard",
        tier: project.tier,
        last_result: "onboardUser has not completed",
      },
    };
  }
  const result = await client.load(token);
  const id = projectId(result);
  return id
    ? { kind: "ready", project_id: id }
    : {
        kind: "pending",
        progress: {
          stage: "onboard",
          tier: onboardingTier(result),
          last_result: "loadCodeAssist returned no project ID",
        },
      };
}

export function scheduleProjectRetry(
  project: ProjectInitialization,
  now: number,
): ProjectInitialization {
  const attempts = project.attempts + 1;
  const delay = Math.min(30_000, 5_000 * 2 ** Math.min(attempts - 1, 3));
  return {
    ...project,
    attempts,
    next_at: Math.min(now + delay, project.deadline),
  };
}

export function retryableProjectError(error: OAuthError): boolean {
  return (
    error.code === "upstream_transport_error" ||
    (error.code === "upstream_error" &&
      [408, 429, 500, 502, 503, 504].includes(error.status))
  );
}

export function projectTimeout(project: ProjectInitialization): OAuthError {
  return new OAuthError(
    `Project setup is still unavailable after ten minutes; retry project initialization. Last result: ${project.last_result ?? "No upstream result received"}`,
    504,
    "project_initialization_timeout",
  );
}
