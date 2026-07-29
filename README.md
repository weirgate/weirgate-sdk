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
`https://github.com/weirgate/weirgate-sdk.git` and select the `WeirgateKit` product. The
root package manifest makes tagged releases directly resolvable from that URL.

The clients require application-issued end-user JWTs. Provider credentials remain
ephemeral per request and are never persisted or logged by either SDK.

Read the [SDK guide](https://weirgate.com/guides/sdks/) and
[API reference](https://weirgate.com/reference/api/).
