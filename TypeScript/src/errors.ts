import type { FundingRail, PlanProvider, PlanReconnectReason } from "./funding.js";
import { API_VERSION, isErrorType, type ErrorEnvelope, type ErrorType, type RequestOptions } from "./types.js";

export class WeirgateError extends Error {
  readonly type: ErrorType;
  readonly status: number;
  readonly requestId: string;
  readonly apiVersion: string;
  readonly detail: Record<string, unknown> | null;

  constructor(input: {
    type: ErrorType;
    status: number;
    requestId: string;
    apiVersion: string;
    message?: string;
    detail?: Record<string, unknown> | null;
  }) {
    super(input.message ?? `Weirgate request failed with ${input.type}`);
    this.name = "WeirgateError";
    this.type = input.type;
    this.status = input.status;
    this.requestId = input.requestId;
    this.apiVersion = input.apiVersion;
    this.detail = input.detail ?? null;
  }

  static async fromResponse(response: Response): Promise<WeirgateError> {
    let envelope: ErrorEnvelope | undefined;
    try {
      envelope = (await response.clone().json()) as ErrorEnvelope;
    } catch {
      // The stable header remains authoritative when a proxy strips the JSON body.
    }
    const headerType = response.headers.get("x-weirgate-error-type");
    const bodyType = envelope?.error?.type;
    const type = isErrorType(headerType) ? headerType : isErrorType(bodyType) ? bodyType : "internal";
    const requestId = response.headers.get("x-weirgate-request-id")
      ?? envelope?.error?.request_id
      ?? "unavailable";
    const ErrorClass = errorClassFor(type);
    return new ErrorClass({
      type,
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

function errorClassFor(type: ErrorType): typeof WeirgateError {
  switch (type) {
    case "insufficient_balance": return InsufficientBalanceError;
    case "resource_conflict": return ResourceConflictError;
    case "funding_rail_refused": return FundingRailRefusedError;
    case "funding_rail_unavailable": return FundingRailUnavailableError;
    case "user_credential_expired": return UserCredentialExpiredError;
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
  const type = isErrorType(frame.type) ? frame.type : "internal";
  const ErrorClass = errorClassFor(type);
  return new ErrorClass({
    type,
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
