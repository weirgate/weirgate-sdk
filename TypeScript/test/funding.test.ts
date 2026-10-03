import { describe, expect, it, vi } from "vitest";
import {
  FundingRailRefusedError,
  FundingRailUnavailableError,
  PlanReconnectRequiredError,
  UserCredentialExpiredError,
  Weirgate,
  WeirgateError,
  acceptsPlan,
  featuresAcceptingPlan,
  offersPlan,
  parseFundingHeaders,
  type FeatureCatalog,
  type FundingPreference,
  type PlanCredentialSource,
  type PlanReconnectReason,
  type PlanRefreshResult,
} from "../src/index.js";
import recorded from "../../fixtures/funding-rails/weirgate-25282cf.json" with { type: "json" };

// Funding rails v2, Phase 2. Every server response here was recorded from weirgate main
// 25282cf running in-process (fixtures/funding-rails/record.mts). OpenAI offers no
// plan-usage sandbox before partner approval, so nothing here reaches a real plan.

interface Recording { response: { status: number; headers: Record<string, string>; body: string } }
const recordings = recorded as unknown as Record<string, Recording>;

/** A recorded response, optionally with `detail.next_rail` set (allowed by the contract; the 25282cf server always sends null). */
function replay(name: string, nextRail?: string): Response {
  const { status, headers, body } = recordings[name]!.response;
  return new Response(nextRail ? body.replace('"next_rail":null', `"next_rail":"${nextRail}"`) : body, { status, headers });
}

class FakePlan implements PlanCredentialSource {
  readonly provider = "openai_chatgpt";
  refreshCalls: string[] = [];
  reconnects: PlanReconnectReason[] = [];

  constructor(public token: string | null, private refreshResults: PlanRefreshResult[] = []) {}

  async fundingAccessToken() { return this.token; }

  async refreshAccessToken(rejected: string): Promise<PlanRefreshResult> {
    this.refreshCalls.push(rejected);
    const result = this.refreshResults.shift()
      ?? { kind: "reconnect_required", reason: { kind: "refresh_rejected", oauthError: "invalid_grant" } };
    this.token = result.kind === "refreshed" ? result.accessToken : null;
    return result;
  }

  requireReconnect(reason: PlanReconnectReason) {
    this.reconnects.push(reason);
    this.token = null;
  }
}

/** Catalog GETs replay the recorded catalog; POSTs go to `post(index)`. */
function client(options: { plan?: PlanCredentialSource; fundingPreference?: FundingPreference }, post: (index: number) => Response) {
  let posts = 0;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if ((init?.method ?? "GET") === "GET") return replay("catalog");
    return post(posts++);
  });
  const weirgate = new Weirgate({
    appId: "example-app",
    token: "end-user-jwt",
    fetch: fetcher,
    ...(options.plan ? { planCredential: options.plan } : {}),
    ...(options.fundingPreference ? { fundingPreference: options.fundingPreference } : {}),
  });
  const postHeaders = () => fetcher.mock.calls
    .filter(([, init]) => init?.method === "POST")
    .map(([, init]) => new Headers(init?.headers));
  const gets = () => fetcher.mock.calls.filter(([, init]) => (init?.method ?? "GET") === "GET").length;
  return { weirgate, fetcher, postHeaders, gets };
}

const hello = { messages: [{ role: "user" as const, content: "hello" }] };

describe("catalog helpers", () => {
  const catalog = JSON.parse(recordings.catalog!.response.body) as FeatureCatalog;

  it("finds the features a plan provider can pay for", () => {
    expect(featuresAcceptingPlan(catalog, "openai_chatgpt").map((entry) => entry.feature_id)).toEqual(["assistant", "assistant-stop"]);
    expect(offersPlan(catalog, "openai_chatgpt")).toBe(true);
    expect(offersPlan(catalog, "anthropic_claude")).toBe(false);
    const summaries = catalog.data.find((entry) => entry.feature_id === "summaries")!;
    expect(acceptsPlan(summaries, "openai_chatgpt")).toBe(false);
  });

  it("treats an entry without funding (older server) as not accepting plans", () => {
    const legacy = { ...catalog.data[0]!, funding: undefined } as unknown as FeatureCatalog["data"][number];
    expect(acceptsPlan(legacy, "openai_chatgpt")).toBe(false);
  });

  it("parses the funding headers, including unknown rails", () => {
    expect(parseFundingHeaders(new Headers({ "X-Weirgate-Funding-Rail": "user_plan; provider=openai_chatgpt" })))
      .toEqual({ rail: "user_plan", provider: "openai_chatgpt", fallback: null });
    expect(parseFundingHeaders(new Headers({
      "X-Weirgate-Funding-Rail": "developer",
      "X-Weirgate-Funding-Fallback": "user_plan; reason=user_not_eligible; disable",
    }))).toEqual({
      rail: "developer",
      provider: null,
      fallback: { refusedRail: "user_plan", reason: "user_not_eligible", disable: true },
    });
    expect(parseFundingHeaders(new Headers({ "X-Weirgate-Funding-Rail": "user_wallet" }))?.rail).toBe("user_wallet");
    expect(parseFundingHeaders(new Headers())).toBeNull();
  });
});

