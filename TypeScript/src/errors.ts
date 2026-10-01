import { API_VERSION, isErrorType, type ErrorEnvelope, type ErrorType } from "./types.js";

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
    const ErrorClass = type === "insufficient_balance"
      ? InsufficientBalanceError
      : type === "resource_conflict"
        ? ResourceConflictError
        : WeirgateError;
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
