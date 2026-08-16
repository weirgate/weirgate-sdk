# WeirgateKit

Swift Package Manager client for the public Weirgate API frozen at version `2026-07-18`.

Add `https://github.com/weirgate/weirgate-sdk.git` as a package dependency and select the
`WeirgateKit` product.

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

`UserProviderKey` is accepted only per call. It is redacted from descriptions, never
logged by the package, and requests use an ephemeral URL session with no URL cache.
Typed HTTP failures use `WeirgateError.type`; consumers never inspect message strings.

See the [SDK guide](https://weirgate.com/guides/sdks/) and
[API reference](https://weirgate.com/reference/api/) for the public contract.