describe("header injection", () => {
  it("sends a connected plan's token to a feature that accepts it and reports the paying rail", async () => {
    const { weirgate, postHeaders, gets } = client({ plan: new FakePlan("plan-access-token") }, () => replay("plan_success"));
    const result = await weirgate.chat("assistant", hello, { idempotencyKey: "k1" });
    const [sent] = postHeaders();
    expect(sent?.get("x-weirgate-user-credential")).toBe("plan-access-token");
    expect(sent?.get("x-weirgate-funding")).toBeNull();
    expect(sent?.get("x-idempotency-key")).toBe("k1");
    expect(result.funding).toEqual({ rail: "user_plan", provider: "openai_chatgpt", fallback: null });
    expect(gets()).toBe(1);
  });

  it("does not send the token to a feature without a plan rail", async () => {
    const { weirgate, postHeaders, gets } = client({ plan: new FakePlan("plan-access-token") }, () => replay("start_at_developer"));
    await weirgate.chat("summaries", hello);
    await weirgate.chat("summaries", hello);
    expect(postHeaders().every((headers) => !headers.has("x-weirgate-user-credential") && !headers.has("x-weirgate-funding"))).toBe(true);
    expect(gets()).toBe(1);
  });

  it("changes nothing without a plan connection", async () => {
    const { weirgate, postHeaders, gets } = client({}, () => replay("start_at_developer"));
    const result = await weirgate.chat("assistant", hello);
    expect(gets()).toBe(0);
    expect(postHeaders()[0]?.has("x-weirgate-user-credential")).toBe(false);
    expect(postHeaders()[0]?.get("x-idempotency-key")).toBeTruthy();
    expect(result.funding?.rail).toBe("developer");
  });

  it("reads no catalog when the plan is not funding", async () => {
    const { weirgate, gets, postHeaders } = client({ plan: new FakePlan(null) }, () => replay("start_at_developer"));
    await weirgate.chat("assistant", hello);
    expect(gets()).toBe(0);
    expect(postHeaders()[0]?.has("x-weirgate-user-credential")).toBe(false);
  });

  it("starts past the plan rail on request, and a per-call override wins", async () => {
    const { weirgate, postHeaders } = client(
      { plan: new FakePlan("plan-access-token"), fundingPreference: { startAt: "developer" } },
      () => replay("start_at_developer"),
    );
    await weirgate.chat("assistant", hello);
    await weirgate.chat("assistant", hello, { funding: { startAt: "user_plan" } });
    const [first, second] = postHeaders();
    expect(first?.get("x-weirgate-funding")).toBe("developer");
    expect(first?.has("x-weirgate-user-credential")).toBe(false);
    expect(second?.get("x-weirgate-funding")).toBe("user_plan; provider=openai_chatgpt");
    expect(second?.get("x-weirgate-user-credential")).toBe("plan-access-token");
  });

  it("injects into embeddings too", async () => {
    const { weirgate, postHeaders } = client({ plan: new FakePlan("plan-access-token") }, () => new Response(
      JSON.stringify({ object: "list", model: "m", data: [], usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } }),
      { headers: { ...recordings.fallback_plan_limit!.response.headers } },
    ));
    const result = await weirgate.embedding("assistant", { input: "hi" });
    expect(postHeaders()[0]?.get("x-weirgate-user-credential")).toBe("plan-access-token");
    expect(result.funding?.fallback?.reason).toBe("plan_limit_exceeded");
  });
});

