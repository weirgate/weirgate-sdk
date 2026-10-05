import type { components } from "./generated/schema.js";
import type { FundingOutcome, FundingPreference } from "./funding.js";

export type ErrorType = components["schemas"]["ErrorType"];
export type ErrorEnvelope = components["schemas"]["ErrorEnvelope"];
export type Health = components["schemas"]["Health"];
export type ChatMessage = components["schemas"]["ChatMessage"];
export type ChatCompletionRequest = components["schemas"]["ChatCompletionRequest"];
export type ChatCompletionInput = Omit<ChatCompletionRequest, "stream"> & { stream?: boolean };
export type ChatCompletion = components["schemas"]["ChatCompletion"];
export type ChatCompletionChunk = components["schemas"]["ChatCompletionChunk"];
export type Usage = components["schemas"]["Usage"];
export type EmbeddingRequest = components["schemas"]["EmbeddingRequest"];
export type EmbeddingResponse = components["schemas"]["EmbeddingResponse"];
export type FeatureCatalog = components["schemas"]["FeatureCatalog"];
export type FeatureCatalogEntry = components["schemas"]["FeatureCatalogEntry"];
/** `allowance_available` + `purchased_available` = `units_available`; `purchased_available` may be negative. */
export type Balance = components["schemas"]["Balance"];
/** Redeem result. Subscription products add `kind: "subscription"`, `original_transaction_id`, `tier`, and `subscription`. */
export type AppleRedemption = components["schemas"]["AppleRedeemResult"];
export type AppleSubscriptionState = NonNullable<AppleRedemption["subscription"]>;
export type PaymentTransaction = components["schemas"]["PaymentTransaction"];
export type PaymentSubscription = components["schemas"]["PaymentSubscription"];
export type AccountDeletionResult = components["schemas"]["AccountDeletionResult"];
export type ClientTelemetryInput = components["schemas"]["ClientTelemetryInput"];
export type Accepted = components["schemas"]["Accepted"];
export type OutputContract = components["schemas"]["OutputContract"];
export type UsageRollup = components["schemas"]["UsageRollup"];
export type UsageRollupPage = components["schemas"]["UsageRollupPage"];
export type UserRow = components["schemas"]["UserRow"];
export type GrantRow = components["schemas"]["GrantRow"];
export type StoreBalance = components["schemas"]["StoreBalance"];
export type UserBalance = components["schemas"]["UserBalance"];
export type UserTierAssignmentInput = Omit<components["schemas"]["UserTierAssignmentInput"], "top_up_now" | "expires_at">
  & { top_up_now?: boolean; expires_at?: string | Date };
export type UserTierRevertInput = Partial<components["schemas"]["UserTierRevertInput"]>;
export type UserTierChange = components["schemas"]["UserTierChangeRow"];
export type UserTierChangeResult = components["responses"]["UserTierChangeOk"]["content"]["application/json"];
export type GrantInput = Omit<components["schemas"]["GrantInput"], "idempotency_key">;
export type GrantResult = components["responses"]["GrantOk"]["content"]["application/json"];
export type GrantReversalResult = components["responses"]["GrantReversalOk"]["content"]["application/json"];
export type CreditAdjustmentInput = components["schemas"]["CreditAdjustmentInput"];
export type CreditAdjustment = components["schemas"]["CreditAdjustmentRow"];
export type CreditAdjustmentResult = components["responses"]["CreditAdjustmentOk"]["content"]["application/json"];
export type UserCredits = components["responses"]["UserOk"]["content"]["application/json"];
/** Whether a user's active tier comes from a store subscription or a manual/default assignment. */
export type PlanSource = UserCredits["tier_source"];
export type ManagementKeyMetadata = components["schemas"]["ManagementKeyMetadata"];
export type ManagementKeyRotateInput = Partial<components["schemas"]["ManagementKeyRotateInput"]>;
export type RotatedManagementKey = components["schemas"]["RotatedManagementKey"];

export const API_VERSION = "2026-07-18" as const;

export const ERROR_TYPES = [
  "invalid_request",
  "invalid_token",
  "user_provider_key_required",
  "user_provider_key_invalid",
  "insufficient_scope",
  "out_of_allowance",
  "insufficient_balance",
  "abuse_blocked",
  "feature_disabled",
  "feature_not_found",
  "resource_not_found",
  "resource_conflict",
  "provider_policy_blocked",
  "output_contract_unsupported",
  "output_contract_violation",
  "proposal_stale",
  "rate_limited",
  "telemetry_request_unavailable",
  "provider_unavailable",
  "purchase_invalid_signature",
  "purchase_wrong_app",
  "purchase_environment_mismatch",
  "purchase_unknown_product",
  "purchase_revoked",
  "purchase_account_mismatch",
  "funding_rail_refused",
  "funding_rail_unavailable",
  "user_credential_expired",
  "internal",
] as const satisfies readonly ErrorType[];

export function isErrorType(value: unknown): value is ErrorType {
  return typeof value === "string" && (ERROR_TYPES as readonly string[]).includes(value);
}

export interface ResponseMetadata {
  requestId: string;
  apiVersion: string;
  status: number;
}

export interface WeirgateResult<T> extends ResponseMetadata {
  data: T;
  headers: Headers;
  /** Who paid, on chat and embedding results; absent elsewhere. */
  funding?: FundingOutcome | null;
}

export type CatalogResult =
  | ({ kind: "modified"; etag: string | null } & WeirgateResult<FeatureCatalog>)
  | ({ kind: "not_modified"; etag: string | null; headers: Headers } & ResponseMetadata);

export interface RequestOptions {
  idempotencyKey?: string | undefined;
  userProviderKey?: string | undefined;
  signal?: AbortSignal | undefined;
  /** Overrides the client's `fundingPreference` for this call (chat, streaming, embeddings). */
  funding?: FundingPreference | undefined;
}

/**
 * Credit writes need a key derived from your own durable record (a payment event,
 * charge, or order ID) so webhook retries replay instead of double-crediting. The SDK
 * never generates one for these calls.
 */
export interface CreditWriteOptions {
  idempotencyKey: string;
  signal?: AbortSignal | undefined;
}

export interface RotateAdminKeyOptions {
  /** Only for platform keys; tenant keys are pinned to their own tenant. */
  tenantId?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface UsageQuery {
  since?: string | Date | undefined;
  until?: string | Date | undefined;
  limit?: number | undefined;
  groupBy?: "feature" | "user" | undefined;
  signal?: AbortSignal | undefined;
}

export interface ChatStream extends ResponseMetadata {
  creditsRemaining: number | null;
  chunks: AsyncIterable<ChatCompletionChunk>;
  /** Who is paying for this stream, from the response headers. */
  funding?: FundingOutcome | null;
}
