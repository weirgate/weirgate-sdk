import type { FundingRail, PlanProvider, PlanReconnectReason } from "./funding.js";
import {
  API_VERSION,
  NO_PAYWALL_ERROR_TYPES,
  isErrorType,
  type ErrorEnvelope,
  type RequestOptions,
  type WeirgateErrorKind,
} from "./types.js";

export class WeirgateError extends Error {
  /**
   * The error type. `ErrorType` is open-ended: a type newer than this SDK is
   * `"unrecognized"` (handle it by `status`), with the server's value in `rawType`.
   */
  readonly type: WeirgateErrorKind;
  /** The type exactly as the server sent it (equal to `type` unless that is `"unrecognized"`). */
  readonly rawType: string;
  readonly status: number;
  readonly requestId: string;
  readonly apiVersion: string;
  readonly detail: Record<string, unknown> | null;
  /**
   * Seconds from the `Retry-After` header (delta-seconds, or an HTTP date converted to
   * seconds from now), or null when the server sent none. Set on `rate_limited`,
   * `budget_exhausted`, `platform_allowance_exhausted`, `provider_rate_limited` (when the
   * provider sent one), and `provider_unavailable` while Apple's keys are unavailable.
   */
  readonly retryAfter: number | null;

  constructor(input: {
    type: WeirgateErrorKind;
    /** Defaults to `type`. */
    rawType?: string;
    status: number;
    requestId: string;
    apiVersion: string;
    message?: string;
    detail?: Record<string, unknown> | null;
    retryAfter?: number | null;
  }) {
    const rawType = input.rawType ?? input.type;
    super(input.message ?? `Weirgate request failed with ${rawType}`);
    this.name = "WeirgateError";
    this.type = input.type;
    this.rawType = rawType;
    this.status = input.status;
    this.requestId = input.requestId;
    this.apiVersion = input.apiVersion;
    this.detail = input.detail ?? null;
    this.retryAfter = input.retryAfter ?? null;
  }

  /**
   * True for errors that are never the end user's doing (`developer_credit_exhausted`,
   * `provider_rate_limited`, `platform_allowance_exhausted`, `budget_exhausted`): show a
   * "temporarily unavailable" message, never a paywall or purchase prompt.
   */
  get mustNotShowPaywall(): boolean {
    return (NO_PAYWALL_ERROR_TYPES as readonly string[]).includes(this.type);
  }

  static async fromResponse(response: Response): Promise<WeirgateError> {
    let envelope: ErrorEnvelope | undefined;
    try {
      envelope = (await response.clone().json()) as ErrorEnvelope;
    } catch {
      // The stable header remains authoritative when a proxy strips the JSON body.
    }
    // The header is authoritative; with neither header nor body the response isn't Weirgate's own.
    const rawType = response.headers.get("x-weirgate-error-type")
      ?? (typeof envelope?.error?.type === "string" ? envelope.error.type : "internal");
    const type = kindOf(rawType);
    const requestId = response.headers.get("x-weirgate-request-id")
      ?? envelope?.error?.request_id
      ?? "unavailable";
    const ErrorClass = errorClassFor(type);
    return new ErrorClass({
      type,
      rawType,
      retryAfter: parseRetryAfter(response.headers.get("retry-after")),
      status: response.status,
      requestId,
      apiVersion: response.headers.get("weirgate-api-version") ?? API_VERSION,
      ...(envelope?.error?.message ? { message: envelope.error.message } : {}),
      ...(envelope?.error?.detail
        ? { detail: envelope.error.detail as Record<string, unknown> }
        : {}),
    });
  }
}

type WeirgateErrorInput = ConstructorParameters<typeof WeirgateError>[0];

const kindOf = (rawType: string): WeirgateErrorKind => isErrorType(rawType) ? rawType : "unrecognized";

