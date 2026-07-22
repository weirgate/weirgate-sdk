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
