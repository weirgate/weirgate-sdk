import type { components } from "./generated/schema.js";
import type { FeatureCatalog, FeatureCatalogEntry } from "./types.js";

/**
 * Where the provider cost of one request is borne. Open-ended: Weirgate may add rails, so
 * treat unknown strings as valid.
 */
export type FundingRail = components["schemas"]["FundingRail"] | (string & {});

/** A subscription provider the `user_plan` rail forwards to. Open-ended. */
export type PlanProvider = components["schemas"]["PlanProvider"] | (string & {});

/**
 * Which rail a request starts from. `"server_chain"` (the default) follows the feature's
 * chain; `{ startAt }` sends `X-Weirgate-Funding` so the chain starts at that rail.
 */
export type FundingPreference =
  | "server_chain"
  | { startAt: FundingRail; provider?: PlanProvider | undefined };

/** Who paid, from `X-Weirgate-Funding-Rail` and `X-Weirgate-Funding-Fallback`. */
export interface FundingOutcome {
  rail: FundingRail | null;
  provider: PlanProvider | null;
  /** A rail that refused inside the request before a later rail paid. */
  fallback: {
    refusedRail: FundingRail;
    reason: string | null;
    /** Stop offering `refusedRail` until the user re-consents. The SDK already disconnected a plan. */
    disable: boolean;
  } | null;
}

export type PlanReconnectReason =
  /** Weirgate rejected a freshly refreshed credential (for example `subscription_sharing_invalid_user`). */
  | { kind: "credential_rejected"; providerCode: string | null }
  /** The provider refused the refresh token (`invalid_grant`, `invalid_refresh_token`, `token_expired`, `refresh_token_reused`). */
  | { kind: "refresh_rejected"; oauthError: string }
  /** The server fell back past the plan with `disable` (`on_refusal: next_and_disable`). */
  | { kind: "rail_disabled"; reason: string | null };

export type PlanRefreshResult =
  | { kind: "refreshed"; accessToken: string }
  | { kind: "reconnect_required"; reason: PlanReconnectReason };

/**
 * The end user's plan credential for the `user_plan` rail. Keep tokens out of browser
 * storage: in a web app, implement this against your own server, which holds the refresh
 * token (see the README recipe). The SDK sends the access token per request and never
 * stores it.
 */
export interface PlanCredentialSource {
  readonly provider: PlanProvider;
  /** The token to send now (refreshed first when it expires within five minutes), or null when not connected or not funding. */
  fundingAccessToken(): Promise<string | null>;
  /** Weirgate rejected `rejected` with `user_credential_expired`: refresh once. Throw only for transient failures. */
  refreshAccessToken(rejected: string): Promise<PlanRefreshResult>;
  /** Clear stored tokens and show "Reconnect". */
  requireReconnect(reason: PlanReconnectReason): Promise<void> | void;
}

/** Parses the funding response headers; null when neither is present. */
export function parseFundingHeaders(headers: Headers): FundingOutcome | null {
  const railHeader = headers.get("x-weirgate-funding-rail");
  const fallbackHeader = headers.get("x-weirgate-funding-fallback");
  if (railHeader === null && fallbackHeader === null) return null;
  const paid = railHeader === null ? null : parameters(railHeader);
  const refused = fallbackHeader === null ? null : parameters(fallbackHeader);
  return {
    rail: paid?.head ?? null,
    provider: paid?.values.get("provider") ?? null,
    fallback: refused?.head
      ? { refusedRail: refused.head, reason: refused.values.get("reason") ?? null, disable: refused.flags.has("disable") }
      : null,
  };
}

/** The `X-Weirgate-Funding` value for a preference, or null for the server chain. */
export function fundingHeaderValue(preference: FundingPreference): string | null {
  if (preference === "server_chain") return null;
  return preference.provider ? `${preference.startAt}; provider=${preference.provider}` : preference.startAt;
}

/** True when the user's `provider` plan can pay for this feature: show that provider's button next to it. */
export function acceptsPlan(entry: FeatureCatalogEntry, provider: PlanProvider): boolean {
  const funding = (entry as Partial<FeatureCatalogEntry>).funding;
  if (!funding) return false;
  return (funding.order as readonly string[]).includes("user_plan")
    && (funding.plan_providers as readonly string[]).includes(provider);
}

/** Available features the user's `provider` plan can pay for. */
export function featuresAcceptingPlan(catalog: FeatureCatalog, provider: PlanProvider): FeatureCatalogEntry[] {
  return catalog.data.filter((entry) => entry.availability.available && acceptsPlan(entry, provider));
}

/** True when any available feature accepts `provider`: offer the (optional) connect button. */
export function offersPlan(catalog: FeatureCatalog, provider: PlanProvider): boolean {
  return featuresAcceptingPlan(catalog, provider).length > 0;
}

function parameters(header: string): { head: string | null; values: Map<string, string>; flags: Set<string> } {
  const parts = header.split(";").map((part) => part.trim()).filter(Boolean);
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (const part of parts.slice(1)) {
    const equals = part.indexOf("=");
    if (equals >= 0) values.set(part.slice(0, equals).toLowerCase(), part.slice(equals + 1));
    else flags.add(part.toLowerCase());
  }
  return { head: parts[0] ?? null, values, flags };
}
