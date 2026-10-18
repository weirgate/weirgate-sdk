import type { components } from "./generated/schema.js";

/** A webhook event type this SDK knows. The list is open-ended; see `WebhookEvent.type`. */
export type WebhookEventType = components["schemas"]["WebhookEventType"];

export const WEBHOOK_EVENT_TYPES = [
  "allowance.low",
  "allowance.exhausted",
  "rule.breached",
  "provider_policy.changed",
  "grant.created",
  "grant.reversed",
  "credits.adjusted",
  "tier.expiring",
  "tier.expired",
  "purchase.granted",
  "purchase.refunded",
  "provider.credit_exhausted",
  "provider.credit_restored",
  "provider.credit_low",
  "user_key.rejected",
  "platform.allowance_warning",
  "platform.allowance_exhausted",
] as const satisfies readonly WebhookEventType[];

/**
 * A verified webhook delivery body. `type` may be newer than this SDK: ignore types you
 * don't handle. `user_id` is Weirgate's internal user ID (null for app-level events such as
 * `provider.credit_*` and `platform.*`); most user events also carry `data.external_id`.
 */
export type WebhookEvent = Omit<components["schemas"]["WebhookEvent"], "type"> & {
  type: WebhookEventType | (string & {});
};

export function isWebhookEventType(value: unknown): value is WebhookEventType {
  return typeof value === "string" && (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/** Default `toleranceSeconds`: deliveries signed more than five minutes away from now are rejected. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export interface WebhookVerifyInput {
  /** The exact raw request body, before any JSON parsing. */
  payload: string | Uint8Array;
  /** The request headers (a `Headers` object or a Node-style header record). */
  headers: Headers | Record<string, string | string[] | undefined>;
  /** The endpoint's `whsec_` signing secret. */
  secret: string;
  /** Maximum age (or clock skew) of `Weirgate-Timestamp`, in seconds. Default 300. */
  toleranceSeconds?: number;
  /** The current time; defaults to `Date.now()`. */
  now?: Date | number;
}

export class WebhookSignatureError extends Error {
  constructor(
    readonly reason:
      | "missing_header"
      | "invalid_timestamp"
      | "timestamp_out_of_tolerance"
      | "invalid_signature_format"
      | "signature_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

const encoder = new TextEncoder();

/**
 * Verifies a webhook delivery: `Weirgate-Signature: v1=<hex>` must be the HMAC-SHA256 of
 * `<Weirgate-Timestamp>.<raw body>` under `secret` (compared in constant time), and the
 * timestamp must be within `toleranceSeconds` of now. Throws `WebhookSignatureError`;
 * resolves when the delivery is authentic. Deduplicate by event `id` afterwards: delivery
 * is at least once.
 */
export async function verifyWebhookSignature(input: WebhookVerifyInput): Promise<void> {
  const timestampHeader = header(input.headers, "weirgate-timestamp");
  const signatureHeader = header(input.headers, "weirgate-signature");
  if (!timestampHeader || !signatureHeader) {
    throw new WebhookSignatureError("missing_header", "Weirgate-Timestamp and Weirgate-Signature are required");
  }
  if (!/^\d+$/.test(timestampHeader)) {
    throw new WebhookSignatureError("invalid_timestamp", "Weirgate-Timestamp is not Unix seconds");
  }
  const tolerance = input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((input.now instanceof Date ? input.now.getTime() : input.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - Number(timestampHeader)) > tolerance) {
    throw new WebhookSignatureError("timestamp_out_of_tolerance", "Weirgate-Timestamp is outside the tolerance");
  }

  const signatures = signatureHeader
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1="))
    .map((part) => hexBytes(part.slice(3)))
    .filter((bytes): bytes is Uint8Array<ArrayBuffer> => bytes !== null);
  if (signatures.length === 0) {
    throw new WebhookSignatureError("invalid_signature_format", "Weirgate-Signature has no v1= signature");
  }

  const subtle = subtleCrypto();
  const key = await subtle.importKey("raw", encoder.encode(input.secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const body = typeof input.payload === "string" ? encoder.encode(input.payload) : input.payload;
  const prefix = encoder.encode(`${timestampHeader}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  for (const signature of signatures) {
    // HMAC verify compares in constant time.
    if (await subtle.verify("HMAC", key, signature, signed)) return;
  }
  throw new WebhookSignatureError("signature_mismatch", "Weirgate-Signature does not match the payload");
}

/** `verifyWebhookSignature`, then the parsed event. */
export async function constructWebhookEvent(input: WebhookVerifyInput): Promise<WebhookEvent> {
  await verifyWebhookSignature(input);
  const text = typeof input.payload === "string" ? input.payload : new TextDecoder().decode(input.payload);
  return JSON.parse(text) as WebhookEvent;
}

function header(headers: WebhookVerifyInput["headers"], name: string): string | null {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name);
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    return Array.isArray(value) ? value[0] ?? null : value ?? null;
  }
  return null;
}

function hexBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (value.length !== 64 || !/^[0-9a-f]+$/i.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) bytes[index] = parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function subtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new TypeError("Web Crypto (globalThis.crypto.subtle) is required to verify webhooks");
  return subtle;
}
