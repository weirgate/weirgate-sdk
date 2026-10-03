// Records real Weirgate responses for the SDK's funding-rail test fixtures. Runs an unmodified
// weirgate checkout in-process; OpenAI is stubbed with that repo's own recorded fixtures of
// OpenAI's documented plan-usage shapes (no plan-usage sandbox exists before partner approval).
// Not part of either SDK package. Usage, from the weirgate checkout:
//   node_modules/.bin/tsx ../weirgate-sdk/fixtures/funding-rails/record.mts out.json
import { readFileSync, writeFileSync } from "node:fs";
const W = process.env.WEIRGATE_DIR ?? process.cwd();
const { createApp } = await import(`${W}/src/app.ts`);
const { ConfigSchema } = await import(`${W}/src/config/schema.ts`);
const { InMemoryStore } = await import(`${W}/src/money-plane/store.ts`);
const { encryptProviderKey } = await import(`${W}/src/security/tenant-keys.ts`);
const { OPENAI_PLAN_MODELS_URL, OPENAI_PLAN_RESPONSES_URL, clearPlanCatalogCache } = await import(`${W}/src/request-plane/upstream/openai-plan.ts`);

const fixture = (name: string) => readFileSync(`${W}/test/fixtures/${name}`, "utf8");
const baseApp = { name: "Example App", auth: { mode: "dev" }, default_tier: "free", tiers: { free: { monthly_allowance_units: 5 } } };
const config = ConfigSchema.parse({
  tenants: [{
    tenant_id: "tenant-example",
    apps: [
      {
        ...baseApp,
        app_id: "example-app",
        funding_providers: { openai_chatgpt: { status: "approved", client_id: "cid" } },
        features: {
          "assistant": { model: "mock/pd", mode: "live", display_label: "Assistant", funding: { order: ["user_plan", "developer"], user_plan: { model: "gpt-plan-pro" } } },
          "assistant-stop": { model: "mock/ps", mode: "live", display_label: "Strict", funding: { order: ["user_plan", "developer"], user_plan: { model: "gpt-plan-pro" }, on_refusal: { plan_limit_exceeded: "stop" } } },
          "summaries": { model: "mock/dev", display_label: "Summaries", key_policy: "developer" },
        },
      },
      {
        ...baseApp,
        app_id: "pending-app",
        funding_providers: { openai_chatgpt: { status: "pending_approval" } },
        features: { "assistant": { model: "mock/live", mode: "live", funding: { order: ["user_plan", "developer"] } } },
      },
    ],
  }],
});

const store = new InMemoryStore();
await store.upsertTenant("tenant-example", "Example");
await store.upsertTenantProviderKey({
  tenantId: "tenant-example", provider: "openrouter", label: "test",
  keyCiphertext: await encryptProviderKey("sk-developer", "master", "tenant-example", "openrouter"),
});
const app = createApp({ config, store, defaultMode: "mock", keyEncryptionKey: "master" });

let script: Array<() => Response> = [];
const catalog = () => Response.json({ models: [{ slug: "gpt-plan-pro", visibility: "list" }] });
const planError = (status: number, code: string) =>
  new Response(JSON.stringify({ error: { code, message: "refused" } }), { status, headers: { "x-request-id": "oai-req-123" } });
const planStream = (name = "openai-responses-plan-stream.sse") =>
  new Response(fixture(name), { headers: { "Content-Type": "text/event-stream", "x-request-id": "oai-req-123" } });
