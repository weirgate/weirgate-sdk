/**
 * Re-run from TypeScript/ against a mock-mode Weirgate instance:
 *
 *   export WEIRGATE_ADMIN_KEY=<mock instance admin key>
 *   WEIRGATE_MOCK_BASE_URL=http://127.0.0.1:8787 \
 *     WEIRGATE_TENANT_ID=sdk-s12 WEIRGATE_APP_ID=sdk-s12-app \
 *     WEIRGATE_FEATURE_ID=summarize WEIRGATE_END_USER_TOKEN=dev:sdk-user \
 *     npm run proof:s12
 *
 * The target must already contain the named tenant, app, and mock feature. The
 * script uses only the frozen public API: it normalizes the feature to
 * provider/model-a when needed, swaps it to provider/model-b through a config
 * proposal, calls the capability through the SDK, and verifies actual routing
 * through the correlated request-trace endpoint.
 */
import { API_VERSION, Weirgate } from "../dist/index.js";

const baseUrl = requiredEnvironment("WEIRGATE_MOCK_BASE_URL").replace(/\/$/, "");
const adminKey = requiredEnvironment("WEIRGATE_ADMIN_KEY");
const tenantId = process.env.WEIRGATE_TENANT_ID ?? "sdk-s12";
const appId = process.env.WEIRGATE_APP_ID ?? "sdk-s12-app";
const featureId = process.env.WEIRGATE_FEATURE_ID ?? "summarize";
const token = process.env.WEIRGATE_END_USER_TOKEN ?? "dev:sdk-user";
const modelA = "provider/model-a";
const modelB = "provider/model-b";

const client = new Weirgate({ baseUrl, appId, token });
const health = await client.health();
if (health.data.mode !== "mock") throw new Error("S12 proof refuses to mutate a non-mock Weirgate instance");
if (health.apiVersion !== API_VERSION) {
  throw new Error(`expected API ${API_VERSION}, received ${health.apiVersion}`);
}

let tenant = await readTenant();
if (feature(tenant).model !== modelA) {
  tenant = withModel(tenant, modelA);
  await applyTenant(tenant);
}

const before = await client.features();
if (before.kind !== "modified") throw new Error("initial catalog unexpectedly returned 304");
assertCapabilityOnly(before.data.data);

await applyTenant(withModel(await readTenant(), modelB));

const after = await client.features(before.etag ?? undefined);
if (after.kind !== "modified") throw new Error("catalog ETag did not change after model swap");
if (after.data.catalog_version === before.data.catalog_version) {
  throw new Error("catalog version did not change after model swap");
}
assertCapabilityOnly(after.data.data);

const completion = await client.chat(
  featureId,
  { messages: [{ role: "user", content: "model swap proof" }] },
  { idempotencyKey: `sdk-s12-call-${crypto.randomUUID()}` },
);
const trace = await adminJson(
  "GET",
  `/v1/admin/apps/${encodeURIComponent(appId)}/request-traces/${encodeURIComponent(completion.requestId)}`,
);
const actualModel = trace?.usage_event?.model;
if (actualModel !== modelB) throw new Error(`expected actual model ${modelB}, received ${String(actualModel)}`);

console.log(JSON.stringify({
  proof: "S12-through-@weirgate/sdk",
  mode: health.data.mode,
  feature_id: featureId,
  before_catalog: before.data.catalog_version,
  after_catalog: after.data.catalog_version,
  actual_model: actualModel,
  request_id: completion.requestId,
  api_version: completion.apiVersion,
}));

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function readTenant() {
  const config = await adminJson("GET", "/v1/admin/config");
  const found = config?.tenants?.find((candidate) => candidate.tenant_id === tenantId);
  if (!found) throw new Error(`tenant ${tenantId} was not found`);
  return cleanProviderPolicy(structuredClone(found));
}

function feature(tenant) {
  const app = tenant.apps?.find((candidate) => candidate.app_id === appId);
  if (!app) throw new Error(`app ${appId} was not found in tenant ${tenantId}`);
  const found = app.features?.[featureId];
  if (!found) throw new Error(`feature ${featureId} was not found in app ${appId}`);
  if ((found.mode ?? "mock") !== "mock") throw new Error(`feature ${featureId} is not mock-mode`);
  return found;
}

function withModel(tenant, model) {
  const next = structuredClone(tenant);
  feature(next).model = model;
  return next;
}

function cleanProviderPolicy(tenant) {
  for (const app of tenant.apps ?? []) {
    for (const configuredFeature of Object.values(app.features ?? {})) {
      delete configuredFeature.provider_policy;
    }
  }
  return tenant;
}

function assertCapabilityOnly(entries) {
  const catalogFeature = entries.find((entry) => entry.feature_id === featureId);
  if (!catalogFeature) throw new Error(`catalog omitted feature ${featureId}`);
  if (catalogFeature.model !== undefined) throw new Error(`capability ${featureId} leaked its model`);
}

async function applyTenant(nextTenant) {
  const proposal = await adminJson("POST", "/v1/admin/config/proposals", nextTenant);
  if (typeof proposal?.proposal_id !== "string") throw new Error("proposal response omitted proposal_id");
  await adminJson(
    "POST",
    `/v1/admin/config/proposals/${encodeURIComponent(proposal.proposal_id)}/apply`,
    undefined,
    { "X-Idempotency-Key": `sdk-s12-apply-${crypto.randomUUID()}` },
  );
}

async function adminJson(method, path, body, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Accept": "application/json",
      "X-Admin-Key": adminKey,
      ...extraHeaders,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${await response.text()}`);
  return response.json();
}
