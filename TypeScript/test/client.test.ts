import { describe, expect, it, vi } from "vitest";
import {
  API_VERSION,
  ERROR_TYPES,
  type ErrorType,
  InsufficientBalanceError,
  ResourceConflictError,
  UsageTruncatedError,
  Weirgate,
  WeirgateError,
  WeirgateStreamError,
} from "../src/index.js";

const responseHeaders = {
  "Weirgate-Api-Version": API_VERSION,
  "X-Weirgate-Request-Id": "req_12345678",
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    ...init,
    headers: { "Content-Type": "application/json", ...responseHeaders, ...init.headers },
  });
}

describe("Weirgate", () => {
  it("adds idempotency keys to mutations and honors an override", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: "one", object: "chat.completion", choices: [] }))
      .mockResolvedValueOnce(jsonResponse({ id: "two", object: "chat.completion", choices: [] }));
    const client = new Weirgate({ appId: "wyvo", token: "jwt", fetch: fetcher });

    await client.chat("coach-chat", { messages: [{ role: "user", content: "hi" }] });
    await client.chat(
      "coach-chat",
      { messages: [{ role: "user", content: "again" }] },
      { idempotencyKey: "caller-key" },
    );

    const firstHeaders = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    const secondHeaders = new Headers(fetcher.mock.calls[1]?.[1]?.headers);
    expect(firstHeaders.get("x-idempotency-key")).toBeTruthy();
    expect(secondHeaders.get("x-idempotency-key")).toBe("caller-key");
    expect(firstHeaders.get("x-app-id")).toBe("wyvo");
    expect(firstHeaders.get("x-feature-id")).toBe("coach-chat");
  });

  it("keys errors on the enumerable registry and carries correlation metadata", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      error: { type: "out_of_allowance", message: "copy may change", request_id: "req_body" },
    }, {
      status: 402,
      headers: { "X-Weirgate-Error-Type": "out_of_allowance" },
    }));
    const client = new Weirgate({ appId: "wyvo", token: "jwt", fetch: fetcher });

    const error = await client.balance().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WeirgateError);
    expect(error).toMatchObject({
      type: "out_of_allowance",
      status: 402,
      requestId: "req_12345678",
      apiVersion: API_VERSION,
    });
    expect(ERROR_TYPES).toContain((error as WeirgateError).type);
  });

  it("deletes only the bearer-authenticated account with no caller-selected identity", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      deleted: true,
      idempotent: false,
      user_id: "internal-user",
      anonymized_at: "2026-08-16T18:00:00.000Z",
    }));
    const client = new Weirgate({ appId: "wyvo", token: "fresh-jwt", fetch: fetcher });

    const result = await client.deleteAccount();

    expect(result.data).toMatchObject({ deleted: true, idempotent: false, user_id: "internal-user" });
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.weirgate.com/v1/account");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "DELETE" });
    expect(fetcher.mock.calls[0]?.[1]?.body).toBeUndefined();
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer fresh-jwt");
    expect(headers.get("x-app-id")).toBe("wyvo");
    expect(headers.get("x-admin-key")).toBeNull();
    expect(headers.get("x-idempotency-key")).toBeTruthy();
  });

  it("decodes a mixed catalog and treats 304 as a cache result", async () => {
    const mixedCatalog = {
      catalog_version: "cat_1_0123456789abcdef",
      data: [
        {
          feature_id: "coach-chat",
          modality: "chat",
          key_policy: "developer",
          display_label: "WyVo AI",
          availability: { available: true, reason: null },
          provider_policy: { effective_state: "allowed" },
        },
        {
          feature_id: "coach-chat-openai-gpt",
          modality: "chat",
          key_policy: "user",
          display_label: "GPT",
          availability: { available: true, reason: null },
          provider_policy: { effective_state: "allowed" },
          provider: "openai",
          model: "gpt",
        },
      ],
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(mixedCatalog, { headers: { ETag: '"catalog-1"' } }))
      .mockResolvedValueOnce(new Response(null, {
        status: 304,
        headers: { ...responseHeaders, ETag: '"catalog-1"' },
      }));
    const client = new Weirgate({ appId: "wyvo", token: "jwt", fetch: fetcher });

    const first = await client.features();
    expect(first.kind).toBe("modified");
    if (first.kind === "modified") expect(first.data.data[0]?.model).toBeUndefined();
    const cached = await client.features('"catalog-1"');
    expect(cached).toMatchObject({ kind: "not_modified", etag: '"catalog-1"' });
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("if-none-match")).toBe('"catalog-1"');
  });

  it("streams chunks and enforces final usage, finish reason, and DONE", async () => {
    const sse = [
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hi"}}]}',
      "",
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(sse, {
      headers: { ...responseHeaders, "Content-Type": "text/event-stream", "X-Credits-Remaining": "9" },
    }));
    const client = new Weirgate({ appId: "wyvo", token: "jwt", fetch: fetcher });

    const stream = await client.streamChat("coach-chat", { messages: [{ role: "user", content: "hello" }] });
    const chunks = [];
    for await (const chunk of stream.chunks) chunks.push(chunk);
    expect(chunks).toHaveLength(2);
    expect(stream).toMatchObject({ requestId: "req_12345678", apiVersion: API_VERSION, creditsRemaining: 9 });
  });

  it("reports a premature stream without inventing usage", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"delta":{"content":"partial"}}]}\n\n',
      { headers: { ...responseHeaders, "Content-Type": "text/event-stream" } },
    ));
    const client = new Weirgate({ appId: "wyvo", token: "jwt", fetch: fetcher });
    const stream = await client.streamChat("coach-chat", { messages: [{ role: "user", content: "hello" }] });

    const consume = async () => {
      for await (const _ of stream.chunks) { /* consume */ }
    };
    const error = await consume().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WeirgateStreamError);
    expect(error).toMatchObject({ reason: "interrupted", requestId: "req_12345678" });
  });

  it("reports a valid JSON frame without choices as an invalid frame", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      'data: {"id":"c1","object":"chat.completion.chunk"}\n\n',
      { headers: { ...responseHeaders, "Content-Type": "text/event-stream" } },
    ));
    const client = new Weirgate({ appId: "wyvo", token: "jwt", fetch: fetcher });
    const stream = await client.streamChat("coach-chat", { messages: [{ role: "user", content: "hello" }] });

    const consume = async () => {
      for await (const _ of stream.chunks) { /* consume */ }
    };
    const error = await consume().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WeirgateStreamError);
    expect(error).toMatchObject({ reason: "invalid_frame", requestId: "req_12345678" });
  });

  it("makes usage truncation impossible to ignore in completeUsage", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      group_by: "feature",
      window_events: 600,
      window: { since: null, until: null },
      pagination: { limit: 500, returned: 500, truncated: true },
      groups: [],
    }));
    const client = new Weirgate({ adminKey: "wgk_test", fetch: fetcher });

    const error = await client.completeUsage("wyvo").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UsageTruncatedError);
    expect(error).toMatchObject({ limit: 500, returned: 500, requestId: "req_12345678" });
  });

  it("assigns and reverts user tiers with encoded identities and stable retry keys", async () => {
    const tierResult = {
      user: {}, tier_change: {}, top_up_grant: null,
      balance: { available: 0, pending: 0 }, idempotent: false,
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(tierResult))
      .mockResolvedValueOnce(jsonResponse(tierResult));
    const client = new Weirgate({ adminKey: "wgk_test", fetch: fetcher });

    await client.assignUserTier("wyvo", "person/one", {
      tier: "early-adopter", top_up_now: true,
    }, { idempotencyKey: "tier-assign-1" });
    await client.revertUserTier("wyvo", "person/one", {}, { idempotencyKey: "tier-revert-1" });

    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.weirgate.com/v1/admin/apps/wyvo/users/person%2Fone/tier");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ tier: "early-adopter", top_up_now: true }),
    });
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE", body: "{}" });
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("x-admin-key")).toBe("wgk_test");
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("x-idempotency-key")).toBe("tier-assign-1");
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("x-idempotency-key")).toBe("tier-revert-1");
  });

  it("sends the tier assignment end date as RFC 3339", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({}));
    const client = new Weirgate({ adminKey: "wgk_test", fetch: fetcher });

    await client.assignUserTier("wyvo", "u1", {
      tier: "early_adopter", expires_at: new Date("2027-03-31T23:59:59Z"),
    }, { idempotencyKey: "ea-u1" });
    await client.assignUserTier("wyvo", "u1", { tier: "pro" }, { idempotencyKey: "pro-u1" });

    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ tier: "early_adopter", expires_at: "2027-03-31T23:59:59.000Z" }),
    );
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ tier: "pro" }));
  });
});

