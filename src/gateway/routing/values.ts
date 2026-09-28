/** Results of resolving a client session binding. */

export const SessionAffinityStatus = {
  Hit: "hit",
  Created: "created",
  Rebound: "rebound",
  Failed: "failed",
  Blocked: "blocked",
  Forbidden: "forbidden",
} as const;

export type SessionAffinityStatus =
  (typeof SessionAffinityStatus)[keyof typeof SessionAffinityStatus];
