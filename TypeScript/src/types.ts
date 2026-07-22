import type { components } from "./generated/schema.js";

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
export type Balance = components["schemas"]["Balance"];
export type ClientTelemetryInput = components["schemas"]["ClientTelemetryInput"];
export type Accepted = components["schemas"]["Accepted"];
export type OutputContract = components["schemas"]["OutputContract"];
export type UsageRollup = components["schemas"]["UsageRollup"];
export type UsageRollupPage = components["schemas"]["UsageRollupPage"];

export const API_VERSION = "2026-07-18" as const;

export const ERROR_TYPES = [
  "invalid_request",
  "invalid_token",
  "user_provider_key_required",
  "user_provider_key_invalid",
  "insufficient_scope",
  "out_of_allowance",
  "abuse_blocked",
  "feature_disabled",
  "feature_not_found",
  "resource_not_found",
  "provider_policy_blocked",
  "output_contract_unsupported",
  "output_contract_violation",
  "proposal_stale",
  "rate_limited",
  "telemetry_request_unavailable",
  "provider_unavailable",
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
}

export type CatalogResult =
  | ({ kind: "modified"; etag: string | null } & WeirgateResult<FeatureCatalog>)
  | ({ kind: "not_modified"; etag: string | null; headers: Headers } & ResponseMetadata);

export interface RequestOptions {
  idempotencyKey?: string | undefined;
  userProviderKey?: string | undefined;
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
}
