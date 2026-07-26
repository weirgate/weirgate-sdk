# Weirgate SDK 0.1.0 release notes

`@weirgate/sdk` and `WeirgateKit` are the first official typed clients for the public
Weirgate API frozen at `2026-07-18`.

The TypeScript package ships ESM, CommonJS, and declaration outputs. The Swift package
resolves from the repository root and supports iOS 17+ and macOS 14+. Both clients keep
the application in control of fresh end-user authentication while preserving Weirgate's
server-owned feature routing, typed errors, request correlation, and ephemeral BYOK
boundary.

## Verification before the founder ceremonies

- Full Git history scanned for secrets with findings redacted.
- Public API boundary scan passed.
- TypeScript tests, typecheck, build, and npm package dry-run passed.
- npm tarball contains the MIT license, README, provenance, declarations, ESM, and CJS.
- Swift tests passed from both the public root manifest and the nested development
  package.
- Clean local consumers resolved the packed npm tarball and root Swift package.

## Founder ceremonies

1. Publish `@weirgate/sdk@0.1.0` with `npm publish --access public`.
2. Change `weirgate/weirgate-sdk` visibility to public only after the history scan passes.
3. Publish these notes for tag `v0.1.0`.

No API, MCP, dashboard, or runtime behavior changes are part of this release.
