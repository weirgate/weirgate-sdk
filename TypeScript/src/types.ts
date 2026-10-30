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
/** `origin` is `real`, `test` (an automated test run's user), or `sandbox` (a sandbox fixture's user). */
export type UserRow = components["schemas"]["UserRow"];
/** Where a user came from. Sandbox users are listed but never counted in `pagination.total`. */
export type UserOrigin = UserRow["origin"];
/** One settled request, as the management API reads it (e.g. `UserCredits` recent usage). */
export type UsageEvent = components["schemas"]["UsageEvent"];
/**
 * The provider's id for the generation (OpenRouter `gen-…`, OpenAI `resp_…`, Anthropic
 * `msg_…`, …) for matching the provider's request log. Null when the provider returned
 * none, in mock mode, and for requests settled before 2026-10-18.
 */
export type UpstreamGenerationId = components["schemas"]["UpstreamGenerationId"];
/** Who served the request (`openrouter`, `openai`, `anthropic`, `google`, `xai`, the plan provider, or `mock`); null before 2026-10-18. */
export type UpstreamProvider = components["schemas"]["UpstreamProvider"];
/** The `[since, until)` window an export page answers. */
export type ExportWindow = components["schemas"]["ExportWindow"];
/** Export paging: pass `next_cursor` back, with the same window, while `truncated` is true. */
export type ExportPagination = components["schemas"]["ExportPagination"];
/** One settled request in the usage export. The CSV columns are these fields in this order. */
export type UsageExportRow = components["schemas"]["UsageExportRow"];
/** One page of `exportUsageEvents` (JSON). */
export type UsageExportPage = components["responses"]["UsageExportOk"]["content"]["application/json"];
/** One end user's settled usage on one funding rail over whole UTC days. The CSV columns are these fields in this order. */
export type UsageRollupRow = components["schemas"]["UsageRollupRow"];
/** One page of `getUsageByUserRail` (JSON). */
export type UsageByUserRailPage = components["responses"]["UsageRollupOk"]["content"]["application/json"];
export type GrantRow = components["schemas"]["GrantRow"];
export type StoreBalance = components["schemas"]["StoreBalance"];
export type UserBalance = components["schemas"]["UserBalance"];
export type UserTierAssignmentInput = Omit<components["schemas"]["UserTierAssignmentInput"], "top_up_now" | "expires_at">
  & { top_up_now?: boolean; expires_at?: string | Date };
export type UserTierRevertInput = Partial<components["schemas"]["UserTierRevertInput"]>;
export type UserTierChange = components["schemas"]["UserTierChangeRow"];
export type UserTierChangeResult = components["responses"]["UserTierChangeOk"]["content"]["application/json"];
export type GrantInput = components["schemas"]["GrantInput"];
export type GrantResult = components["responses"]["GrantOk"]["content"]["application/json"];
export type GrantReversalResult = components["responses"]["GrantReversalOk"]["content"]["application/json"];
export type CreditAdjustmentInput = components["schemas"]["CreditAdjustmentInput"];
export type CreditAdjustment = components["schemas"]["CreditAdjustmentRow"];
export type CreditAdjustmentResult = components["responses"]["CreditAdjustmentOk"]["content"]["application/json"];
export type UserCredits = components["responses"]["UserOk"]["content"]["application/json"];
/** Whether a user's active tier comes from a store subscription or a manual/default assignment. */
export type PlanSource = UserCredits["tier_source"];
/** Why a user is blocked now: active conditions first, then refusals of the last 24 hours. Also `UserCredits["status"]`. */
export type UserStatus = components["schemas"]["UserStatus"];
export type UserStatusReason = components["schemas"]["UserStatusReason"];
/** One row of `listUsers`: `UserRow` plus unlimited state, balance split, activity, and spend. */
export type UserListRow = components["schemas"]["UserListRow"];
/**
 * A `listUsers` page. `pagination.total` counts every matching user up to 10,000, sandbox
 * users excluded (`pagination.sandbox_total` counts those); when `pagination.total_capped`
 * is true more match, so show the count as "10,000+".
 */
export type UserListPage = components["responses"]["UserListOk"]["content"]["application/json"];
export type ManagementKeyMetadata = components["schemas"]["ManagementKeyMetadata"];
export type ManagementKeyRotateInput = Partial<components["schemas"]["ManagementKeyRotateInput"]>;
export type RotatedManagementKey = components["schemas"]["RotatedManagementKey"];
/** A person on the team. `role` is Weirgate's; the Clerk organization role follows it. */
export type DeveloperMember = components["schemas"]["DeveloperMember"];
/** `owner` or `member`. */
export type DeveloperRole = DeveloperMember["role"];
/** `listMembers` result. */
export type DeveloperMemberList = components["responses"]["DeveloperMemberListOk"]["content"]["application/json"];
/**
 * `removeMember` result. `clerk_membership` is `already_absent` when an earlier attempt
 * already removed the Clerk membership (a retry still removes the Weirgate one).
 */