function errorClassFor(type: WeirgateErrorKind): typeof WeirgateError {
  switch (type) {
    case "insufficient_balance": return InsufficientBalanceError;
    case "resource_conflict": return ResourceConflictError;
    case "funding_rail_refused": return FundingRailRefusedError;
    case "funding_rail_unavailable": return FundingRailUnavailableError;
    case "user_credential_expired": return UserCredentialExpiredError;
    case "user_provider_key_invalid": return UserProviderKeyInvalidError;
    case "developer_credit_exhausted": return DeveloperCreditExhaustedError;
    case "provider_rate_limited": return ProviderRateLimitedError;
    case "platform_allowance_exhausted": return PlatformAllowanceExhaustedError;
    case "budget_exhausted": return BudgetExhaustedError;
    default: return WeirgateError;
  }
}

/**
 * The typed error carried by a stream's final `data: {"error": ...}` frame (a funding rail
 * refused after the stream started). `status` is the stream's HTTP status, 200.
 */
export function errorFromStreamFrame(
  frame: { type?: unknown; message?: unknown; request_id?: unknown; detail?: unknown },
  metadata: { requestId: string; apiVersion: string; status: number },
): WeirgateError {
  const rawType = typeof frame.type === "string" ? frame.type : "internal";
  const type = kindOf(rawType);
  const ErrorClass = errorClassFor(type);
  return new ErrorClass({
    type,
    rawType,
    status: metadata.status,
    requestId: typeof frame.request_id === "string" ? frame.request_id : metadata.requestId,
    apiVersion: metadata.apiVersion,
    ...(typeof frame.message === "string" ? { message: frame.message } : {}),
    ...(frame.detail && typeof frame.detail === "object" ? { detail: frame.detail as Record<string, unknown> } : {}),
  });
}

/**
 * Base of the three funding-rail errors. `detail` carries the rail, the refusal reason,
 * the next rail, and the plan provider's request ID (keep it for support).
 */
export class FundingRailError extends WeirgateError {
  declare readonly type: "funding_rail_refused" | "funding_rail_unavailable" | "user_credential_expired";
  readonly rail: FundingRail | null;
  readonly provider: PlanProvider | null;
  /** `plan_limit_exceeded`, `user_not_eligible`, `usage_unavailable`, `unsupported_capability`, `not_connected`, `credential_expired`, `provider_not_approved`, ... */
  readonly reason: string | null;
  readonly nextRail: FundingRail | null;
  /**
   * `detail.disable` on a mid-stream refusal (`on_refusal: next_and_disable`): stop offering
   * `rail` until the user re-consents. For a plan the SDK sent, it already called `requireReconnect`.
   */
  readonly disable: boolean;
  readonly providerRequestId: string | null;
  readonly providerCode: string | null;
  /** The idempotency key the failed attempt used (set by the client). */
  idempotencyKey: string | null = null;

  constructor(input: WeirgateErrorInput) {
    super(input);
    this.name = "FundingRailError";
    this.rail = stringDetail(this.detail, "rail");
    this.provider = stringDetail(this.detail, "provider");
    this.reason = stringDetail(this.detail, "reason");
    this.nextRail = stringDetail(this.detail, "next_rail");
    this.disable = this.detail?.["disable"] === true;
    this.providerRequestId = stringDetail(this.detail, "provider_request_id");
    this.providerCode = stringDetail(this.detail, "provider_code");
  }

  /**
   * Options to restart the request on `nextRail` (for example after a mid-stream refusal):
   * the rail as the starting point and the idempotency key the server uses for it. Null
   * when there is no next rail.
   */
  retryOptions(options: RequestOptions = {}): RequestOptions | null {
    if (!this.nextRail) return null;
    const key = this.idempotencyKey ?? options.idempotencyKey;
    return {
      ...options,
      funding: { startAt: this.nextRail },
      idempotencyKey: key ? `${key}:rail:${this.nextRail}` : undefined,
    };
  }
}

