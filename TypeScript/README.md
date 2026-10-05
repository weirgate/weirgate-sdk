# `@weirgate/sdk`

Typed TypeScript client for the public Weirgate API frozen at version `2026-07-18`.

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

const stream = await client.streamChat("coach-chat", {
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
Every result and error carries `requestId` and `apiVersion` correlation metadata.

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

## Use the user's AI plan (web apps)

A feature's funding chain decides who pays for each request: the user's AI plan
(`user_plan`), the user's own provider key (`user_key`), or you (`developer`). Give the
client a `planCredential` and it sends the user's ChatGPT plan token
(`X-Weirgate-User-Credential`) to features whose catalog entry accepts it.

**Status: not usable with real plans yet.** Plan usage in a paid or remotely hosted app
needs OpenAI's partner approval, for Weirgate and for your app. Until Weirgate records your
app as `approved`, live features answer `funding_rail_unavailable`; only mock features
serve the rail. OpenAI has no plan-usage sandbox before approval, so this SDK is tested
against recorded Weirgate responses, never a real plan.

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
| `getUserCredits(appId, externalId)` | Balance (with `allowance_available` / `purchased_available`), unlimited state, grants, adjustments, tier changes, plan source (`tier_source`: `subscription` or `manual`), App Store `subscriptions`, and recent usage |

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
const { data } = await admin.rotateAdminKey(keyId, { overlap_seconds: 86_400 });
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

## Regeneration

The spec is not forked into this repository. Regenerate from a local Weirgate checkout:

```sh
npm run generate -- --input ../../weirgate/openapi.yaml
```

`spec-provenance.json` records the API version and source commit.