export type DeveloperMemberRemoval = components["responses"]["DeveloperMemberRemovedOk"]["content"]["application/json"];
/** `createInvitation` result. `id` is the Clerk organization invitation id. */
export type DeveloperInvitation = components["responses"]["DeveloperInvitationCreated"]["content"]["application/json"];
/** `revokeInvitation` result. `already_revoked` is true when it was revoked before. */
export type DeveloperInvitationRevocation = components["responses"]["DeveloperInvitationRevokedOk"]["content"]["application/json"];

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
  "budget_exhausted",
  "telemetry_request_unavailable",
  "provider_unavailable",
  "developer_credit_exhausted",
  "provider_rate_limited",
  "purchase_invalid_signature",
  "purchase_wrong_app",
  "purchase_environment_mismatch",
  "purchase_unknown_product",
  "purchase_revoked",
  "purchase_account_mismatch",
  "funding_rail_refused",
  "funding_rail_unavailable",
  "user_credential_expired",
  "platform_allowance_exhausted",
  "internal",
] as const satisfies readonly ErrorType[];

/**
 * Error types that are never the end user's doing: the app owner's provider key, the
 * provider, or the app's own Weirgate plan or budget refused the request. Show a
 * "temporarily unavailable" message, never a paywall or purchase prompt. See
 * `WeirgateError.mustNotShowPaywall`.
 */
export const NO_PAYWALL_ERROR_TYPES = [
  "developer_credit_exhausted",
  "provider_rate_limited",
  "platform_allowance_exhausted",
  "budget_exhausted",
] as const satisfies readonly ErrorType[];

/**
 * `WeirgateError.type`: a type this SDK version knows, or `"unrecognized"` for one the
 * server added later (`ErrorType` is open-ended). The server's value is in `rawType`.
 */
export type WeirgateErrorKind = ErrorType | "unrecognized";

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
  /**
   * Default `feature`. `refusal_code` groups refused requests by error type; its groups
   * carry only `requests` (other sums are 0, latency null).
   */
  groupBy?: "feature" | "user" | "model" | "funding_rail" | "refusal_code" | undefined;
  signal?: AbortSignal | undefined;
}

/** Query for `exportUsageEvents` and its CSV and iterator variants. */
export interface UsageExportQuery {
  /** Window start (inclusive). Required. */
  since: string | Date;
  /**
   * Window end (exclusive), later than `since`. Required. For a complete export, end the
   * window at least five minutes in the past so no request in it is still settling.
   */
  until: string | Date;
  /** `next_cursor` of the previous page, with the same `since` and `until`. */
  cursor?: string | undefined;
  /** Page size, 1–1000 (default 1000). */
  limit?: number | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Query for `getUsageByUserRail` and its CSV and iterator variants. `since` and `until`
 * must be UTC midnights (whole UTC days); the SDK rejects other instants before sending.
 */
export type UsageByUserRailQuery = UsageExportQuery;

/** One CSV page of an export. Every page starts with the header row. */
export interface UsageCsvPage {
  /** The page as `text/csv`: header row, then rows, CRLF line ends. */
  csv: string;
  /** From `X-Weirgate-Next-Cursor`; null on the last page. */
  nextCursor: string | null;
  /** From `X-Weirgate-Truncated`: true when more rows follow this page. */
  truncated: boolean;
}

export interface ListUsersQuery {
  cursor?: string | undefined;
  /** Page size, 1–100 (default 100). */
  limit?: number | undefined;
  /** Prefix of the external ID (case-sensitive), or a full user ID. */
  q?: string | undefined;
  tier?: string | undefined;
  balanceLt?: number | undefined;
  /** Only `true` filters; users with nothing left of a monthly allowance and no debt. */
  outOfAllowance?: true | undefined;
  activeSince?: string | Date | undefined;
  inactiveSince?: string | Date | undefined;
  paying?: boolean | undefined;
  /** Only users of this origin. Unset lists every origin, sandbox users included. */
  origin?: UserOrigin | undefined;
  sort?: "id" | "spend" | "last_active" | "balance" | "created" | undefined;
  direction?: "asc" | "desc" | undefined;
  signal?: AbortSignal | undefined;
}

export interface ChatStream extends ResponseMetadata {
  creditsRemaining: number | null;
  chunks: AsyncIterable<ChatCompletionChunk>;
  /** Who is paying for this stream, from the response headers. */
  funding?: FundingOutcome | null;
}