describe("fallback headers", () => {
  it("reports a fallback and keeps the plan", async () => {
    const plan = new FakePlan("plan-access-token");
    const { weirgate } = client({ plan }, () => replay("fallback_plan_limit"));
    const result = await weirgate.chat("assistant", hello);
    expect(result.funding).toEqual({
      rail: "developer",
      provider: null,
      fallback: { refusedRail: "user_plan", reason: "plan_limit_exceeded", disable: false },
    });
    expect(plan.reconnects).toEqual([]);
  });

  it("disconnects the plan on a disable fallback", async () => {
    const plan = new FakePlan("plan-access-token");
    const { weirgate } = client({ plan }, () => replay("fallback_disable"));
    const result = await weirgate.chat("assistant", hello);
    expect(result.funding?.fallback?.disable).toBe(true);
    expect(plan.reconnects).toEqual([{ kind: "rail_disabled", reason: "user_not_eligible" }]);
  });
});

describe("retry rules", () => {
  it("refreshes once on user_credential_expired and retries with the same idempotency key", async () => {
    const plan = new FakePlan("stale-access-token", [{ kind: "refreshed", accessToken: "fresh-access-token" }]);
    const { weirgate, postHeaders } = client({ plan }, (index) =>
      replay(index === 0 ? "credential_expired" : "credential_expired_retry_same_key"));
    const result = await weirgate.chat("assistant", hello, { idempotencyKey: "k-expired" });
    expect(result.funding?.rail).toBe("user_plan");
    expect(plan.refreshCalls).toEqual(["stale-access-token"]);
    expect(postHeaders().map((headers) => headers.get("x-weirgate-user-credential"))).toEqual(["stale-access-token", "fresh-access-token"]);
    expect(postHeaders().map((headers) => headers.get("x-idempotency-key"))).toEqual(["k-expired", "k-expired"]);
  });

  it("clears the plan and asks to reconnect when the refreshed token is rejected too", async () => {
    const plan = new FakePlan("stale-access-token", [{ kind: "refreshed", accessToken: "fresh-access-token" }]);
    const { weirgate, postHeaders } = client({ plan }, () => replay("credential_expired"));
    const error = await weirgate.chat("assistant", hello).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlanReconnectRequiredError);
    expect((error as PlanReconnectRequiredError).reason).toEqual({ kind: "credential_rejected", providerCode: "subscription_sharing_invalid_user" });
    expect((error as PlanReconnectRequiredError).cause).toBeInstanceOf(UserCredentialExpiredError);
    expect(postHeaders()).toHaveLength(2);
    expect(plan.reconnects).toEqual([{ kind: "credential_rejected", providerCode: "subscription_sharing_invalid_user" }]);
  });

  it("surfaces reconnect when the refresh is refused (invalid_grant); the next call skips the plan", async () => {
    const plan = new FakePlan("stale-access-token", [
      { kind: "reconnect_required", reason: { kind: "refresh_rejected", oauthError: "invalid_grant" } },
    ]);
    const { weirgate, postHeaders } = client({ plan }, (index) => replay(index === 0 ? "credential_expired" : "start_at_developer"));
    const error = await weirgate.chat("assistant", hello).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "PlanReconnectRequiredError", reason: { kind: "refresh_rejected", oauthError: "invalid_grant" } });
    expect(postHeaders()).toHaveLength(1);
    const retried = await weirgate.chat("assistant", hello);
    expect(postHeaders()[1]?.has("x-weirgate-user-credential")).toBe(false);
    expect(retried.funding?.rail).toBe("developer");
  });

  it("types user_credential_expired when no plan source is configured", async () => {
    const { weirgate } = client({}, () => replay("credential_expired"));
    const error = await weirgate.chat("assistant", hello).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UserCredentialExpiredError);
    expect(error).toMatchObject({ status: 401, rail: "user_plan", providerCode: "subscription_sharing_invalid_user" });
  });

  it("retries once on next_rail with that rail's idempotency key and no plan token", async () => {
    const { weirgate, postHeaders } = client({ plan: new FakePlan("plan-access-token") }, (index) =>
      index === 0 ? replay("rail_refused_stop", "developer") : replay("start_at_developer"));
    const result = await weirgate.chat("assistant", hello, { idempotencyKey: "k-stop" });
    expect(result.funding?.rail).toBe("developer");
    const [, retry] = postHeaders();
    expect(retry?.get("x-weirgate-funding")).toBe("developer");
    expect(retry?.has("x-weirgate-user-credential")).toBe(false);
    expect(retry?.get("x-idempotency-key")).toBe("k-stop:rail:developer");
  });

  it("throws funding_rail_refused without next_rail, with the provider request ID", async () => {
    const plan = new FakePlan("plan-access-token");
    const { weirgate, postHeaders } = client({ plan }, () => replay("rail_refused_stop"));
    const error = await weirgate.chat("assistant-stop", hello, { idempotencyKey: "k-stop" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FundingRailRefusedError);
    expect(error).toBeInstanceOf(WeirgateError);
    expect(error).toMatchObject({
      status: 402,
      reason: "plan_limit_exceeded",
      nextRail: null,
      providerRequestId: "oai-req-123",
      idempotencyKey: "k-stop",
    });
    expect((error as FundingRailRefusedError).retryOptions()).toBeNull();
    expect(postHeaders()).toHaveLength(1);
    expect(plan.reconnects).toEqual([]);
  });

  it("bounds next_rail hops", async () => {
    const { weirgate, postHeaders } = client({ plan: new FakePlan("plan-access-token") }, () => replay("rail_refused_stop", "developer"));
    await expect(weirgate.chat("assistant", hello)).rejects.toBeInstanceOf(FundingRailRefusedError);
    expect(postHeaders()).toHaveLength(3);
  });

  it("does not retry funding_rail_unavailable", async () => {
    const { weirgate, postHeaders } = client({ plan: new FakePlan("plan-access-token") }, () => replay("rail_unavailable_not_approved"));
    const error = await weirgate.chat("assistant", hello).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FundingRailUnavailableError);
    expect(error).toMatchObject({ status: 403, reason: "provider_not_approved" });
    expect(postHeaders()).toHaveLength(1);
  });
});

