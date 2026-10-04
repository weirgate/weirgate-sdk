# WeirgateKit

Swift Package Manager client for the public Weirgate API frozen at version `2026-07-18`.

Add `https://github.com/weirgate/weirgate-sdk.git` as a package dependency and select the
`WeirgateKit` product. Apps that sell App Store credit packs also select `WeirgateStoreKit`.

```swift
import WeirgateKit

let client = WeirgateClient(
    configuration: .init(appID: "my-app"),
    tokenProvider: .init { try await auth.freshIDToken() }
)

let catalog = try await client.features()
let stream = try await client.streamChat(
    featureID: "coach-chat",
    request: .init(messages: [.text(role: "user", content: "Hello")])
)
for try await chunk in stream.chunks {
    // Render chunk.choices.first?.delta.content
}
```

Delete the authenticated user's Weirgate identity before deleting the corresponding
identity-provider account:

```swift
let deletion = try await client.deleteAccount()
// After this succeeds, delete the Firebase/Auth user.
```

The target comes only from the fresh bearer token and app ID; no external user ID can be
supplied. Replays and no-row calls return idempotent success, so retrying the whole
Weirgate-first sequence after a partial failure is safe.

## Balance and unlimited plans

`balance()` returns `unitsAvailable`, `unitsPending`, and `tier`, plus:

- `unlimited` / `unlimitedUntil`: while a time-limited (or open-ended) unlimited tier is
  active, metered requests debit nothing. `unlimitedUntil` is `nil` when the plan has no
  end date. `unitsAvailable` still reports the real balance.
- `appAccountToken`: a stable UUID for this user row, used for App Store purchases below.

