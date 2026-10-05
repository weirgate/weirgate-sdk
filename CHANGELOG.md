# Changelog

All notable public SDK changes are recorded here.

## Unreleased

Spec provenance moves to weirgate `8ad6ea7` (both SDKs). The API now documents its
growth-prone enums as open-ended (weirgate#177), so new error types and new values can
arrive without a version change.

### Swift (next: WeirgateKit 0.6.0)

- **Source-breaking:** `WeirgateErrorType` gains `.unrecognized`, used for an error type
  newer than the SDK; exhaustive `switch error.type` statements need a `default:` (or an
  `.unrecognized`) case. Previously such an error decoded as `.internalError` and lost its
  message and `detail`.
- `WeirgateError.rawType`: the type exactly as the server sent it. The message, `detail`,
  and `reason` now survive for unrecognized types, and `errorDescription` names the raw type.
- `WeirgateErrorType(serverValue:)` maps a server string to a known case or `.unrecognized`.
- `PurchaseRedemption.Kind` gains `.unrecognized`, so a redeem with a newer product kind
  still decodes instead of failing after the server handled it.

### TypeScript (next: @weirgate/sdk 0.7.0)

- `WeirgateError.type` is now `WeirgateErrorKind` (`ErrorType | "unrecognized"`); an error
  type newer than the SDK is `"unrecognized"` instead of `"internal"`. Exhaustiveness
  checks on `error.type` (a `never` default) need an `"unrecognized"` case. New
  `WeirgateError.rawType` keeps the server's value (also on mid-stream error frames).
- Regenerated types from weirgate `8ad6ea7`: doc comments only (open-ended enums, config
  writes rejecting unknown fields).

## @weirgate/sdk 0.6.0 — 2026-10-05

TypeScript only; WeirgateKit stays 0.5.0 (README fixes only, no code change). Spec
provenance moves to weirgate `cfff470`. Minor bump: management response types renamed
their fields (no call signatures changed).

- TypeScript: regenerated schema types for weirgate#153 (pre-release change). Management
  responses now use snake_case keys and ISO-8601 timestamps: the user read (`user`,
  `grants`, `adjustments`, `tier_changes`, `recent_events`), tier responses (`user`,
  `tier_change`, `top_up_grant`), `createGrant` / `reverseGrant` (`grant`), and
  `adjustCredits` (`adjustment`). For example `grant.createdAt` (ms) is now
  `grant.created_at` (ISO string) and `user.externalId` is `user.external_id`. The full
  list is in the weirgate API changelog. No call signatures changed. The request-plane
  types (balance, chat, purchases, welcome, account) and WeirgateKit are unchanged.
- READMEs (weirgate-sdk#28): `user_plan` / `PlanConnect` marked not yet available in
  production, pre-release contract wording, neutral feature IDs, a note that welcome
  credits have no TypeScript call yet, and corrected samples. The npm package README is
  the TypeScript one.

## @weirgate/sdk 0.5.0 and WeirgateKit 0.5.0 — 2026-10-04

App Store subscriptions (weirgate#90) and the balance split (weirgate#87), in one release
(weirgate-sdk#25, folds in #24). Spec provenance moves to weirgate `91580ca`.

### Swift (WeirgateKit 0.5.0)

- `Balance.allowanceAvailable` and `Balance.purchasedAvailable` (sum to `unitsAvailable`;
  `purchasedAvailable` can be negative). Decoded with a fallback (0 / `unitsAvailable`)
  when a response lacks them.
- `PurchaseRedemption` adds `kind` (`.consumable` default, `.subscription`),
  `originalTransactionID`, `tier`, and `subscription` (`tier`, `status`, `expiresAt`,
  `active`, `planApplied`; `nil` when another user owns the subscription).
- **Behavior change:** `WeirgateStoreObserver`'s default `shouldRedeem` is now
  `redeemsByDefault`, which redeems auto-renewable subscriptions as well as consumables
  (renewals arrive on `Transaction.updates`). Apps that sell subscriptions handled
  elsewhere should pass `shouldRedeem: { $0.productType == .consumable }`.
- `WeirgateStoreObserver.restoreSubscriptions()` redeems `Transaction.currentEntitlements`
  (auto-renewable) for new devices and Restore Purchases.
- **Source-breaking:** `WeirgateStoreEvent.Source` gains `.currentEntitlements`; exhaustive
  switches need the new case.

### TypeScript (@weirgate/sdk 0.5.0)

- `redeemAppleTransaction(signedTransaction)`: end-user redeem of a StoreKit 2 record
  (`POST /v1/purchases/apple`), returning `AppleRedemption`.
- Regenerated types: `Balance` and `UserBalance` / `UserListRow` with
  `allowance_available` / `purchased_available`; `getUserCredits` returns `tier_source` and
  `subscriptions`; `UserRow.tierSubscriptionId`; `PaymentTransaction.kind` / `tier` /
  `expiresAt`; `ConfigProposalCreated.warnings`; App Store products typed as consumable or
  subscription. New exported types `AppleRedemption`, `AppleSubscriptionState`,
  `PaymentTransaction`, `PaymentSubscription`, `PlanSource`.

### Also in this release

- Generated types only: webhook proposals accept only `operation: "update" | "delete"` and
  require `endpoint_id`. weirgate `9f5a4c5` (#132) rejects `create`, because its apply
  minted a signing secret no response returned; create endpoints with
  `POST /v1/admin/apps/{appId}/webhooks`, which returns the secret once. No hand-written
  SDK method calls the proposal routes. Spec provenance moves to weirgate `9f5a4c5`.
- Docs only, no code change: `assignUserTier` / `revertUserTier` need an admin key with
  the `plans` tool group, and `createGrant` / `reverseGrant` need `credits`; weirgate
  `b5d3702` (#122) no longer accepts `billing` for either. Spec provenance moves to
  weirgate `b5d3702` (generated description text only).

## @weirgate/sdk 0.4.0 — 2026-10-04

- TypeScript: `Health` is now `{ ok: true; mode }`. weirgate `0970c08` made `/healthz` a
  liveness check that never queries the database, so `checks.database` and the 503
  `ReadinessFailure` response are gone from the contract. `health()` callers that read
  `checks` should drop it. This removes a response field, so it ships as a minor version
  (0.x); WeirgateKit already decoded only `ok` and `mode` and is unchanged.
- Spec provenance moves to weirgate `0970c08` (also picks up contract text for dashboard
  sessions on the webhook routes and the tier-expiry wording).

## @weirgate/sdk 0.3.1 and WeirgateKit 0.4.1 — 2026-10-03

- Both SDKs read `detail.disable` on a stream's final error frame, which weirgate sends
  for a mid-stream refusal under `on_refusal: next_and_disable` (weirgate `0738d89`). When
  the stream carried the user's plan token, the plan is disconnected
  (`.reconnectRequired(.railDisabled)` / `requireReconnect({ kind: "rail_disabled" })`) before
  the typed error is thrown, as a `disable` fallback header already did. New read-only
  `FundingRailError.disablesRail` (Swift) and `FundingRailError.disable` (TypeScript).
- Test fixtures are recorded against weirgate `0738d89`, with mid-stream recordings for
  `next_and_disable` and `stop`.
- Spec provenance moves to weirgate `0738d89` (contract text only: when `next_rail` is set
  mid-stream, and that a same-key retry after a refunded attempt is a new, metered attempt).

## @weirgate/sdk 0.3.0 and WeirgateKit 0.4.0 — 2026-10-03

Funding rails v2, Phase 2: let an app offer "use your ChatGPT plan" on top of the funding
chain the server enforces (weirgate#124, spec provenance weirgate `25282cf`). Nothing here
has run against a real plan: OpenAI has no plan-usage sandbox before partner approval, so
tests replay Weirgate responses recorded from the server (`fixtures/funding-rails/`).

### Swift

- `PlanConnect` (iOS 17+, macOS 14+) for `openai_chatgpt`: OpenID Connect with PKCE through
  `ASWebAuthenticationSession` (`WebAuthenticationSessionAuthorizer`), client ID and redirect
  URI from the app's partner registration, scopes `openid profile email offline_access
  chatgpt.tokens.use.direct`, tokens in the Keychain (`KeychainPlanTokenStore`, or any
  `PlanTokenStore`), the rotated refresh token stored on every refresh, proactive refresh
  under five minutes, serialized refreshes, a stable `urn:uuid:` host ID sent as
  `ext_agent_host_id`. Without `chatgpt.tokens.use.direct` the sign-in is kept for identity
  and `status()` reports `.connected(funding: false)`; `enablePlanUsage()` repeats with
  `prompt=consent`. `statusUpdates()` reports `.reconnectRequired` after a refused refresh.
- `WeirgateClient(…, planCredential:)` and `WeirgateConfiguration.fundingPreference`
  (`.serverChain` default, `.startAt(rail)`), per-call `RequestOptions(funding:)`. Chat and
  streaming send `X-Weirgate-User-Credential` only to features whose catalog entry accepts
  the provider, and `ResponseMetadata.funding` reports `X-Weirgate-Funding-Rail` and
  `X-Weirgate-Funding-Fallback`.
- Retry rules: `user_credential_expired` refreshes once and repeats with the same
  idempotency key; a second rejection or a refused refresh clears the tokens and throws
  `FundingRailError(.reconnectRequired)`; `funding_rail_refused` with `next_rail` repeats on
  that rail (key `<key>:rail:<rail>`, at most two hops); a `disable` fallback clears the plan.
- `FundingRailError` types `funding_rail_refused`, `funding_rail_unavailable`, and
  `user_credential_expired`, before headers and from the stream's final `data: {"error"}`
  frame, with `retryOptions(from:)` for restarting a stream on `next_rail`.
- Catalog: `Feature.funding` (`order`, `planProviders`), `acceptsPlan(_:)`,
  `FeatureCatalog.features(acceptingPlan:)` and `offersPlan(_:)`. `FundingRail` and
  `PlanProvider` are open-ended.

### TypeScript

- `planCredential` (`PlanCredentialSource`) and `fundingPreference` options, per-call
  `funding`, the same header injection and retry rules for `chat`, `streamChat`, and
  `embedding`, and `funding` on results and streams.
- `FundingRailError` with `FundingRailRefusedError`, `FundingRailUnavailableError`,
  `UserCredentialExpiredError`, plus `PlanReconnectRequiredError`. The stream's final error
  frame throws the typed error.
- Catalog helpers `acceptsPlan`, `featuresAcceptingPlan`, `offersPlan`, and
  `parseFundingHeaders`.
- Browser sign-in is a README recipe, not a built-in: OpenAI forbids tokens in browser
  storage, so the OAuth half runs on the app's server.
- Generated types move to weirgate `25282cf`.

### Type changes (additive, but can break exhaustive matching)

- Swift `WeirgateErrorType` gains `fundingRailRefused`, `fundingRailUnavailable`, and
  `userCredentialExpired`; a `switch` without `default` must handle them.
- TypeScript `ErrorType` and `ERROR_TYPES` gain the three funding types, and
  `ERROR_TYPES` gains the six `purchase_*` types it lacked (0.2.0 reported those errors as
  `internal`).
- TypeScript `FeatureCatalogEntry` gains the required `funding` object (server contract);
  code that builds catalog entries by hand must add it.
- New optional fields: Swift `Feature.funding`, `ResponseMetadata.funding`,
  `RequestOptions.funding`, `WeirgateConfiguration.fundingPreference`; TypeScript
  `WeirgateResult.funding`, `ChatStream.funding`, `RequestOptions.funding`.

## 0.3.0 — 2026-10-01

Swift only. `@weirgate/sdk` stays at 0.2.0 and nothing is published to npm.

### Swift

- `claimWelcomeCredits(appleIdentityToken:maxAttempts:)` calls `POST /v1/welcome-grant` and
  returns `WelcomeCreditsClaim` with status `granted`, `alreadyClaimed`, or
  `requiresSignIn`. Typed `WelcomeCreditsError`: `appleIdentityTokenInvalid`
  (`detail.reason=apple_identity_token_invalid`), `appleUnavailable` (`provider_unavailable`,
  retried after `Retry-After`, capped at 30 seconds), and `notConfigured`.
- `Balance` gains `unlimited`, `unlimitedUntil` (`Date?`), and `appAccountToken` (`UUID`),
  plus a public initializer. No `allowanceAvailable` / `purchasedAvailable` yet: the server
  has no balance breakdown until weirgate#87.
- `redeemAppStoreTransaction(jws:)` calls `POST /v1/purchases/apple` and returns
  `PurchaseRedemption` (`granted` / `alreadyGranted`, units, optional grant ID, transaction
  and product IDs, `test` / `live` environment, balance). Typed `PurchaseRedemptionError`
  for the six `purchase_*` errors and `payments_not_configured`, with
  `shouldFinishTransaction` true only for `purchase_revoked`.
- New `WeirgateStoreKit` product (so `WeirgateKit` still doesn't import StoreKit):
  `WeirgateStoreObserver` redeems `Transaction.unfinished` at start and listens to
  `Transaction.updates`, buys with `.appAccountToken`, finishes only on 200 or
  `purchase_revoked`, leaves other rejections unfinished without looping, retries transport
  errors, 5xx, and `rate_limited` with bounded backoff, never redeems one transaction twice
  at once, and reports every outcome on `events`.
- `WeirgateError` gains `reason` (`detail.reason`) and `retryAfter`. `WeirgateErrorType`
  adds `insufficient_balance` and the six `purchase_*` types, matching the server's list.
- Spec provenance moves to weirgate `8694e3b`.

## 0.2.0 — 2026-09-30

### TypeScript

- Added credits API wrappers for developer servers: `createGrant`, `reverseGrant`,
  `adjustCredits`, and `getUserCredits`, plus `rotateAdminKey` for the credits-only key.
  Credit writes require a caller-supplied `idempotencyKey`; the SDK never generates one
  for them, and no longer has any `X-Idempotency-Mode` behavior to opt into.
- Added typed `InsufficientBalanceError` (`available`, `units`) and
  `ResourceConflictError` (`replacedByKeyId`), both `WeirgateError` subclasses, and the
  `insufficient_balance` error type.
- `assignUserTier` accepts `expires_at` (string or `Date`). Tier and user results, and
  `balance()`, report `unlimited` and `unlimited_until`.
- Regenerated types from weirgate `1d4c1c8`. Tier changes can now report
  `operation: "expire"`.
- README recipes: Stripe, RevenueCat, and your own backend.

### Swift

- Version string bumped to 0.2.0; no API change. The hand-written client still builds. Credit writes are server-side, so the
  end-user client never receives `insufficient_balance`. `Balance.unlimited` and
  `unlimited_until` arrive with weirgate-sdk#9.

## 0.1.1 — 2026-08-16

### TypeScript

- Added typed `assignUserTier` and `revertUserTier` management methods with explicit
  idempotency-key support, plus refreshed generated types from the frozen API contract.
- Added end-user `deleteAccount()` with a typed `AccountDeletionResult`; the target is
  derived only from the configured app ID and fresh bearer token.

### Swift

- Added the additive `resource_conflict` typed error used by global app ownership and
  tier-mutation idempotency conflicts. The Swift package remains an end-user data-plane
  client; management mutations stay server-side.
- Added end-user `deleteAccount()` with the typed tombstone/replay result and documented
  the required Weirgate-first, identity-provider-second transaction order.

## 0.1.0 — 2026-07-26

Initial public release for `Weirgate-Api-Version: 2026-07-18`.

### TypeScript

- Typed feature catalog, balance, chat, streaming, embeddings, usage, and client
  telemetry workflows.
- Stable `WeirgateError` values with request and API-version correlation.
- Automatic mutation idempotency, ETag-aware catalog reads, and verified SSE
  termination.
- ESM and CommonJS builds with bundled declarations.

### Swift

- `WeirgateKit` for iOS 17+ and macOS 14+.
- Authenticated catalog, balance, chat, streaming, typed errors, request correlation,
  output contracts, and client TTFT telemetry.
- Ephemeral per-call user-provider credentials with no URL cache.
- Root Swift package manifest for tagged Git URL resolution.

No server API change is included in this release.