describe("credits API", () => {
  const userBalance = { available: 100, pending: 0, unlimited: false, unlimited_until: null };

  it("grants, reverses, and adjusts with the caller's idempotency key on encoded routes", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({}));
    const client = new Weirgate({ adminKey: "wgk_credits", fetch: fetcher });

    await client.createGrant("wyvo", "person/one", { units: 100, source: "stripe:cs_1" }, {
      idempotencyKey: "stripe:cs_1",
    });
    await client.reverseGrant("wyvo", "grant/1", { idempotencyKey: "stripe:re_1" });
    await client.adjustCredits("wyvo", "person/one", {
      units: -40, reason: "clawback", source: "stripe:re_2",
    }, { idempotencyKey: "stripe:re_2" });

    const [grant, reverse, adjust] = fetcher.mock.calls;
    expect(grant?.[0]).toBe("https://api.weirgate.com/v1/admin/apps/wyvo/users/person%2Fone/grants");
    expect(grant?.[1]).toMatchObject({ method: "POST", body: JSON.stringify({ units: 100, source: "stripe:cs_1" }) });
    expect(reverse?.[0]).toBe("https://api.weirgate.com/v1/admin/apps/wyvo/grants/grant%2F1/reverse");
    expect(reverse?.[1]?.body).toBeUndefined();
    expect(adjust?.[0]).toBe("https://api.weirgate.com/v1/admin/apps/wyvo/users/person%2Fone/adjustments");
    expect(adjust?.[1]?.body).toBe(JSON.stringify({ units: -40, reason: "clawback", source: "stripe:re_2" }));
    const keys = fetcher.mock.calls.map((call) => new Headers(call[1]?.headers));
    expect(keys.map((headers) => headers.get("x-idempotency-key"))).toEqual(["stripe:cs_1", "stripe:re_1", "stripe:re_2"]);
    for (const headers of keys) {
      expect(headers.get("x-admin-key")).toBe("wgk_credits");
      expect(headers.get("x-idempotency-mode")).toBeNull();
      expect(headers.get("authorization")).toBeNull();
    }
  });

  it("refuses credit writes without an idempotency key instead of generating one", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new Weirgate({ adminKey: "wgk_credits", fetch: fetcher });
    const untyped = client as unknown as {
      createGrant(...args: unknown[]): Promise<unknown>;
      reverseGrant(...args: unknown[]): Promise<unknown>;
      adjustCredits(...args: unknown[]): Promise<unknown>;
    };

    const attempts = [
      untyped.createGrant("wyvo", "u1", { units: 1 }, {}),
      untyped.createGrant("wyvo", "u1", { units: 1 }, { idempotencyKey: "  " }),
      untyped.reverseGrant("wyvo", "g1", undefined),
      untyped.adjustCredits("wyvo", "u1", { units: 1, reason: "manual" }, { idempotencyKey: "" }),
    ];
    for (const attempt of attempts) await expect(attempt).rejects.toThrow(/idempotencyKey is required/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reads one user's credits, including unlimited state", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      user: {}, balance: { ...userBalance, unlimited: true, unlimited_until: "2027-03-31T23:59:59.000Z" },
      grants: [], adjustments: [], tier_changes: [], recent_events: [],
      recent_events_pagination: { limit: 50, returned: 0, truncated: false },
    }));
    const client = new Weirgate({ adminKey: "wgk_credits", fetch: fetcher });

    const result = await client.getUserCredits("wyvo", "person/one");

    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.weirgate.com/v1/admin/apps/wyvo/users/person%2Fone");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("x-idempotency-key")).toBeNull();
    expect(result.data.balance).toMatchObject({ unlimited: true, unlimited_until: "2027-03-31T23:59:59.000Z" });
  });

  it("types a below-zero deduction as InsufficientBalanceError", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      error: {
        type: "insufficient_balance",
        message: "adjustment would take the balance below zero",
        request_id: "req_body",
        detail: { available: 30, units: -40 },
      },
    }, { status: 402, headers: { "X-Weirgate-Error-Type": "insufficient_balance" } }));
    const client = new Weirgate({ adminKey: "wgk_credits", fetch: fetcher });

    const error = await client.adjustCredits("wyvo", "u1", { units: -40, reason: "manual" }, {
      idempotencyKey: "manual-1",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InsufficientBalanceError);
    expect(error).toBeInstanceOf(WeirgateError);
    expect(error).toMatchObject({ type: "insufficient_balance", status: 402, available: 30, units: -40 });
  });

  it("types idempotency drift as ResourceConflictError", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      error: { type: "resource_conflict", message: "different grant", request_id: "req_body" },
    }, { status: 409, headers: { "X-Weirgate-Error-Type": "resource_conflict" } }));
    const client = new Weirgate({ adminKey: "wgk_credits", fetch: fetcher });

    const error = await client.createGrant("wyvo", "u1", { units: 300 }, { idempotencyKey: "stripe:cs_1" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ResourceConflictError);
    expect(error).toMatchObject({ type: "resource_conflict", status: 409, replacedByKeyId: null });
  });

  it("rotates a key with an overlap and reports the replacement on a second rotation", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: "key_new", value: "wgk_new", previous_key: { id: "key_old" } }, {
        status: 201,
      }))
      .mockResolvedValueOnce(jsonResponse({
        error: {
          type: "resource_conflict",
          message: "key was already rotated",
          request_id: "req_body",
          detail: { replaced_by_key_id: "key_new" },
        },
      }, { status: 409, headers: { "X-Weirgate-Error-Type": "resource_conflict" } }));
    const client = new Weirgate({ adminKey: "wgk_keys", fetch: fetcher });

    const rotated = await client.rotateAdminKey("key_old", { overlap_seconds: 3600 }, { tenantId: "tao" });
    const again = await client.rotateAdminKey("key_old").catch((caught: unknown) => caught);

    expect(rotated).toMatchObject({ status: 201, data: { value: "wgk_new", previous_key: { id: "key_old" } } });
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.weirgate.com/v1/admin/keys/key_old/rotate?tenant_id=tao");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST", body: JSON.stringify({ overlap_seconds: 3600 }) });
    expect(fetcher.mock.calls[1]?.[0]).toBe("https://api.weirgate.com/v1/admin/keys/key_old/rotate");
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe("{}");
    expect(again).toBeInstanceOf(ResourceConflictError);
    expect(again).toMatchObject({ replacedByKeyId: "key_new" });
  });

  it("lists every error type in the spec", () => {
    type Missing = Exclude<ErrorType, (typeof ERROR_TYPES)[number]>;
    const complete: [Missing] extends [never] ? true : false = true;
    expect(complete).toBe(true);
    expect(ERROR_TYPES).toContain("insufficient_balance");
  });
});
