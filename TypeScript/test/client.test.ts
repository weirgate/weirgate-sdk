import { describe, expect, it, vi } from "vitest";
import {
  API_VERSION,
  ERROR_TYPES,
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
});
