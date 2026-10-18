// Records the webhook signature vector (signature-v1.json) with the server's own signing code.
// Not part of either SDK package. Usage, from the weirgate checkout:
//   node_modules/.bin/tsx ../weirgate-sdk/fixtures/webhooks/record.mts > signature-v1.json
import { execFileSync } from "node:child_process";
const W = process.env.WEIRGATE_DIR ?? process.cwd();
const { webhookSignature } = await import(`${W}/src/management-plane/webhooks.ts`);

// A throwaway test secret: never a real endpoint's.
const secret = "whsec_test_sdk_vector_0123456789abcdef";
const timestamp = 1760788800;
const body = JSON.stringify({
  id: "evt_test_1",
  type: "user_key.rejected",
  created_at: "2025-10-18T12:00:00.000Z",
  app_id: "app_test",
  user_id: "usr_test",
  data: {
    external_id: "user-1",
    reason: "out_of_credit",
    funding_rail: "user_key",
    provider: "openrouter",
    feature_id: "chat",
    request_id: "req_00000000-0000-4000-8000-000000000000",
    window_start: "2025-10-18T12:00:00.000Z",
  },
});
const commit = execFileSync("git", ["-C", W, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
console.log(JSON.stringify({
  description: `Produced by the weirgate server's own webhookSignature() at weirgate ${commit.slice(0, 7)} with a throwaway test secret; not a real endpoint secret.`,
  source_commit: commit,
  secret,
  timestamp,
  body,
  signature: await webhookSignature(secret, timestamp, body),
}, null, 2));