There is no split between monthly-allowance and purchased credits yet: every credit is in
one pool until the server adds a breakdown (weirgate#87).

## Welcome credits (Sign in with Apple)

Apps with a `welcome_grant` give each verified identity free credits once, forever. Sign-in
stays optional (App Review guideline 5.1.1(v)): offer it as the way to get the credits, and
keep the rest of the app working without it.

```swift
import AuthenticationServices

// In your ASAuthorizationControllerDelegate, after Sign in with Apple succeeds:
let credential = authorization.credential as! ASAuthorizationAppleIDCredential
let appleToken = credential.identityToken.flatMap { String(data: $0, encoding: .utf8) }

do {
    let claim = try await client.claimWelcomeCredits(appleIdentityToken: appleToken).value
    switch claim.status {
    case .granted: showCredits(claim.units, balance: claim.unitsAvailable)
    case .alreadyClaimed: hideWelcomeOffer()        // this Apple account already claimed
    case .requiresSignIn: offerSignInWithApple()    // no verified identity reached Weirgate
    }
} catch let error as WelcomeCreditsError {
    switch error.code {
    case .appleIdentityTokenInvalid: offerSignInWithApple()  // expired: get a fresh token
    case .appleUnavailable: retryLater(after: error.retryAfter)
    case .notConfigured: hideWelcomeOffer()
    }
}
```

Firebase apps that already linked Apple to the Firebase user pass `nil`: Weirgate reads the
verified `apple.com` identity from the Firebase ID token. Apps configured with
`require: "none"` also pass `nil`.

When Weirgate can't reach Apple's keys, the call waits for `Retry-After` (capped at 30
seconds) and retries once by default (`maxAttempts: 2`). Nothing is granted in that case, so
retrying is always safe. Claims don't use DeviceCheck, so they work on the simulator.

## App Store credit packs (`WeirgateStoreKit`)

Add the `WeirgateStoreKit` product as well. It is a separate target, so apps that sell
nothing never link StoreKit through `WeirgateKit`.

Create one observer when the app launches and start it, so purchases left unfinished by an
earlier launch, Ask to Buy approvals, and refunds are handled:

```swift
import WeirgateKit
import WeirgateStoreKit

let observer = WeirgateStoreObserver(client: client)
await observer.start()

Task {
    for await event in observer.events {
        switch event.outcome {
        case .redeemed(let redemption): refreshBalance(redemption.unitsAvailable)
        case .revoked: refreshBalance()                      // refunded; finished, no credit
        case .rejected(let error): report(error.code, error.reason)  // left unfinished
        case .failed: break                                  // left unfinished; retried next launch
        }
    }
}
```

Buy through the observer. It reads `balance().appAccountToken` (or uses the token you pass),
adds `.appAccountToken(token)` to the purchase options, sends the signed transaction to
Weirgate, and finishes it by the rules below:

```swift
switch try await observer.purchase(product) {
case .completed(.redeemed(let redemption)): showGranted(redemption.units)
case .completed(let outcome): showPending(outcome)    // stays unfinished; see below
case .pending: showAwaitingApproval()                 // arrives later on `events`
case .userCancelled: break
}
```

If you start the purchase yourself (for example with SwiftUI's `PurchaseAction`), include
`.appAccountToken(balance.appAccountToken)` and pass the result to `observer.handle(_:)`.
To redeem without the observer, call
`client.redeemAppStoreTransaction(jws: verification.jwsRepresentation)` and apply the same
rules.

**When a transaction is finished.** Only after Weirgate returns 200 (`granted` or
`alreadyGranted`), or `purchase_revoked` (the App Store refunded or revoked it).

**When it is left unfinished.**

| Answer | Observer outcome | What happens next |
|---|---|---|
| `purchase_invalid_signature`, `purchase_wrong_app`, `purchase_environment_mismatch`, `purchase_unknown_product`, `purchase_account_mismatch`, `payments_not_configured` | `.rejected` | Permanent for that record: not retried in this session. StoreKit offers it again from `Transaction.unfinished` on the next launch, or when you call `observer.redeemUnfinished()` after a fix (for example, once `payments.apple` config exists) |
| Transport error, 5xx, `rate_limited` | retried, then `.failed` | Up to 4 attempts with exponential backoff (1 s, 2 s, 4 s, capped at 30 s, or longer if `Retry-After` asks); then left for the next launch |
| Any other error (for example `invalid_token`) | `.failed` | Not retried; left for the next launch or `redeemUnfinished()` |

Two redemptions of the same transaction never run at the same time: if the launch sweep and
`Transaction.updates` deliver one transaction together, the second waits for the first and
gets its outcome. By default the observer handles consumables only; pass `shouldRedeem` if
the app also sells products handled elsewhere.

**`appAccountToken` caveat.** The token belongs to the Weirgate user row, not the Apple ID.
A new user row has a new token: an anonymous user who reinstalls, or a user who deleted
their account. Older unfinished transactions that carry the previous token then fail
`purchase_account_mismatch` and stay unfinished (reported as `.rejected`). Sign the user
back in to the same account to redeem them; a purchase made without a token is credited to
whoever redeems it first, unless the app sets `require_app_account_token`.

**Local StoreKit testing.** Transactions from an Xcode `.storekit` configuration are signed
by Xcode, not Apple, so the real Weirgate server answers `purchase_invalid_signature`. That
is expected: the observer reports `.rejected(.invalidSignature)` and leaves them unfinished.
Test real redemption with App Store sandbox (a device build or TestFlight, without a
`.storekit` file in the scheme); sandbox purchases are recorded as `environment: test`.

## Use the user's AI plan (`PlanConnect`)

A feature's funding chain (`funding.order` in its config) decides who pays for each
request: the user's AI plan (`user_plan`), the user's own provider key (`user_key`), or
you (`developer`). `PlanConnect` lets the user connect their ChatGPT Plus or Pro plan with
Sign in with ChatGPT, and `WeirgateClient` then sends the plan's token with each request to
features that accept it.

**Status: not usable with real plans yet.** Plan usage in a paid or remotely hosted app
needs OpenAI's partner approval, for Weirgate and for your app. Until Weirgate records your
app as `approved`, live features answer `funding_rail_unavailable` and only mock features
serve the rail. OpenAI has no plan-usage sandbox before approval, so this SDK is tested
against recorded Weirgate responses, never a real plan.

### Set up

You need the client ID and a redirect URI from your app's partner registration with
OpenAI. Register a custom-scheme redirect (`myapp://oauth/chatgpt`), or a universal link
(`https`, needs iOS 17.4 / macOS 14.4).

```swift
import WeirgateKit

let plan = PlanConnect(
    configuration: .openAIChatGPT(
        clientID: "<from your OpenAI partner registration>",
        redirectURI: URL(string: "myapp://oauth/chatgpt")!,
        agentNameHint: "My App"
    ),
    authorizer: WebAuthenticationSessionAuthorizer { keyWindow() }
)

let client = WeirgateClient(
    configuration: .init(appID: "my-app"),
    tokenProvider: .init { try await auth.freshIDToken() },
    planCredential: plan
)
```

`PlanConnect` signs in with OpenID Connect and PKCE through `ASWebAuthenticationSession`
(scopes `openid profile email offline_access chatgpt.tokens.use.direct`), keeps the tokens in
the Keychain (this device only, never synced), stores the replacement refresh token on every
refresh, refreshes when less than five minutes remain, and serializes refreshes so two
requests never race a rotating token. It creates a stable opaque host ID (`urn:uuid:…`)
before the first sign-in and sends it as `ext_agent_host_id`, as OpenAI requires. Pass your
own `PlanTokenStore` to keep tokens elsewhere; the SDK writes them nowhere else.

### Show the button only where it helps

```swift
if case .modified(let response, _) = try await client.features() {
    showContinueWithChatGPT = response.value.offersPlan(.openAIChatGPT)
    // Or per feature: feature.acceptsPlan(.openAIChatGPT)
}

let status = try await plan.connect()
if case .connected(_, funding: false) = status {
    // The user signed in but did not allow plan usage. The sign-in still identifies them.
    offer("Use your ChatGPT plan") { try await plan.enablePlanUsage() }  // repeats with prompt=consent
}

for await status in await plan.statusUpdates() {
    if case .reconnectRequired = status { showReconnectChatGPT() }
}
```

Requirements to check before shipping:

- **Branding.** Label the button **Continue with ChatGPT** and follow OpenAI's Sign in with
  ChatGPT branding guidelines.
- **Optional sign-in.** Every feature that works without a plan must keep working without
  it (App Review guideline 5.1.1(v)). Offer the plan as a choice, never as a gate.
- **Sign in with Apple.** If ChatGPT is a way to sign in to your app (not just a way to
  pay), offer Sign in with Apple next to it (guideline 4.8).
- **Disconnect is lazy.** OpenAI does not tell apps when a user disconnects them in ChatGPT
  settings. The SDK finds out on the next rejected request and then reports
  `.reconnectRequired`. Link to ChatGPT's settings for disconnect instructions, and call
  `plan.disconnect()` from your own UI (it revokes the refresh token and clears the
  Keychain).
- Your privacy policy discloses that you receive the user's name, email, and profile picture.

### What the client does for you

`chat` and `streamChat` send `X-Weirgate-User-Credential` only to features whose catalog
entry accepts the plan (they read `GET /v1/features` once if they haven't), and report who
paid in `response.metadata.funding` (`rail`, `provider`, and `fallback` when a rail refused
inside the request).

| Server answer | What the SDK does |
|---|---|
| `user_credential_expired` (401) | Refreshes once and repeats the request with the same idempotency key. If the refreshed token is rejected too, or the refresh is refused (`invalid_grant`, `invalid_refresh_token`, `token_expired`, `refresh_token_reused`), clears the tokens and throws `FundingRailError` with `.reconnectRequired` |
| `funding_rail_refused` (402) with `detail.next_rail` | Repeats once on that rail (`X-Weirgate-Funding: <rail>`, idempotency key `<key>:rail:<rail>`, no plan token unless the rail is `user_plan`); at most two hops |
| `funding_rail_refused` without `next_rail` | Throws `FundingRailError` `.railRefused` with `reason`, `providerRequestID` |
| `funding_rail_unavailable` (403) | Throws `.railUnavailable`; a configuration problem, not retried |
| `X-Weirgate-Funding-Fallback: user_plan; …; disable` on a success | Returns the response, clears the plan, and reports `.reconnectRequired(.railDisabled)` |
| Stream ends with `data: {"error": …}` | `chunks` throws `FundingRailError` after the partial chunks. Discard the partial answer and call again with `error.retryOptions(from: options)` when it is non-nil. If the frame has `detail.disable` (`error.disablesRail`) for the plan the stream used, the plan is cleared first and reports `.reconnectRequired(.railDisabled)` |

`FundingPreference` controls where the chain starts: `.serverChain` (default) or
`.startAt(.developer)` to skip the user's plan, per client or per call
(`RequestOptions(funding:)`).

## Privacy and errors

`UserProviderKey` is accepted only per call. It is redacted from descriptions, never
logged by the package, and requests use an ephemeral URL session with no URL cache. Plan
access tokens are sent per request and stored only by `PlanConnect`'s token store.
Typed HTTP failures use `WeirgateError.type`; consumers never inspect message strings.

See the [SDK guide](https://weirgate.com/guides/sdks/) and
[API reference](https://weirgate.com/reference/api/) for the public contract.
