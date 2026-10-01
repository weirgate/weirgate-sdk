# Changelog

All notable public SDK changes are recorded here.

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
