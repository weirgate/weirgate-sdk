// The server contract of weirgate#245, #246, and #247 (2026-10-18): new error types,
// Retry-After, user_provider_key_invalid reasons, user status, and the capped users total.
import { describe, expect, it, vi } from "vitest";
import {
  API_VERSION,
  BudgetExhaustedError,
  DeveloperCreditExhaustedError,
  ERROR_TYPES,
  NO_PAYWALL_ERROR_TYPES,
  PlatformAllowanceExhaustedError,
  ProviderRateLimitedError,
  UserProviderKeyInvalidError,
  Weirgate,
  WeirgateError,
  parseRetryAfter,
  type UserStatus,
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

function errorResponse(type: string, status: number, detail: Record<string, unknown>, headers: Record<string, string> = {}) {
  return jsonResponse(
    { error: { type, message: `${type} message`, request_id: "req_body", detail } },
    { status, headers: { "X-Weirgate-Error-Type": type, ...headers } },
  );
}

async function chatError(response: Response): Promise<WeirgateError> {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
  const client = new Weirgate({ appId: "example-app", token: "jwt", fetch: fetcher });
  return await client.chat("assistant", { messages: [{ role: "user", content: "hi" }] })
    .catch((caught: unknown) => caught) as WeirgateError;
}

describe("error types added 2026-10-18", () => {
  it("knows the four new types instead of reporting them as unrecognized", () => {
    for (const type of ["developer_credit_exhausted", "provider_rate_limited", "platform_allowance_exhausted", "budget_exhausted"]) {
      expect(ERROR_TYPES).toContain(type);
    }
    expect([...NO_PAYWALL_ERROR_TYPES].sort()).toEqual(
      ["budget_exhausted", "developer_credit_exhausted", "platform_allowance_exhausted", "provider_rate_limited"],
    );
  });

  it("types developer_credit_exhausted (503) as never-paywall with provider and next rail", async () => {
    const error = await chatError(errorResponse("developer_credit_exhausted", 503, {
      rail: "developer", reason: "credit_exhausted", provider: "openrouter", next_rail: "user_key",
    }));
    expect(error).toBeInstanceOf(DeveloperCreditExhaustedError);
    expect(error).toMatchObject({
      type: "developer_credit_exhausted", status: 503, provider: "openrouter", nextRail: "user_key",
      mustNotShowPaywall: true, retryAfter: null,
    });
  });

  it("types provider_rate_limited (503) and reads Retry-After as seconds or an HTTP date", async () => {
    const seconds = await chatError(errorResponse("provider_rate_limited", 503, { rail: "developer", provider: "openai" }, { "Retry-After": "12" }));
    expect(seconds).toBeInstanceOf(ProviderRateLimitedError);
    expect(seconds).toMatchObject({ type: "provider_rate_limited", provider: "openai", rail: "developer", retryAfter: 12, mustNotShowPaywall: true });

    const at = new Date(Date.now() + 30_000).toUTCString();
    const dated = await chatError(errorResponse("provider_rate_limited", 503, {}, { "Retry-After": at }));
    expect(dated.retryAfter).toBeGreaterThanOrEqual(28);
    expect(dated.retryAfter).toBeLessThanOrEqual(31);
  });

  it("types platform_allowance_exhausted (429) as temporarily unavailable with the reset", async () => {
    const error = await chatError(errorResponse("platform_allowance_exhausted", 429, {
      tier: "free", meter: "calls", used: 1000, included: 1000, period: "2026-10",
      resets_at: "2026-11-01T00:00:00.000Z", upgrade_required: true,
    }, { "Retry-After": "86400" }));
    expect(error).toBeInstanceOf(PlatformAllowanceExhaustedError);
    expect(error).toMatchObject({
      type: "platform_allowance_exhausted", status: 429, tier: "free", meter: "calls",
      resetsAt: "2026-11-01T00:00:00.000Z", retryAfter: 86400, mustNotShowPaywall: true,
    });
  });

  it("types budget_exhausted (429) instead of unrecognized", async () => {
    const error = await chatError(errorResponse("budget_exhausted", 429, {
      period: "month", cap_usd: 50, spent_usd: 50.2, resets_at: "2026-11-01T00:00:00.000Z",
    }, { "Retry-After": "3600" }));
    expect(error).toBeInstanceOf(BudgetExhaustedError);
    expect(error).toMatchObject({
      type: "budget_exhausted", rawType: "budget_exhausted", period: "month",
      resetsAt: "2026-11-01T00:00:00.000Z", retryAfter: 3600, mustNotShowPaywall: true,
    });
  });

  it("keeps paywall-eligible types paywall-eligible", async () => {
    const error = await chatError(errorResponse("out_of_allowance", 402, {}));
    expect(error.mustNotShowPaywall).toBe(false);
  });

  it("exposes detail.reason on user_provider_key_invalid", async () => {
    const invalid = await chatError(errorResponse("user_provider_key_invalid", 422, { rail: "user_key", reason: "invalid", provider: "openai" }));
    expect(invalid).toBeInstanceOf(UserProviderKeyInvalidError);
    expect(invalid).toMatchObject({ reason: "invalid", provider: "openai", rail: "user_key", mustNotShowPaywall: false });
    const empty = await chatError(errorResponse("user_provider_key_invalid", 422, { rail: "user_key", reason: "out_of_credit", provider: "openrouter" }));
    expect((empty as UserProviderKeyInvalidError).reason).toBe("out_of_credit");
  });

  it("parses Retry-After forms", () => {
    const now = Date.parse("2026-10-18T12:00:00Z");
    expect(parseRetryAfter("120", now)).toBe(120);
    expect(parseRetryAfter(" 0 ", now)).toBe(0);
    expect(parseRetryAfter("Sun, 18 Oct 2026 12:01:30 GMT", now)).toBe(90);
    expect(parseRetryAfter("Sun, 18 Oct 2026 11:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("-5", now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });
});

const status: UserStatus = {
  state: "blocked",
  checked_at: "2026-10-18T12:00:00.000Z",
  reasons: [{
    type: "out_of_allowance", active: true, detail: { feature_id: "assistant" },
    since: "2026-10-18T11:00:00.000Z", until: "2026-11-01T00:00:00.000Z", request_id: null,
  }],
};

describe("user status and the users listing", () => {
  it("reads GET /v1/admin/apps/{app}/users/{external_id}/status with the admin key", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(status));
    const client = new Weirgate({ adminKey: "wgk_usage", fetch: fetcher });

    const result = await client.getUserStatus("example-app", "user/1");

    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.weirgate.com/v1/admin/apps/example-app/users/user%2F1/status");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-admin-key")).toBe("wgk_usage");
    expect(headers.has("x-idempotency-key")).toBe(false);
    expect(result.data.state).toBe("blocked");
    expect(result.data.reasons[0]).toMatchObject({ type: "out_of_allowance", active: true });
  });

  it("exposes status on the user read", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      user: {}, status, balance: { available: 0, pending: 0, unlimited: false, unlimited_until: null, allowance_available: 0, purchased_available: 0 },
      grants: [], adjustments: [], tier_changes: [], tier_source: "manual", subscriptions: [],
      recent_events: [], recent_events_pagination: { limit: 50, returned: 0, truncated: false },
    }));
    const client = new Weirgate({ adminKey: "wgk_usage", fetch: fetcher });

    const credits = (await client.getUserCredits("example-app", "u1")).data;
    const fromRead: UserStatus = credits.status;
    expect(fromRead).toEqual(status);
  });

  it("lists users with filters and surfaces the capped total", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      data: [],
      pagination: { limit: 50, returned: 50, truncated: true, next_cursor: "cur_2", total: 10_000, total_capped: true },
    }));
    const client = new Weirgate({ adminKey: "wgk_usage", fetch: fetcher });

    const page = await client.listUsers("example-app", {
      limit: 50, q: "user-", tier: "pro", balanceLt: 0, outOfAllowance: true,
      activeSince: new Date("2026-10-01T00:00:00.000Z"), paying: false, sort: "spend", direction: "asc", cursor: "cur_1",
    });

    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/v1/admin/apps/example-app/users");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      cursor: "cur_1", limit: "50", q: "user-", tier: "pro", balance_lt: "0", out_of_allowance: "true",
      active_since: "2026-10-01T00:00:00.000Z", paying: "false", sort: "spend", direction: "asc",
    });
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("x-admin-key")).toBe("wgk_usage");
    expect(page.data.pagination).toMatchObject({ total: 10_000, total_capped: true, next_cursor: "cur_2" });
  });
});

describe("usage grouping", () => {
  it("sends every group_by value the spec allows", async () => {
    const groupBys = ["feature", "user", "model", "funding_rail", "refusal_code"] as const;
    type SpecGroupBy = NonNullable<NonNullable<import("../src/generated/schema.js").operations["getUsage"]["parameters"]["query"]>["group_by"]>;
    type Missing = Exclude<SpecGroupBy, (typeof groupBys)[number]>;
    const complete: [Missing] extends [never] ? true : false = true;
    expect(complete).toBe(true);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({}));
    const client = new Weirgate({ adminKey: "wgk_usage", fetch: fetcher });
    for (const groupBy of groupBys) await client.usage("example-app", { groupBy });
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).searchParams.get("group_by"))).toEqual([...groupBys]);
  });
});