/** `funding_rail_refused` (402): the rail cannot pay and the chain stopped or ended. */
export class FundingRailRefusedError extends FundingRailError {
  declare readonly type: "funding_rail_refused";
  constructor(input: WeirgateErrorInput) {
    super(input);
    this.name = "FundingRailRefusedError";
  }
}

/** `funding_rail_unavailable` (403): not approved, not accepted by the feature, or rejected by the provider. Do not retry. */
export class FundingRailUnavailableError extends FundingRailError {
  declare readonly type: "funding_rail_unavailable";
  constructor(input: WeirgateErrorInput) {
    super(input);
    this.name = "FundingRailUnavailableError";
  }
}

/** `user_credential_expired` (401) that the SDK could not recover (no `planCredential` configured). */
export class UserCredentialExpiredError extends FundingRailError {
  declare readonly type: "user_credential_expired";
  constructor(input: WeirgateErrorInput) {
    super(input);
    this.name = "UserCredentialExpiredError";
  }
}

/**
 * The plan's tokens were cleared: show "Reconnect" (for ChatGPT, "Continue with ChatGPT").
 * Retrying the same call now uses the next rail.
 */
export class PlanReconnectRequiredError extends Error {
  readonly requestId: string;
  readonly apiVersion: string;

  constructor(readonly reason: PlanReconnectReason, readonly cause: WeirgateError | null) {
    super("Reconnect your plan to keep using it in this app", { cause });
    this.name = "PlanReconnectRequiredError";
    this.requestId = cause?.requestId ?? "unavailable";
    this.apiVersion = cause?.apiVersion ?? API_VERSION;
  }
}

/** A deduction would take the balance below zero. `available` is the balance before it. */
export class InsufficientBalanceError extends WeirgateError {
  declare readonly type: "insufficient_balance";
  readonly available: number | null;
  readonly units: number | null;

  constructor(input: WeirgateErrorInput) {
    super(input);
    this.name = "InsufficientBalanceError";
    this.available = numberDetail(this.detail, "available");
    this.units = numberDetail(this.detail, "units");
  }
}

/**
 * An idempotency key was reused with a different body, or a key was already rotated.
 * For a second rotation, `replacedByKeyId` names the existing replacement.
 */
export class ResourceConflictError extends WeirgateError {
  declare readonly type: "resource_conflict";
  readonly replacedByKeyId: string | null;

  constructor(input: WeirgateErrorInput) {
    super(input);
    this.name = "ResourceConflictError";
    const replacedBy = this.detail?.["replaced_by_key_id"];
    this.replacedByKeyId = typeof replacedBy === "string" ? replacedBy : null;
  }
}

/**
 * `user_provider_key_invalid` (422): the end user's own provider key was rejected.
 * `reason` is `invalid` (the provider refused the key: ask the user to fix it) or
 * `out_of_credit` (the key's provider account is empty: ask the user to add credit there).
 * Other reasons may be added later.
 */
export class UserProviderKeyInvalidError extends WeirgateError {
  declare readonly type: "user_provider_key_invalid";
  readonly reason: "invalid" | "out_of_credit" | (string & {}) | null;
  readonly provider: string | null;
  readonly rail: FundingRail | null;

  constructor(input: WeirgateErrorInput) {
    super(input);
    this.name = "UserProviderKeyInvalidError";
    this.reason = stringDetail(this.detail, "reason");
    this.provider = stringDetail(this.detail, "provider");
    this.rail = stringDetail(this.detail, "rail");
  }
}

/**
 * `developer_credit_exhausted` (503): the app owner's provider key is out of credit. Not
 * the end user's doing: never show a paywall. A feature whose chain lists a user rail
 * after `developer` already fell through to it inside the request; otherwise you may fall
 * back (for example to the user's own key) or retry later.
 */
export class DeveloperCreditExhaustedError extends WeirgateError {
  declare readonly type: "developer_credit_exhausted";
  readonly provider: string | null;
  readonly nextRail: FundingRail | null;