describe("streaming", () => {
  it("completes a plan-funded stream and reports the rail", async () => {
    const { weirgate } = client({ plan: new FakePlan("plan-access-token") }, () => replay("stream_plan_success"));
    const stream = await weirgate.streamChat("assistant", hello);
    let text = "";
    for await (const chunk of stream.chunks) {
      text += chunk.choices.map((choice) => (choice["delta"] as { content?: string } | undefined)?.content ?? "").join("");
    }
    expect(text).toBe("plan-1 plan-2 plan-3");
    expect(stream.funding).toEqual({ rail: "user_plan", provider: "openai_chatgpt", fallback: null });
  });

  it.each([[undefined], ["developer"]])("throws the mid-stream error frame as a typed error (next_rail %s)", async (nextRail) => {
    const { weirgate } = client({ plan: new FakePlan("plan-access-token") }, () => replay("stream_mid_stream_limit", nextRail));
    const stream = await weirgate.streamChat("assistant", hello, { idempotencyKey: "k-s2" });
    let partial = 0;
    const error = await (async () => {
      for await (const _ of stream.chunks) partial += 1;
    })().catch((caught: unknown) => caught);
    expect(partial).toBeGreaterThan(0);
    expect(error).toBeInstanceOf(FundingRailRefusedError);
    expect(error).toMatchObject({
      status: 200,
      requestId: stream.requestId,
      reason: "plan_limit_exceeded",
      providerCode: "subscription_sharing_usage_limit_exceeded",
    });
    const retry = (error as FundingRailRefusedError).retryOptions({ idempotencyKey: "k-s2" });
    if (nextRail) expect(retry).toMatchObject({ funding: { startAt: "developer" }, idempotencyKey: "k-s2:rail:developer" });
    else expect(retry).toBeNull();
  });

  it("refreshes and retries a stream rejected before headers", async () => {
    const plan = new FakePlan("stale-access-token", [{ kind: "refreshed", accessToken: "fresh-access-token" }]);
    const { weirgate, postHeaders } = client({ plan }, (index) => replay(index === 0 ? "credential_expired" : "stream_plan_success"));
    const stream = await weirgate.streamChat("assistant", hello);
    for await (const _ of stream.chunks) { /* drain */ }
    const [first, second] = postHeaders();
    expect([first?.get("x-weirgate-user-credential"), second?.get("x-weirgate-user-credential")]).toEqual(["stale-access-token", "fresh-access-token"]);
    expect(first?.get("x-idempotency-key")).toBe(second?.get("x-idempotency-key"));
  });

  it("retries a stream refused before headers on next_rail", async () => {
    const { weirgate, postHeaders } = client({ plan: new FakePlan("plan-access-token") }, (index) =>
      index === 0 ? replay("rail_refused_stop", "developer") : replay("stream_plan_success"));
    const stream = await weirgate.streamChat("assistant", hello);
    for await (const _ of stream.chunks) { /* drain */ }
    expect(postHeaders()[1]?.get("x-weirgate-funding")).toBe("developer");
  });
});