globalThis.fetch = (async (url: string) => {
  if (url === OPENAI_PLAN_MODELS_URL) return catalog();
  if (url === "https://openrouter.ai/api/v1/chat/completions") return Response.json({
    id: "or-dev", object: "chat.completion", model: "mock/routed",
    choices: [{ index: 0, message: { role: "assistant", content: "developer paid" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost: 0.0002 },
  });
  if (url !== OPENAI_PLAN_RESPONSES_URL) throw new Error(`unexpected ${url}`);
  const next = script.shift();
  if (!next) throw new Error("script exhausted");
  return next();
}) as typeof fetch;

const keep = /^(content-type|weirgate-api-version|x-weirgate-|x-credits-remaining|retry-after)/i;
const recorded: Record<string, unknown> = {};
async function rec(name: string, opts: { app?: string; feature?: string; method?: string; path?: string; credential?: string; funding?: string; key?: string; stream?: boolean; user?: string }, plan: Array<() => Response> = []) {
  script = plan;
  clearPlanCatalogCache();
  const method = opts.method ?? "POST";
  const headers: Record<string, string> = {
    Authorization: `Bearer dev:${opts.user ?? "u1"}`,
    "X-App-Id": opts.app ?? "example-app",
    ...(method === "POST" ? { "X-Feature-Id": opts.feature ?? "assistant", "Content-Type": "application/json" } : {}),
    ...(opts.credential ? { "X-Weirgate-User-Credential": opts.credential } : {}),
    ...(opts.funding ? { "X-Weirgate-Funding": opts.funding } : {}),
    ...(opts.key ? { "X-Idempotency-Key": opts.key } : {}),
  };
  const res = await app.request(opts.path ?? "/v1/chat/completions", {
    method, headers,
    ...(method === "POST" ? { body: JSON.stringify({ messages: [{ role: "user", content: "hello" }], ...(opts.stream ? { stream: true } : {}) }) } : {}),
  });
  const h: Record<string, string> = {};
  res.headers.forEach((v: string, k: string) => { if (keep.test(k)) h[k] = v; });
  const body = await res.text();
  recorded[name] = {
    request: { method, path: opts.path ?? "/v1/chat/completions", headers: Object.fromEntries(Object.entries(headers).filter(([k]) => !/authorization/i.test(k))) },
    response: { status: res.status, headers: h, body },
  };
  await new Promise((r) => setTimeout(r, 5));
}

await rec("catalog", { method: "GET", path: "/v1/features" });
await rec("plan_success", { credential: "plan-access-token", key: "k-success" }, [() => planStream()]);
await rec("fallback_plan_limit", { credential: "plan-access-token", key: "k-limit" }, [() => planError(429, "subscription_sharing_usage_limit_exceeded")]);
await rec("fallback_disable", { credential: "plan-access-token", key: "k-disable" }, [() => planError(403, "subscription_sharing_user_not_eligible")]);
await rec("credential_expired", { credential: "stale-access-token", key: "k-expired", user: "u-exp" }, [() => planError(401, "subscription_sharing_invalid_user")]);
const before = (await store.listUsageEvents("example-app")).length;
await rec("credential_expired_retry_same_key", { credential: "fresh-access-token", key: "k-expired", user: "u-exp" }, [() => planStream()]);
const after = (await store.listUsageEvents("example-app")).length;
await rec("rail_refused_stop", { feature: "assistant-stop", credential: "plan-access-token", key: "k-stop" }, [() => planError(429, "subscription_sharing_usage_limit_exceeded")]);
await rec("rail_unavailable_not_approved", { app: "pending-app", credential: "plan-access-token", key: "k-pending" });
await rec("credential_on_developer_feature", { feature: "summaries", credential: "plan-access-token", key: "k-dev" });
await rec("stream_plan_success", { credential: "plan-access-token", key: "k-s1", stream: true }, [() => planStream()]);
await rec("stream_mid_stream_limit", { credential: "plan-access-token", key: "k-s2", stream: true }, [() => planStream("openai-responses-plan-stream-limit.sse")]);
await rec("start_at_developer", { credential: "plan-access-token", funding: "developer", key: "k-startdev" });

writeFileSync(process.argv[2]!, `${JSON.stringify({
  source: "weirgate main 25282cf, in-process, OpenAI stubbed with weirgate/test/fixtures; recorded 2026-10-03",
  ...recorded,
}, null, 2)}\n`);
console.log(JSON.stringify({ usageEventsAddedBySameKeyRetry: after - before }));