  constructor(input: WeirgateErrorInput) {
    super(input);
    this.name = "DeveloperCreditExhaustedError";
    this.provider = stringDetail(this.detail, "provider");
    this.nextRail = stringDetail(this.detail, "next_rail");
  }
}

/**
 * `provider_rate_limited` (503): the provider throttled the request. Retry after
 * `retryAfter` seconds when set. Never show a paywall.
 */
export class ProviderRateLimitedError extends WeirgateError {
  declare readonly type: "provider_rate_limited";
  readonly provider: string | null;
  readonly rail: FundingRail | null;

  constructor(input: WeirgateErrorInput) {
    super(input);
    this.name = "ProviderRateLimitedError";
    this.provider = stringDetail(this.detail, "provider");
    this.rail = stringDetail(this.detail, "rail");
  }
}

/**
 * `platform_allowance_exhausted` (429): the app's Weirgate plan used its included calls or
 * tokens for the UTC month. Never the end user's fault: show "temporarily unavailable",
 * never a paywall. `retryAfter` is the seconds until the month resets.
 */
export class PlatformAllowanceExhaustedError extends WeirgateError {
  declare readonly type: "platform_allowance_exhausted";
  /** `calls` or `tokens`. */
  readonly meter: string | null;
  readonly tier: string | null;
  /** ISO-8601 instant of the reset. */
  readonly resetsAt: string | null;

  constructor(input: WeirgateErrorInput) {
    super(input);
    this.name = "PlatformAllowanceExhaustedError";
    this.meter = stringDetail(this.detail, "meter");
    this.tier = stringDetail(this.detail, "tier");
    this.resetsAt = stringDetail(this.detail, "resets_at");
  }
}

/**
 * `budget_exhausted` (429): the app's developer-funded spend reached its monthly or daily
 * budget. Only on the developer rail; not the end user's doing, so never show a paywall.
 * `retryAfter` is the seconds until the budget period resets.
 */
export class BudgetExhaustedError extends WeirgateError {
  declare readonly type: "budget_exhausted";
  /** `month` or `day`. */
  readonly period: string | null;
  /** ISO-8601 instant of the reset. */
  readonly resetsAt: string | null;

  constructor(input: WeirgateErrorInput) {
    super(input);
    this.name = "BudgetExhaustedError";
    this.period = stringDetail(this.detail, "period");
    this.resetsAt = stringDetail(this.detail, "resets_at");
  }
}

/**
 * `Retry-After` as seconds: delta-seconds, or an HTTP date as seconds from `now` (0 when
 * it has passed). Null when absent or unparseable.
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (!/[a-z]/i.test(trimmed) || Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

function stringDetail(detail: Record<string, unknown> | null, key: string): string | null {
  const value = detail?.[key];
  return typeof value === "string" ? value : null;
}

function numberDetail(detail: Record<string, unknown> | null, key: string): number | null {
  const value = detail?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export class WeirgateNetworkError extends Error {
  readonly requestId = "unavailable";
  readonly apiVersion = API_VERSION;

  constructor(readonly cause: unknown) {
    super("The Weirgate request could not reach the API", { cause });
    this.name = "WeirgateNetworkError";
  }
}

export class WeirgateProtocolError extends Error {
  constructor(
    message: string,
    readonly requestId: string,
    readonly apiVersion: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "WeirgateProtocolError";
  }
}

export class WeirgateStreamError extends Error {
  readonly status = 200;

  constructor(
    readonly reason: "missing_body" | "invalid_content_type" | "invalid_frame" | "interrupted",
    readonly requestId: string,
    readonly apiVersion: string,
    message: string,
  ) {
    super(message);
    this.name = "WeirgateStreamError";
  }
}

export class UsageTruncatedError extends Error {
  constructor(
    readonly requestId: string,
    readonly apiVersion: string,
    readonly limit: number,
    readonly returned: number,
  ) {
    super(`Usage response was truncated at ${returned} of at least ${limit} groups`);
    this.name = "UsageTruncatedError";
  }
}
