# SDK consumer paper cuts

Contract source: Weirgate API `2026-07-18` at source commit `69a4e6b2f081ff9c7afd8cdc12618f9e2bd84a82`.

These observations are inputs to a future additive versioning discussion. They did not
change the frozen contract in this slice.

1. `ChatCompletionRequest` and `ChatCompletionChunk` intentionally allow arbitrary
   OpenAI-compatible fields. Generated clients therefore lose useful static structure at
   exactly the streaming boundary and SDKs must provide a typed common subset.
2. Windowed usage reports expose `pagination.truncated` but no cursor or continuation
   token. An SDK can detect and reject an incomplete report, but cannot retrieve the
   remaining groups without changing the query shape or window.
3. Catalog `304` is specified as an error response by many OpenAPI generators. A usable
   SDK needs a dedicated `not_modified` result rather than treating normal cache
   revalidation as an exception.
4. The catalog narrative calls for a client-safe output summary, while the frozen
   `FeatureCatalogEntry` schema currently exposes availability and key policy only.
   `OutputContract` is typed for management/config consumers but cannot be discovered
   from the data-plane catalog.
5. Typed HTTP errors are available only before SSE headers are committed. A mid-stream
   upstream failure is necessarily a distinct transport/protocol error, so consumers
   must handle both the enumerable registry and an interrupted stream.
6. Provider identifiers use `google` and `xai`, while Denali's established user-facing
   names and feature IDs use Gemini and Grok. SDK consumers still need a presentation
   mapping without treating provider/model labels as capability identity.

## Funding rails (2026-10-03, weirgate `25282cf`)

7. A client may send `X-Weirgate-User-Credential` only to features whose chain contains
   `user_plan` (otherwise `invalid_request`), so SDKs must read the catalog before the first
   plan-funded call. Both SDKs cache `funding` from `GET /v1/features` and read it once when
   a feature is unknown.
8. `detail.next_rail` is always `null` in the 25282cf server, including the mid-stream
   error frame of a chain that has a later rail. The SDKs implement the documented retry,
   but it never fires until the server fills `next_rail` for mid-stream refusals.
9. Retrying with the same idempotency key after `user_credential_expired`, as the contract
   says, reuses the refunded reservation: the retried request is served, but no usage event
   is written and it is not metered. Found by recording against the server.
