# `@weirgate/sdk`

Typed TypeScript client for the public Weirgate API, contract version `2026-07-18`
(pre-release; see the [API changelog](https://weirgate.com/reference/changelog/)).

```sh
npm install @weirgate/sdk
```

```ts
import { Weirgate } from "@weirgate/sdk";

const client = new Weirgate({
  appId: "my-app",
  token: async () => getFreshEndUserJWT(),
});

const catalog = await client.features();
if (catalog.kind === "modified") {
  console.log(catalog.data.data);
}

const stream = await client.streamChat("assistant", {
  messages: [{ role: "user", content: "Hello" }],
});
for await (const chunk of stream.chunks) {
  // Consume OpenAI-compatible chunks. The iterator verifies final usage and [DONE].
}
```

Delete the authenticated user's Weirgate identity before deleting the corresponding
identity-provider account:

```ts
const deletion = await client.deleteAccount();
// After this succeeds, delete the Firebase/Auth user.
```

The target comes only from the fresh bearer token and `appId`; there is no caller-selected
external ID. A replay or no-row request returns idempotent success, so the app can retry
the full Weirgate-first sequence after a partial failure.

Mutations receive an automatic `X-Idempotency-Key`; pass `idempotencyKey` to override it.
Credit writes are the exception: they require your own key (see below).
Server failures are `WeirgateError` values keyed by `error.type`, never message text.
The API can add error types without a version change; a type newer than this SDK is
`"unrecognized"`, with the server's value in `error.rawType`. Handle it by `error.status`.
Every result and error carries `requestId` and `apiVersion` correlation metadata.
`error.retryAfter` is the `Retry-After` header in seconds (an HTTP date is converted), or
null.

Some refusals are never the end user's doing. For these `error.mustNotShowPaywall` is
true: show a "temporarily unavailable" message, never a purchase prompt.

| `error.type` (status) | Class | Meaning |
|---|---|---|
| `developer_credit_exhausted` (503) | `DeveloperCreditExhaustedError` (`provider`, `nextRail`) | Your provider key is out of credit. A chain with a user rail after `developer` already fell through; otherwise fall back or retry later |
| `provider_rate_limited` (503) | `ProviderRateLimitedError` (`provider`, `rail`) | The provider throttled the request; retry after `retryAfter` when set |
| `platform_allowance_exhausted` (429) | `PlatformAllowanceExhaustedError` (`meter`, `tier`, `resetsAt`) | Your Weirgate plan used its monthly calls or tokens; `retryAfter` is the seconds until the reset |
| `budget_exhausted` (429) | `BudgetExhaustedError` (`period`, `resetsAt`) | Your developer-funded budget for the month or day is spent; `retryAfter` is the seconds until the reset |

`user_provider_key_invalid` (422) is `UserProviderKeyInvalidError`: `reason` is
`"invalid"` (the provider refused the user's key; ask them to fix it) or
`"out_of_credit"` (their provider account is empty; ask them to add credit there).

Server-side management clients can schedule a configured per-user tier with an admin
key that has apply scope and the `plans` tool group (a credits-only key can't change
tiers, and `billing` no longer works here). The change activates at the next UTC
monthly grant period; `top_up_now` grants only the positive current-period allowance
delta:

```ts
const admin = new Weirgate({ adminKey: process.env.WEIRGATE_API_KEY });
await admin.assignUserTier("my-app", "supporter-code-user", {
  tier: "early-adopter",
  top_up_now: true,
}, { idempotencyKey: "supporter-tier-2026-08" });
```

Pass `expires_at` (an RFC 3339 string or a `Date`) to end an assignment; an unlimited
tier then takes effect immediately and ends on time. `balance.unlimited` and
`balance.unlimited_until` in tier and user results report the active plan, as
`balance()` does for the end user.

Keep admin keys server-side. End-user applications must not embed this management
surface or its credential.

## Balance split and App Store purchases

`balance()` adds `allowance_available` and `purchased_available`, which always sum to
`units_available`; the allowance is spent first. `allowance_available` is unspent allowance
of a plan whose allowance resets each UTC month (`allowance_rollover: "expire"`), never
negative and 0 on plans whose allowance carries over. `purchased_available` is everything
that never expires (credit packs, welcome and manual grants, carried-over allowance,
adjustments) and can be negative after a refund or clawback. Weirgate writes the
month-end removal itself as an adjustment with `reason: "allowance_expiry"`; the
adjustments API refuses that reason.

```ts
const { data } = await client.balance();
label.textContent = `${data.allowance_available} monthly + ${data.purchased_available} purchased`;
```

Apps whose purchase flow hands you a StoreKit 2 `jwsRepresentation` (for example a
React Native or Capacitor wrapper) redeem it as the end user with
`redeemAppleTransaction(jws)`. Consumables return credits; products mapped as
subscriptions return `kind: "subscription"`, the user's `tier`, and `subscription`
(`status`, `expires_at`, `active`, `plan_applied`; `null` when another user of the app owns
the subscription). Finish the transaction only after `granted` or `already_granted`, or a
`purchase_revoked` error. See Weirgate's
[App Store subscriptions guide](https://weirgate.com/guides/app-store-subscriptions/).

Welcome credits have no TypeScript call yet: call `POST /v1/welcome-grant` with the
end-user token (see the [welcome credits guide](https://weirgate.com/guides/welcome-credits/)),
or use Swift's `claimWelcomeCredits`.

## Use the user's AI plan (web apps)

A feature's funding chain decides who pays for each request: the user's AI plan
(`user_plan`), the user's own provider key (`user_key`), or you (`developer`). Give the
client a `planCredential` and it sends the user's ChatGPT plan token
(`X-Weirgate-User-Credential`) to features whose catalog entry accepts it.

**Status: not yet available in production.** Work on plan usage is parked. Plan usage in a
paid or remotely hosted app needs OpenAI's partner approval, for Weirgate and for your app.
Until Weirgate records your app as `approved`, live features answer
`funding_rail_unavailable` (they don't fall through to another rail), so don't send a plan
credential to live features; only mock features serve the rail. OpenAI has no plan-usage
sandbox before approval, so this SDK is tested against recorded Weirgate responses, never a
real plan. The rest of this section describes the API as built.

```ts
import { Weirgate, offersPlan, PlanReconnectRequiredError, FundingRailError } from "@weirgate/sdk";

const client = new Weirgate({ appId: "my-app", token: getFreshEndUserJWT, planCredential: chatgptPlan });

const catalog = await client.features();
if (catalog.kind === "modified") showContinueWithChatGPT(offersPlan(catalog.data, "openai_chatgpt"));

try {
  const result = await client.chat("assistant", { messages });
  console.log(result.funding); // { rail: "user_plan", provider: "openai_chatgpt", fallback: null }
} catch (error) {
  if (error instanceof PlanReconnectRequiredError) showReconnectChatGPT();
  else if (error instanceof FundingRailError) console.warn(error.type, error.reason, error.providerRequestId);
  else throw error;
}
```

The client applies the funding retry rules for `chat`, `streamChat`, and `embedding`:

| Server answer | What the SDK does |
|---|---|
| `user_credential_expired` (401) | Calls `refreshAccessToken` once and repeats the request with the same idempotency key. A second rejection, or a refused refresh, calls `requireReconnect` and throws `PlanReconnectRequiredError` |
| `funding_rail_refused` (402) with `detail.next_rail` | Repeats once on that rail (`X-Weirgate-Funding`, key `<key>:rail:<rail>`, no plan token unless the rail is `user_plan`); at most two hops |
| `funding_rail_refused` without `next_rail` | Throws `FundingRailRefusedError` (`rail`, `reason`, `providerRequestId`) |
| `funding_rail_unavailable` (403) | Throws `FundingRailUnavailableError`; a configuration problem, not retried |
| `X-Weirgate-Funding-Fallback: user_plan; …; disable` on a success | Returns the result and calls `requireReconnect({ kind: "rail_disabled" })` |
| Stream ends with `data: {"error": …}` | `chunks` throws `FundingRailRefusedError` after the partial chunks. Discard the partial answer and call again with `error.retryOptions(options)` when it is not null. If the frame has `detail.disable` (`error.disable`) for the plan the stream used, `requireReconnect({ kind: "rail_disabled" })` is called first |

`fundingPreference` (client option, or `funding` per call) picks where the chain starts:
`"server_chain"` (default) or `{ startAt: "developer" }` to skip the user's plan.

### Recipe: Sign in with ChatGPT in a browser app

The SDK does not ship a browser OAuth flow. OpenAI forbids keeping these tokens in browser
storage, and the redirect URI belongs to your app, so the OAuth half runs on your server:

1. Your server starts OpenID Connect with PKCE at
   `https://auth.openai.com/api/accounts/authorize` with your partner client ID, your
   registered redirect URI, scopes `openid profile email offline_access
   chatgpt.tokens.use.direct`, `resource=https://api.openai.com/v1`, fresh `state`, `nonce`,
   and `code_challenge` (S256), and a stable `ext_agent_host_id` (`urn:uuid:…`) for your
   deployment. Add `prompt=consent` to re-ask for plan usage.
2. Your callback route checks `state`, exchanges the code at
   `https://auth.openai.com/api/accounts/oauth/token`, checks the ID token's `nonce`, and
   stores the refresh token server-side against the user's session. If the token response's
   `scope` lacks `chatgpt.tokens.use.direct`, keep the sign-in but don't offer plan usage.
3. Your server refreshes when less than five minutes remain, one refresh at a time per
   user, and stores the rotated refresh token every time. On `invalid_grant`,
   `invalid_refresh_token`, `token_expired`, or `refresh_token_reused`, it deletes the tokens.
4. The browser keeps only the short-lived access token, in memory:

```ts
import type { PlanCredentialSource } from "@weirgate/sdk";

let accessToken: string | null = null;
const chatgptPlan: PlanCredentialSource = {
  provider: "openai_chatgpt",
  async fundingAccessToken() {
    accessToken ??= (await (await fetch("/api/chatgpt/access-token")).json()).token ?? null;
    return accessToken;
  },
  async refreshAccessToken(rejected) {
    const response = await fetch("/api/chatgpt/refresh", { method: "POST", body: JSON.stringify({ rejected }) });
    const body = await response.json();
    if (response.status === 401) {
      accessToken = null;
      return { kind: "reconnect_required", reason: { kind: "refresh_rejected", oauthError: body.error } };
    }
    if (!response.ok) throw new Error("refresh failed; try again");
    accessToken = body.token;
    return { kind: "refreshed", accessToken: body.token };
  },
  async requireReconnect() {
    accessToken = null;
    await fetch("/api/chatgpt/disconnect", { method: "POST" }); // server deletes the tokens
    showReconnectChatGPT();
  },
};
```

Before shipping: label the button **Continue with ChatGPT** with OpenAI's branding; keep
every feature that works without a plan working without it; disclose in your privacy policy
that you receive the user's name, email, and profile picture; and remember that OpenAI does
not notify apps when a user disconnects them, so you learn it on the next rejected request.
Link to ChatGPT's settings for disconnect instructions.

## Credits API for your own payment system

Weirgate never charges end users. Your payment system takes the money, and your server
tells Weirgate how many credits a user gained or lost. Use a credits-only key: minted with
`scope: "apply"`, `tool_groups: ["credits"]`, explicit `app_ids`, and one `environment`.
It may omit `expires_at`, and can call only these methods:

| Method | Use it for |
|---|---|
| `createGrant(appId, externalId, { units, source }, { idempotencyKey })` | Credits added by a purchase |
| `reverseGrant(appId, grantId, { idempotencyKey })` | Cancelling a whole grant, e.g. a full refund |
| `adjustCredits(appId, externalId, { units, reason, source, allow_negative }, { idempotencyKey })` | Signed corrections: deductions, partial clawbacks, goodwill |
| `getUserCredits(appId, externalId)` | Balance (with `allowance_available` / `purchased_available`), unlimited state, block `status`, grants, adjustments, tier changes, plan source (`tier_source`: `subscription` or `manual`), App Store `subscriptions`, and recent usage |
| `getUserStatus(appId, externalId)` | Only the block status: `state` (`ok` or `blocked`) and `reasons` (active conditions first, then the user's refusals of the last 24 hours) |

Writes create the user when the external ID is unknown. Every write requires
`idempotencyKey`, and the SDK never generates one: derive it from your payment
system's event, charge, or order ID, never from a timestamp or random value. The same
key and body replay the original result (adjustments add `idempotent: true`); the same
key with a different body throws `ResourceConflictError`.

`units` on an adjustment is signed and never zero. `reason` is `manual`, `clawback`, or
your own text. A deduction that would take the balance below zero throws
`InsufficientBalanceError` (`available`, `units`) unless `allow_negative` is `true`, which
is the default for `reason: "clawback"`, so a refund still lands after the credits were
spent. A negative balance blocks metered requests until it is back above zero.

```ts
import { InsufficientBalanceError, Weirgate } from "@weirgate/sdk";

const credits = new Weirgate({ adminKey: process.env.WEIRGATE_CREDITS_KEY });

try {
  await credits.adjustCredits("my-app", userId, { units: -20, reason: "manual", source: `support:${ticketId}` }, {
    idempotencyKey: `support:${ticketId}`,
  });
} catch (error) {
  if (error instanceof InsufficientBalanceError) {
    console.log(`only ${error.available} credits left`);
  } else throw error;
}
```

### Recipe: Stripe

In your `checkout.session.completed` handler, after verifying the Stripe signature, look
up the credits for the price you sold and grant them. Store the grant ID next to your
order in case you need to reverse it:

```ts
const { data } = await credits.createGrant("my-app", session.client_reference_id!, {
  units: CREDITS_BY_PRICE[priceId],
  source: `stripe:${session.id}`,
}, { idempotencyKey: `stripe:${session.id}` });
await orders.save({ stripeSessionId: session.id, weirgateGrantId: data.grant.id });
```

On `charge.refunded`, key the call by the refund ID. Reverse the grant for a full refund,
or post a `clawback` adjustment for the refunded share:

```ts
// `refund` is the Stripe Refund this event reports.
const order = await orders.findByCharge(charge.id);
if (charge.amount_refunded === charge.amount) {
  await credits.reverseGrant("my-app", order.weirgateGrantId, { idempotencyKey: `stripe:${refund.id}` });
} else {
  await credits.adjustCredits("my-app", order.userId, {
    units: -creditsForRefund(order, refund),
    reason: "clawback",
    source: `stripe:${refund.id}`,
  }, { idempotencyKey: `stripe:${refund.id}` });
}
```

### Recipe: RevenueCat

In the RevenueCat webhook handler, grant on `NON_RENEWING_PURCHASE` (consumables), with
`app_user_id` as the external ID. On `CANCELLATION` with `cancel_reason:
"CUSTOMER_SUPPORT"` (a refund), post a `clawback` with the product's credit count negated:

```ts
const key = `revenuecat:${event.id}`;
if (event.type === "NON_RENEWING_PURCHASE") {
  await credits.createGrant("my-app", event.app_user_id, {
    units: CREDITS_BY_PRODUCT[event.product_id],
    source: key,
  }, { idempotencyKey: key });
} else if (event.type === "CANCELLATION" && event.cancel_reason === "CUSTOMER_SUPPORT") {
  await credits.adjustCredits("my-app", event.app_user_id, {
    units: -CREDITS_BY_PRODUCT[event.product_id],
    reason: "clawback",
    source: key,
  }, { idempotencyKey: key });
}
```

### Recipe: your own backend

Call `createGrant` when your system confirms a purchase and `adjustCredits` for any
correction, keyed by your own durable record ID (for example `order:${order.id}`). Store
`data.grant.id` with the order if you may need `reverseGrant` later.

### Rotating the credits key

```ts
// Rotate with a key that holds the `keys` tool group, not the credits-only key.
const keysAdmin = new Weirgate({ adminKey: process.env.WEIRGATE_KEYS_ADMIN_KEY });
const { data } = await keysAdmin.rotateAdminKey(keyId, { overlap_seconds: 86_400 });
// data.value is shown once: store it and deploy it. Before the overlap ends, check
// that the old key's last_used_at (dashboard or GET /v1/admin/keys) stopped advancing.
```

The old key keeps working for `overlap_seconds` (default 86400, at most 604800; `0` stops
it immediately). Call this with a key that has the `keys` tool group, not the credits-only
key. A key rotates once: rotating it again throws `ResourceConflictError` whose
`replacedByKeyId` names the replacement. Rotation is not replay-safe, so if the response
is lost, the new value is gone; rotate the replacement (`replacedByKeyId`) again.

See the [SDK guide](https://weirgate.com/guides/sdks/) and
[API reference](https://weirgate.com/reference/api/) for the public contract.

## Listing users

`listUsers(appId, query)` (a key with the `usage` tool group) returns one page of active
users with filters (`q`, `tier`, `balanceLt`, `outOfAllowance`, `activeSince`,
`inactiveSince`, `paying`), `sort`, `direction`, and `cursor`. `pagination.total` counts
every match up to 10,000; when `pagination.total_capped` is true more match, so show the
count as "10,000+". Pass `pagination.next_cursor` as `cursor`, with the same sort and
direction, for the next page.

Sandbox fixture users are listed with `origin: "sandbox"` (others are `real` or `test`)
but never counted in `pagination.total`; `pagination.sandbox_total` counts them. Pass
`origin` to list only one kind.

## Team members and invitations

The team methods use a dashboard sign-in, not a management key: pass the person's Clerk
session token as `sessionToken` (a string or a function returning one). They never send
`adminKey`.

```ts
const weirgate = new Weirgate({ sessionToken: () => clerk.session!.getToken() });
const { data } = await weirgate.listMembers();          // data.data: DeveloperMember[]
await weirgate.updateMemberRole(memberId, "owner");     // the Clerk org role follows
await weirgate.removeMember(memberId);                  // safe to retry
const invitation = await weirgate.createInvitation("new@example.com");
await weirgate.revokeInvitation(invitation.data.id);
```

Anyone on the team can list members. Changing a role, removing someone, and inviting or
revoking need an owner with a recent sign-in check. Refusals are `ResourceConflictError`
with `detail.reason`: `last_owner`, `self_removal`, `invitation_exists`, `already_member`,
`invitation_not_pending`, or `clerk_refused`. A Clerk outage is `provider_unavailable`
(`detail.service: "clerk"`) and changes nothing.

### Recent sign-in check (step-up)

Sensitive dashboard actions (team changes, apply, key minting, billing, ...) need the
person to have re-verified in the last 10 minutes. Without it the SDK throws
`StepUpRequiredError` (`insufficient_scope`, 403). Its `level` is the check to ask for:
`second_factor` when the account has one, otherwise `first_factor` (the password).

```ts
try {
  await weirgate.removeMember(memberId);
} catch (error) {
  if (error instanceof StepUpRequiredError) {
    await reverify(error.level); // e.g. Clerk's reverification at this level
    await weirgate.removeMember(memberId);
  } else throw error;
}
```

## Exporting usage for billing and reconciliation

Two reads (a key with the `usage` tool group) export settled usage for a window:

| Method | Reads |
|---|---|
| `exportUsageEvents(appId, { since, until, cursor?, limit? })` | `GET /v1/admin/apps/{app_id}/usage/events`: one `UsageExportRow` per settled request in `[since, until)`, oldest first |
| `getUsageByUserRail(appId, { since, until, cursor?, limit? })` | `GET /v1/admin/apps/{app_id}/usage/users`: one `UsageRollupRow` per end user and funding rail over whole UTC days |

`since` and `until` are required (ISO strings or `Date`s). For the per-user rollup both
must be UTC midnights; the SDK rejects other instants before sending. Everything else
(order, range) is checked by the server. Pages hold at most 1,000 rows (`limit` 1–1000).
For a complete raw export, end the window at least five minutes in the past so no request
in it is still settling.

Each method returns one page; pass `data.pagination.next_cursor` back as `cursor`, with
the same window, while `data.pagination.truncated` is true. The `iterate…` methods do that
for you and yield every row once:

```ts
const admin = new Weirgate({ adminKey: process.env.WEIRGATE_USAGE_KEY });

for await (const row of admin.iterateUsageEvents("my-app", {
  since: "2026-10-01T00:00:00Z",
  until: "2026-11-01T00:00:00Z",
})) {
  // row.upstream_generation_id matches the id column of OpenRouter's Logs export
  // (null for providers that return none and for requests settled before 2026-10-18).
  reconcile(row.upstream_generation_id, row.upstream_provider, row.provider_cost_usd);
}

for await (const row of admin.iterateUsageByUserRail("my-app", { since, until })) {
  bill(row.external_id ?? row.user_id, row.funding_rail, row.units);
}
```

For CSV, `exportUsageEventsCsv` and `getUsageByUserRailCsv` return one page as
`{ csv, nextCursor, truncated }`, read from the `X-Weirgate-Next-Cursor` and
`X-Weirgate-Truncated` headers; `iterateUsageEventsCsv` and `iterateUsageByUserRailCsv`
yield every page. The columns are the row type's fields in order, with CRLF line ends.
Every page starts with the header row, so drop it from later pages when you concatenate:

```ts
let first = true;
for await (const { data } of admin.iterateUsageEventsCsv("my-app", { since, until })) {
  out.write(first ? data.csv : data.csv.slice(data.csv.indexOf("\r\n") + 2));
  first = false;
}
```

A truncated page with no new cursor throws `WeirgateProtocolError` rather than ending the
export short. `UsageEvent` (for example in `getUserCredits` recent usage) carries
`upstream_generation_id` and `upstream_provider` too.

## Verifying webhooks

Verify every delivery over the exact raw body before parsing it:

```ts
import { constructWebhookEvent, WebhookSignatureError } from "@weirgate/sdk";

app.post("/weirgate/webhooks", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const event = await constructWebhookEvent({
      payload: req.body, // Buffer or string: the raw body
      headers: req.headers,
      secret: process.env.WEIRGATE_WEBHOOK_SECRET!, // the endpoint's whsec_ secret
    });
    if (event.type === "provider.credit_exhausted") switchToUserFunded(event.data);
    res.sendStatus(204);
  } catch (error) {
    if (error instanceof WebhookSignatureError) return res.sendStatus(400);
    throw error;
  }
});
```

`verifyWebhookSignature` checks `Weirgate-Signature: v1=<hex>`, the HMAC-SHA256 of
`<Weirgate-Timestamp>.<raw body>` under the secret, in constant time, and rejects a
timestamp more than `toleranceSeconds` (default 300) from now. It needs Web Crypto
(`globalThis.crypto.subtle`: Node 19+, Deno, Bun, Workers, browsers). Delivery is at least once,
so deduplicate by `event.id`. Event types are open-ended: `WEBHOOK_EVENT_TYPES` lists the
ones this SDK knows (including `provider.credit_low`, `provider.credit_exhausted`,
`provider.credit_restored`, `user_key.rejected`, `platform.allowance_warning`, and
`platform.allowance_exhausted`); ignore the rest.

## Regeneration

The spec is not forked into this repository. Regenerate from a local Weirgate checkout:

```sh
npm run generate -- --input ../../weirgate-platform/openapi.yaml
```

`spec-provenance.json` records the API version and source commit. The generator writes the same
provenance into WeirgateKit (`Resources/spec-provenance.json` and `WeirgateKitInfo`), so
the two SDKs always name the same spec.
