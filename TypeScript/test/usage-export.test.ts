// Usage export (weirgate#264, weirgate-sdk#38): GET /v1/admin/apps/{app_id}/usage/events
// and /usage/users, JSON and format=csv, following the cursor across pages.
import { describe, expect, it, vi } from "vitest";
import {
  API_VERSION,
  Weirgate,
  WeirgateError,
  WeirgateProtocolError,
  type UsageEvent,
  type UsageExportPage,
  type UsageExportRow,
  type UsageByUserRailPage,
  type UsageRollupRow,
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

function csvResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/csv; charset=utf-8", ...responseHeaders, ...headers },
  });
}

const since = "2026-10-01T00:00:00.000Z";
const until = "2026-10-02T00:00:00.000Z";

function exportRow(n: number, overrides: Partial<UsageExportRow> = {}): UsageExportRow {
  return {
    created_at: `2026-10-01T00:00:0${n}.000Z`,
    request_id: `req_0000000${n}`,
    upstream_generation_id: `gen-${n}`,
    feature_id: "assistant",
    user_id: `usr_${n}`,
    external_id: `ext-${n}`,
    funding_rail: "developer",
    upstream_provider: "openrouter",
    model: "openai/gpt-5-mini",
    prompt_tokens: 10,
    completion_tokens: 20,
    units_debited: 1,
    provider_cost_usd: 0.0001,
    user_cost_usd: null,
    latency_ms: 420,
    ...overrides,
  };
}

function exportPage(rows: UsageExportRow[], nextCursor: string | null): UsageExportPage {
  return {
    window: { since, until },
    data: rows,
    pagination: { limit: 2, returned: rows.length, truncated: nextCursor !== null, next_cursor: nextCursor },
  };
}

function rollupRow(user: string, overrides: Partial<UsageRollupRow> = {}): UsageRollupRow {
  return {
    user_id: user,
    external_id: null,
    funding_rail: "developer",
    requests: 3,
    prompt_tokens: 30,
    completion_tokens: 60,
    units: 3,
    provider_cost_usd: 0.0003,
    user_cost_usd: 0,
    cost_unreported_requests: 1,
    ...overrides,
  };
}

function rollupPage(rows: UsageRollupRow[], nextCursor: string | null): UsageByUserRailPage {
  return {
    window: { since, until },
    data: rows,
    pagination: { limit: 1000, returned: rows.length, truncated: nextCursor !== null, next_cursor: nextCursor },
  };
}

function client(...responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  return { fetcher, weirgate: new Weirgate({ adminKey: "wg_admin_test", baseUrl: "https://weirgate.test", fetch: fetcher }) };
}

function requestUrl(fetcher: ReturnType<typeof vi.fn<typeof fetch>>, call: number): URL {
  return new URL(String(fetcher.mock.calls[call]![0]));
}

function requestHeaders(fetcher: ReturnType<typeof vi.fn<typeof fetch>>, call: number): Headers {
  return new Headers(fetcher.mock.calls[call]![1]!.headers);
}

