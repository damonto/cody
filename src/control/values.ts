/** Stable wire values shared by runtime schemas and consumers. */

export const RevisionStatus = {
  Pending: "pending",
  Published: "published",
  Superseded: "superseded",
} as const;

export type RevisionStatus =
  (typeof RevisionStatus)[keyof typeof RevisionStatus];
