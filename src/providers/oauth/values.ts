/** Stable wire values shared by runtime schemas and consumers. */

export const OAuthFlow = {
  Pkce: "pkce",
  Device: "device",
} as const;

export type OAuthFlow = (typeof OAuthFlow)[keyof typeof OAuthFlow];

export const OAuthAccountStatus = {
  Disconnected: "disconnected",
  Ready: "ready",
  NeedsReauthorization: "needs_reauthorization",
} as const;

export type OAuthAccountStatus =
  (typeof OAuthAccountStatus)[keyof typeof OAuthAccountStatus];

/** Account views also expose transient authorization states. */
export const OAuthAccountViewStatus = {
  ...OAuthAccountStatus,
  Authorizing: "authorizing",
  Initializing: "initializing",
} as const;

export type OAuthAccountViewStatus =
  (typeof OAuthAccountViewStatus)[keyof typeof OAuthAccountViewStatus];

export const OAuthSessionStatus = {
  Pending: "pending",
  Exchanging: "exchanging",
  Initializing: "initializing",
  Complete: "complete",
  Cancelled: "cancelled",
  Expired: "expired",
  Error: "error",
} as const;

export type OAuthSessionStatus =
  (typeof OAuthSessionStatus)[keyof typeof OAuthSessionStatus];

export const ConsumeResetCode = {
  Reset: "reset",
  NothingToReset: "nothing_to_reset",
  NoCredit: "no_credit",
  AlreadyRedeemed: "already_redeemed",
} as const;

export type ConsumeResetCode =
  (typeof ConsumeResetCode)[keyof typeof ConsumeResetCode];