describe("exportUsageEvents (JSON)", () => {
  it("reads one page with the window, limit, and cursor as query parameters", async () => {
    const page = exportPage([exportRow(1)], "cur_2");
    const { fetcher, weirgate } = client(jsonResponse(page));
    const result = await weirgate.exportUsageEvents("my app", {
      since: new Date(since), until, limit: 2, cursor: "cur_1",
    });

    const url = requestUrl(fetcher, 0);
    expect(url.pathname).toBe("/v1/admin/apps/my%20app/usage/events");
    expect(Object.fromEntries(url.searchParams)).toEqual({ since, until, cursor: "cur_1", limit: "2" });
    expect(fetcher.mock.calls[0]![1]!.method).toBe("GET");
    expect(requestHeaders(fetcher, 0).get("x-admin-key")).toBe("wg_admin_test");
    expect(requestHeaders(fetcher, 0).get("x-idempotency-key")).toBeNull();
    expect(result.data).toEqual(page);
    expect(result.data.pagination.next_cursor).toBe("cur_2");
    expect(result.requestId).toBe("req_12345678");
  });

  it("types the upstream generation id and provider, both nullable", async () => {
    const legacy = exportRow(2, { upstream_generation_id: null, upstream_provider: null, external_id: null });
    const { weirgate } = client(jsonResponse(exportPage([exportRow(1), legacy], null)));
    const { data } = await weirgate.exportUsageEvents("app", { since, until });
    const ids: (string | null)[] = data.data.map((row) => row.upstream_generation_id);
    const providers: (string | null)[] = data.data.map((row) => row.upstream_provider);
    expect(ids).toEqual(["gen-1", null]);
    expect(providers).toEqual(["openrouter", null]);
  });

  it("requires since and until before sending", async () => {
    const { fetcher, weirgate } = client();
    await expect(weirgate.exportUsageEvents("app", { until } as never)).rejects.toThrow(/since is required/);
    await expect(weirgate.exportUsageEvents("app", { since, until: "" })).rejects.toThrow(/until is required/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("leaves non-midnight bounds and range checks to the server for the raw export", async () => {
    const { fetcher, weirgate } = client(jsonResponse(exportPage([], null)));
    await weirgate.exportUsageEvents("app", { since: "2026-10-01T12:34:56Z", until: "2026-10-01T13:00:00Z" });
    expect(requestUrl(fetcher, 0).searchParams.get("since")).toBe("2026-10-01T12:34:56Z");
  });

  it("surfaces server errors as WeirgateError", async () => {
    const { weirgate } = client(jsonResponse(
      { error: { type: "invalid_request", message: "until must be later than since", request_id: "req_body" } },
      { status: 400, headers: { "X-Weirgate-Error-Type": "invalid_request" } },
    ));
    const error = await weirgate.exportUsageEvents("app", { since: until, until: since }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WeirgateError);
    expect(error).toMatchObject({ type: "invalid_request", status: 400 });
  });

  it("needs an admin key", async () => {
    const weirgate = new Weirgate({ fetch: vi.fn<typeof fetch>() });
    await expect(weirgate.exportUsageEvents("app", { since, until })).rejects.toThrow(/adminKey is required/);
  });
});

describe("iterateUsageEvents", () => {
  it("follows next_cursor across pages with the same window and yields every row once", async () => {
    const { fetcher, weirgate } = client(
      jsonResponse(exportPage([exportRow(1), exportRow(2)], "cur_2")),
      jsonResponse(exportPage([exportRow(3), exportRow(4)], "cur_3")),
      jsonResponse(exportPage([exportRow(5)], null)),
    );
    const rows: UsageExportRow[] = [];
    for await (const row of weirgate.iterateUsageEvents("app", { since, until, limit: 2 })) rows.push(row);

    expect(rows.map((row) => row.request_id)).toEqual(
      ["req_00000001", "req_00000002", "req_00000003", "req_00000004", "req_00000005"],
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(requestUrl(fetcher, 0).searchParams.has("cursor")).toBe(false);
    expect(requestUrl(fetcher, 1).searchParams.get("cursor")).toBe("cur_2");
    expect(requestUrl(fetcher, 2).searchParams.get("cursor")).toBe("cur_3");
    for (const call of [0, 1, 2]) {
      const parameters = requestUrl(fetcher, call).searchParams;
      expect(parameters.get("since")).toBe(since);
      expect(parameters.get("until")).toBe(until);
      expect(parameters.get("limit")).toBe("2");
      expect(parameters.has("format")).toBe(false);
    }
  });

  it("stops after one empty page", async () => {
    const { fetcher, weirgate } = client(jsonResponse(exportPage([], null)));
    const rows: UsageExportRow[] = [];
    for await (const row of weirgate.iterateUsageEvents("app", { since, until })) rows.push(row);
    expect(rows).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("starts from a given cursor", async () => {
    const { fetcher, weirgate } = client(jsonResponse(exportPage([exportRow(9)], null)));
    for await (const _ of weirgate.iterateUsageEvents("app", { since, until, cursor: "resume" })) { /* drain */ }
    expect(requestUrl(fetcher, 0).searchParams.get("cursor")).toBe("resume");
  });

  it("throws instead of looping or stopping short when a truncated page has no new cursor", async () => {
    const broken = exportPage([exportRow(1)], null);
    broken.pagination.truncated = true;
    const { weirgate } = client(jsonResponse(broken));
    const drain = async () => { for await (const _ of weirgate.iterateUsageEvents("app", { since, until })) { /* drain */ } };
    await expect(drain()).rejects.toBeInstanceOf(WeirgateProtocolError);
  });

  it("stops fetching when the caller breaks early", async () => {
    const { fetcher, weirgate } = client(
      jsonResponse(exportPage([exportRow(1), exportRow(2)], "cur_2")),
      jsonResponse(exportPage([exportRow(3)], null)),
    );
    for await (const row of weirgate.iterateUsageEvents("app", { since, until })) {
      if (row.request_id === "req_00000001") break;
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

const exportHeader = "created_at,request_id,upstream_generation_id,feature_id,user_id,external_id,funding_rail,upstream_provider,model,prompt_tokens,completion_tokens,units_debited,provider_cost_usd,user_cost_usd,latency_ms";

describe("exportUsageEventsCsv and iterateUsageEventsCsv", () => {
  it("asks for format=csv and reads the paging headers", async () => {
    const body = `${exportHeader}\r\n2026-10-01T00:00:01.000Z,req_00000001,gen-1,assistant,usr_1,ext-1,developer,openrouter,openai/gpt-5-mini,10,20,1,0.0001,,420\r\n`;
    const { fetcher, weirgate } = client(csvResponse(body, {
      "X-Weirgate-Next-Cursor": "cur_2", "X-Weirgate-Truncated": "true",
    }));
    const result = await weirgate.exportUsageEventsCsv("app", { since, until, limit: 1 });

    const url = requestUrl(fetcher, 0);
    expect(url.pathname).toBe("/v1/admin/apps/app/usage/events");
    expect(url.searchParams.get("format")).toBe("csv");
    expect(url.searchParams.get("limit")).toBe("1");
    expect(requestHeaders(fetcher, 0).get("accept")).toMatch(/^text\/csv/);
    expect(result.data).toEqual({ csv: body, nextCursor: "cur_2", truncated: true });
    expect(result.data.csv.split("\r\n")[0]).toBe(exportHeader);
  });

  it("reports the last page with no cursor and truncated false", async () => {
    const { weirgate } = client(csvResponse(`${exportHeader}\r\n`, { "X-Weirgate-Truncated": "false" }));
    const { data } = await weirgate.exportUsageEventsCsv("app", { since, until });
    expect(data).toEqual({ csv: `${exportHeader}\r\n`, nextCursor: null, truncated: false });
  });

  it("rejects a 200 that is not text/csv", async () => {
    const { weirgate } = client(jsonResponse(exportPage([], null)));
    await expect(weirgate.exportUsageEventsCsv("app", { since, until })).rejects.toBeInstanceOf(WeirgateProtocolError);
  });

  it("surfaces a JSON error envelope on a CSV request", async () => {
    const { weirgate } = client(jsonResponse(
      { error: { type: "insufficient_scope", message: "needs usage", request_id: "req_body" } },
      { status: 403, headers: { "X-Weirgate-Error-Type": "insufficient_scope" } },
    ));
    const error = await weirgate.exportUsageEventsCsv("app", { since, until }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WeirgateError);
    expect(error).toMatchObject({ type: "insufficient_scope", status: 403 });
  });

  it("iterates CSV pages by the header cursor", async () => {
    const page = (row: number) => `${exportHeader}\r\nrow-${row}\r\n`;
    const { fetcher, weirgate } = client(
      csvResponse(page(1), { "X-Weirgate-Next-Cursor": "cur_2", "X-Weirgate-Truncated": "true" }),
      csvResponse(page(2), { "X-Weirgate-Next-Cursor": "cur_3", "X-Weirgate-Truncated": "true" }),
      csvResponse(page(3), { "X-Weirgate-Truncated": "false" }),
    );
    const pages: string[] = [];
    for await (const result of weirgate.iterateUsageEventsCsv("app", { since, until })) pages.push(result.data.csv);

    expect(pages).toEqual([page(1), page(2), page(3)]);
    expect(requestUrl(fetcher, 1).searchParams.get("cursor")).toBe("cur_2");
    expect(requestUrl(fetcher, 2).searchParams.get("cursor")).toBe("cur_3");
    for (const call of [0, 1, 2]) expect(requestUrl(fetcher, call).searchParams.get("format")).toBe("csv");
  });

  it("throws when a truncated CSV page has no cursor", async () => {
    const { weirgate } = client(csvResponse(`${exportHeader}\r\n`, { "X-Weirgate-Truncated": "true" }));
    const drain = async () => { for await (const _ of weirgate.iterateUsageEventsCsv("app", { since, until })) { /* drain */ } };
    await expect(drain()).rejects.toBeInstanceOf(WeirgateProtocolError);
  });
});

const rollupHeader = "user_id,external_id,funding_rail,requests,prompt_tokens,completion_tokens,units,provider_cost_usd,user_cost_usd,cost_unreported_requests";

describe("getUsageByUserRail (per-user × rail rollup)", () => {
  it("reads one JSON page from /usage/users", async () => {
    const page = rollupPage([rollupRow("usr_1"), rollupRow("usr_1", { funding_rail: "user_key", user_cost_usd: 0.002 })], null);
    const { fetcher, weirgate } = client(jsonResponse(page));
    const result = await weirgate.getUsageByUserRail("app", { since: new Date(since), until: new Date(until) });

    const url = requestUrl(fetcher, 0);
    expect(url.pathname).toBe("/v1/admin/apps/app/usage/users");
    expect(Object.fromEntries(url.searchParams)).toEqual({ since, until });
    expect(result.data).toEqual(page);
  });

  it("rejects bounds that are not UTC midnights before sending", async () => {
    const { fetcher, weirgate } = client();
    await expect(weirgate.getUsageByUserRail("app", { since: "2026-10-01T00:00:00-07:00", until }))
      .rejects.toThrow(/since must be a UTC midnight/);
    await expect(weirgate.getUsageByUserRail("app", { since, until: new Date("2026-10-02T00:00:01Z") }))
      .rejects.toThrow(/until must be a UTC midnight/);
    await expect(weirgate.getUsageByUserRailCsv("app", { since, until: "2026-10-01T23:59:59Z" }))
      .rejects.toThrow(/UTC midnight/);
    await expect(weirgate.getUsageByUserRail("app", { since } as never)).rejects.toThrow(/until is required/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("passes a UTC midnight in any spelling, and an unparseable value to the server", async () => {
    const { fetcher, weirgate } = client(jsonResponse(rollupPage([], null)), jsonResponse(rollupPage([], null)));
    await weirgate.getUsageByUserRail("app", { since: "2026-10-01T02:00:00+02:00", until: "2026-10-02T00:00:00Z" });
    expect(requestUrl(fetcher, 0).searchParams.get("since")).toBe("2026-10-01T02:00:00+02:00");
    await weirgate.getUsageByUserRail("app", { since: "yesterday", until });
    expect(requestUrl(fetcher, 1).searchParams.get("since")).toBe("yesterday");
  });

  it("iterates rows across pages", async () => {
    const { fetcher, weirgate } = client(
      jsonResponse(rollupPage([rollupRow("usr_1"), rollupRow("usr_2")], "cur_2")),
      jsonResponse(rollupPage([rollupRow("usr_3")], null)),
    );
    const users: string[] = [];
    for await (const row of weirgate.iterateUsageByUserRail("app", { since, until })) users.push(row.user_id);
    expect(users).toEqual(["usr_1", "usr_2", "usr_3"]);
    expect(requestUrl(fetcher, 1).pathname).toBe("/v1/admin/apps/app/usage/users");
    expect(requestUrl(fetcher, 1).searchParams.get("cursor")).toBe("cur_2");
  });

  it("reads and iterates CSV pages", async () => {
    const first = `${rollupHeader}\r\nusr_1,,developer,3,30,60,3,0.0003,0,1\r\n`;
    const second = `${rollupHeader}\r\nusr_2,ext-2,user_key,1,5,5,1,0,0.002,0\r\n`;
    const { fetcher, weirgate } = client(
      csvResponse(first, { "X-Weirgate-Next-Cursor": "cur_2", "X-Weirgate-Truncated": "true" }),
      csvResponse(second, { "X-Weirgate-Truncated": "false" }),
    );
    const pages = [];
    for await (const result of weirgate.iterateUsageByUserRailCsv("app", { since, until })) pages.push(result.data);
    expect(pages).toEqual([
      { csv: first, nextCursor: "cur_2", truncated: true },
      { csv: second, nextCursor: null, truncated: false },
    ]);
    expect(requestUrl(fetcher, 0).searchParams.get("format")).toBe("csv");
    expect(requestUrl(fetcher, 1).searchParams.get("cursor")).toBe("cur_2");
  });

  it("reads a single CSV page", async () => {
    const body = `${rollupHeader}\r\n`;
    const { fetcher, weirgate } = client(csvResponse(body, { "X-Weirgate-Truncated": "false" }));
    const { data } = await weirgate.getUsageByUserRailCsv("app", { since, until });
    expect(data).toEqual({ csv: body, nextCursor: null, truncated: false });
    expect(requestUrl(fetcher, 0).pathname).toBe("/v1/admin/apps/app/usage/users");
  });
});

describe("UsageEvent", () => {
  it("carries upstream_generation_id and upstream_provider", () => {
    const event = {
      upstream_generation_id: "gen-1",
      upstream_provider: "openrouter",
    } satisfies Pick<UsageEvent, "upstream_generation_id" | "upstream_provider">;
    expect(event.upstream_generation_id).toBe("gen-1");
  });
});
