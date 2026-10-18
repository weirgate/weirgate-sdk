import { describe, expect, it } from "vitest";
import {
  WEBHOOK_EVENT_TYPES,
  WebhookSignatureError,
  constructWebhookEvent,
  isWebhookEventType,
  verifyWebhookSignature,
  type WebhookEventType,
} from "../src/index.js";
// Signed by the server's own webhookSignature() (fixtures/webhooks/record.mts).
import vector from "../../fixtures/webhooks/signature-v1.json" with { type: "json" };

const now = new Date(vector.timestamp * 1000);
const headers = { "Weirgate-Timestamp": String(vector.timestamp), "Weirgate-Signature": vector.signature };

async function failure(promise: Promise<unknown>): Promise<WebhookSignatureError> {
  const caught = await promise.then(() => null, (error: unknown) => error);
  expect(caught).toBeInstanceOf(WebhookSignatureError);
  return caught as WebhookSignatureError;
}

describe("webhook signatures", () => {
  it("verifies the server's own signature over timestamp.body", async () => {
    await expect(verifyWebhookSignature({ payload: vector.body, headers, secret: vector.secret, now })).resolves.toBeUndefined();
    // Bytes, a Headers object, lowercase names, and a timestamp inside the tolerance.
    await expect(verifyWebhookSignature({
      payload: new TextEncoder().encode(vector.body),
      headers: new Headers({ "weirgate-timestamp": String(vector.timestamp), "weirgate-signature": vector.signature }),
      secret: vector.secret,
      now: new Date((vector.timestamp + 299) * 1000),
    })).resolves.toBeUndefined();
  });

  it("returns the parsed event, including the new event types", async () => {
    const event = await constructWebhookEvent({ payload: vector.body, headers, secret: vector.secret, now });
    expect(event).toMatchObject({ id: "evt_test_1", type: "user_key.rejected", data: { reason: "out_of_credit" } });
    expect(isWebhookEventType(event.type)).toBe(true);
  });

  it("rejects a changed body, a wrong secret, and a bad signature", async () => {
    expect((await failure(verifyWebhookSignature({ payload: `${vector.body} `, headers, secret: vector.secret, now }))).reason)
      .toBe("signature_mismatch");
    expect((await failure(verifyWebhookSignature({ payload: vector.body, headers, secret: `${vector.secret}x`, now }))).reason)
      .toBe("signature_mismatch");
    const flipped = vector.signature.slice(0, -1) + (vector.signature.endsWith("0") ? "1" : "0");
    expect((await failure(verifyWebhookSignature({
      payload: vector.body, headers: { ...headers, "Weirgate-Signature": flipped }, secret: vector.secret, now,
    }))).reason).toBe("signature_mismatch");
    expect((await failure(verifyWebhookSignature({
      payload: vector.body, headers: { ...headers, "Weirgate-Signature": vector.signature.slice(3) }, secret: vector.secret, now,
    }))).reason).toBe("invalid_signature_format");
  });

  it("signs the timestamp: a different timestamp header fails", async () => {
    const shifted = { ...headers, "Weirgate-Timestamp": String(vector.timestamp + 1) };
    expect((await failure(verifyWebhookSignature({ payload: vector.body, headers: shifted, secret: vector.secret, now }))).reason)
      .toBe("signature_mismatch");
  });

  it("rejects old, future, missing, and malformed timestamps", async () => {
    const late = new Date((vector.timestamp + 301) * 1000);
    expect((await failure(verifyWebhookSignature({ payload: vector.body, headers, secret: vector.secret, now: late }))).reason)
      .toBe("timestamp_out_of_tolerance");
    const early = new Date((vector.timestamp - 301) * 1000);
    expect((await failure(verifyWebhookSignature({ payload: vector.body, headers, secret: vector.secret, now: early }))).reason)
      .toBe("timestamp_out_of_tolerance");
    await expect(verifyWebhookSignature({ payload: vector.body, headers, secret: vector.secret, now: late, toleranceSeconds: 600 }))
      .resolves.toBeUndefined();
    expect((await failure(verifyWebhookSignature({
      payload: vector.body, headers: { "Weirgate-Signature": vector.signature }, secret: vector.secret, now,
    }))).reason).toBe("missing_header");
    expect((await failure(verifyWebhookSignature({
      payload: vector.body, headers: { ...headers, "Weirgate-Timestamp": "1.5e9" }, secret: vector.secret, now,
    }))).reason).toBe("invalid_timestamp");
  });

  it("lists every event type in the spec", () => {
    type Missing = Exclude<WebhookEventType, (typeof WEBHOOK_EVENT_TYPES)[number]>;
    const complete: [Missing] extends [never] ? true : false = true;
    expect(complete).toBe(true);
    for (const type of [
      "provider.credit_low", "provider.credit_exhausted", "provider.credit_restored",
      "user_key.rejected", "platform.allowance_warning", "platform.allowance_exhausted",
    ]) expect(WEBHOOK_EVENT_TYPES).toContain(type);
    expect(isWebhookEventType("future.event")).toBe(false);
  });
});
