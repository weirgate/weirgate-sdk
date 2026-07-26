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

See the [SDK guide](https://weirgate.com/guides/sdks/) and
[API reference](https://weirgate.com/reference/api/) for the public contract.

## Regeneration

The spec is not forked into this repository. Regenerate from a local Weirgate checkout:

```sh
npm run generate -- --input ../../weirgate/openapi.yaml
```

`spec-provenance.json` records the API version and source commit.
