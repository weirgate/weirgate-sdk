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
6. Provider identifiers use `google` and `xai`, while an app's user-facing
   names and feature IDs may use Gemini and Grok. SDK consumers still need a presentation
   mapping without treating provider/model labels as capability identity.

## Funding rails (2026-10-03, weirgate `25282cf`)

7. A client may send `X-Weirgate-User-Credential` only to features whose chain contains
   `user_plan` (otherwise `invalid_request`), so SDKs must read the catalog before the first
   plan-funded call. Both SDKs cache `funding` from `GET /v1/features` and read it once when
   a feature is unknown.
8. `detail.next_rail` was always `null` in the 25282cf server, including the mid-stream
   error frame of a chain that has a later rail. **Fixed in weirgate `0738d89`
   (weirgate#127):** a mid-stream refusal names the next fundable rail when `on_refusal`
   moves on, plus `detail.disable` for `next_and_disable`. Before headers it stays `null` by
   design (the server falls through inside the request), so the SDKs' pre-header
   `next_rail` retry is forward-compatible and does not fire against today's server.
9. Retrying with the same idempotency key after `user_credential_expired`, as the contract
   says, reused the refunded reservation in 25282cf: the retry was served but not recorded
   or metered. **Fixed in weirgate `0738d89` (weirgate#127):** a refunded reservation is
   reopened as a new attempt. The fixtures in `fixtures/funding-rails/` are recorded
   against `0738d89`.
