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

Mutations receive an automatic `X-Idempotency-Key`; pass `idempotencyKey` to override it.
Server failures are `WeirgateError` values keyed by `error.type`, never message text.
Every result and error carries `requestId` and `apiVersion` correlation metadata.

Server-side management clients can schedule a configured per-user tier with an admin
key. The change activates at the next UTC monthly grant period; `top_up_now` grants only
the positive current-period allowance delta:

```ts
const admin = new Weirgate({ adminKey: process.env.WEIRGATE_API_KEY });
await admin.assignUserTier("my-app", "supporter-code-user", {
  tier: "early-adopter",
  top_up_now: true,
}, { idempotencyKey: "supporter-tier-2026-08" });
```

Keep admin keys server-side. End-user applications must not embed this management
surface or its credential.

See the [SDK guide](https://weirgate.com/guides/sdks/) and
[API reference](https://weirgate.com/reference/api/) for the public contract.

## Regeneration

The spec is not forked into this repository. Regenerate from a local Weirgate checkout:

```sh
npm run generate -- --input ../../weirgate/openapi.yaml
```

`spec-provenance.json` records the API version and source commit.
