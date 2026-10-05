# Weirgate SDKs

Official clients for the public Weirgate API frozen at `Weirgate-Api-Version: 2026-07-18`.

Private beta — invite only; request access: [hello@weirgate.com](mailto:hello@weirgate.com).

- [`TypeScript/`](./TypeScript/) — `@weirgate/sdk` for TypeScript and JavaScript.
- [`WeirgateKit/`](./WeirgateKit/) — `WeirgateKit` for iOS 17+ and macOS 14+.

Both packages are generated or implemented solely from
[`weirgate/openapi.yaml`](https://github.com/weirgate/weirgate/blob/main/openapi.yaml).
The spec itself is not copied into this repository. Each package records the exact source
commit used for generation.

## Install

```sh
npm install @weirgate/sdk
```

For Swift Package Manager, add
`https://github.com/weirgate/weirgate-sdk.git` and select the `WeirgateKit` product (and
`WeirgateStoreKit` to sell App Store credit packs or subscriptions). The root package manifest makes tagged
releases directly resolvable from that URL.

The clients require application-issued end-user JWTs. Provider credentials remain
ephemeral per request and are never persisted or logged by either SDK.

## Account deletion

Both SDKs expose token-bound account deletion: TypeScript
`deleteAccount(): Promise<WeirgateResult<AccountDeletionResult>>` and Swift
`deleteAccount() async throws -> WeirgateResponse<AccountDeletionResult>`. The service
derives the target only from the fresh end-user token and app ID; neither method accepts
an external user ID or management credential.

Apps must delete in this order: call Weirgate first while the token is valid, require a
successful response, then delete the identity-provider user. If the second step fails,
reauthenticate as needed and retry the sequence; Weirgate replay is idempotent.

## Welcome credits, App Store purchases, and subscriptions

`WeirgateKit` claims one-time welcome credits after Sign in with Apple
(`claimWelcomeCredits(appleIdentityToken:)`), reports unlimited plans, the monthly
allowance / purchased split, and the user's `appAccountToken` on `balance()`, and redeems
StoreKit 2 consumable purchases and auto-renewable subscriptions
(`redeemAppStoreTransaction(jws:)`). The separate `WeirgateStoreKit` product adds
`WeirgateStoreObserver`, which buys with the user's `appAccountToken`, redeems unfinished and
updated transactions (including subscription renewals), restores current subscriptions,
and finishes each one only when Weirgate handles it or reports it refunded. TypeScript has
the same redeem call (`redeemAppleTransaction`) and the balance split. See the [WeirgateKit README](./WeirgateKit/README.md#app-store-credit-packs-weirgatestorekit).

## Use the user's AI plan (funding rails)

Each feature's funding chain decides who pays for a request: the user's AI plan
(`user_plan`, first provider `openai_chatgpt`), the user's own provider key (`user_key`),
or the developer (`developer`). Swift's `PlanConnect` connects the user's ChatGPT plan with
Sign in with ChatGPT (PKCE, Keychain, rotating refresh); both clients send the plan token
per request only to features that accept it, report who paid, apply the funding retry
rules, and type the three funding errors and the mid-stream error frame. Web apps implement
`PlanCredentialSource` against their own server; the
[TypeScript README](./TypeScript/README.md#use-the-users-ai-plan-web-apps) has the recipe.
See the [WeirgateKit README](./WeirgateKit/README.md#use-the-users-ai-plan-planconnect).

Plan usage in a paid or remotely hosted app needs OpenAI's partner approval, and OpenAI has
no plan-usage sandbox before approval. No app is approved yet, so none of this has run
against a real plan: tests replay Weirgate responses recorded from the server
([`fixtures/funding-rails/`](./fixtures/funding-rails/)).

## Credits API (TypeScript, server-side)

Developer servers that sell credits through their own payment system (Stripe,
RevenueCat, or a custom backend) use `createGrant`, `reverseGrant`, `adjustCredits`,
`getUserCredits`, and `rotateAdminKey` with a credits-only management key. Credit writes
require your own idempotency key. See the
[TypeScript README](./TypeScript/README.md#credits-api-for-your-own-payment-system) for
recipes.

Read the [SDK guide](https://weirgate.com/guides/sdks/) and
[API reference](https://weirgate.com/reference/api/).
