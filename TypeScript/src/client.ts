import {
  API_VERSION,
  type AccountDeletionResult,
  type Accepted,
  type Balance,
  type CatalogResult,
  type ChatCompletion,
  type ChatCompletionChunk,
  type ChatCompletionInput,
  type ChatStream,
  type ClientTelemetryInput,
  type CreditAdjustmentInput,
  type CreditAdjustmentResult,
  type CreditWriteOptions,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type FeatureCatalog,
  type GrantInput,
  type GrantResult,
  type GrantReversalResult,
  type Health,
  type ManagementKeyRotateInput,
  type RequestOptions,
  type ResponseMetadata,
  type RotateAdminKeyOptions,
  type RotatedManagementKey,
  type UsageQuery,
  type UsageRollupPage,
  type UserCredits,
  type UserTierAssignmentInput,
  type UserTierChangeResult,
  type UserTierRevertInput,
  type WeirgateResult,
} from "./types.js";
import {
  FundingRailError,
  PlanReconnectRequiredError,
  UsageTruncatedError,
  WeirgateError,
  WeirgateNetworkError,
  WeirgateProtocolError,
  WeirgateStreamError,
  errorFromStreamFrame,
} from "./errors.js";
import {
  fundingHeaderValue,
  parseFundingHeaders,
  type FundingOutcome,
  type FundingPreference,
  type FundingRail,
  type PlanCredentialSource,
} from "./funding.js";

export interface WeirgateOptions {
  appId?: string;
  baseUrl?: string;
  token?: string | (() => string | Promise<string>);
  adminKey?: string;
  fetch?: typeof globalThis.fetch;
  /** Default starting rail for chat, streaming, and embeddings. Default: `"server_chain"`. */
  fundingPreference?: FundingPreference;
  /**
   * The end user's plan connection for the `user_plan` rail. When it has a funding token,
   * requests to features whose catalog entry accepts its provider send it as
   * `X-Weirgate-User-Credential`.
   */
  planCredential?: PlanCredentialSource;
}

type FeatureFunding = FeatureCatalog["data"][number]["funding"];

/** At most this many `next_rail` hops per call. */
const MAX_RAIL_HOPS = 2;
/** Re-read the catalog for an unknown feature at most this often. */
const CATALOG_REFRESH_MS = 5 * 60_000;

interface InternalRequestOptions extends RequestOptions {
  headers?: HeadersInit | undefined;
  admin?: boolean | undefined;
  /** Reject a missing key instead of generating one. */
  requireIdempotencyKey?: boolean | undefined;
}

export class Weirgate {
  readonly appId: string | undefined;
  readonly baseUrl: string;
  private readonly token: WeirgateOptions["token"] | undefined;
  private readonly adminKey: string | undefined;
  private readonly fetcher: typeof globalThis.fetch;
  private fundingPreference: FundingPreference;
  private planCredential: PlanCredentialSource | undefined;
  /** Feature chains from the last catalog read, so a plan token goes only where it is accepted. */
  private catalogFunding = new Map<string, FeatureFunding>();
  private catalogReadAt: number | null = null;

  constructor(options: WeirgateOptions = {}) {
    this.appId = options.appId;
    this.baseUrl = (options.baseUrl ?? "https://api.weirgate.com").replace(/\/$/, "");
    this.token = options.token;
    this.adminKey = options.adminKey;
    this.fetcher = options.fetch ?? globalThis.fetch;
    if (!this.fetcher) throw new TypeError("A Fetch API implementation is required");
    this.fundingPreference = options.fundingPreference ?? "server_chain";
    this.planCredential = options.planCredential;
  }

  /** Attach or remove the plan connection used for the `user_plan` rail. */
  setPlanCredential(source: PlanCredentialSource | undefined): void {
    this.planCredential = source;
  }

  /** Change the default starting rail for later calls. */
  setFundingPreference(preference: FundingPreference): void {
    this.fundingPreference = preference;
  }

  health(signal?: AbortSignal): Promise<WeirgateResult<Health>> {
    return this.requestJson("GET", "/healthz", undefined, { signal });
  }

  async features(etag?: string, signal?: AbortSignal): Promise<CatalogResult> {
    const appId = this.requireAppId();
    const response = await this.send("GET", "/v1/features", undefined, {
      signal,
      headers: etag ? { "If-None-Match": etag } : undefined,
    });
    const metadata = this.metadata(response);
    const responseEtag = response.headers.get("etag") ?? etag ?? null;
    if (response.status === 304) {
      return { kind: "not_modified", etag: responseEtag, headers: response.headers, ...metadata };
    }
    if (!response.ok) throw await WeirgateError.fromResponse(response);
    const data = await this.json<FeatureCatalog>(response, metadata);
    this.catalogFunding = new Map(
      data.data.filter((entry) => entry.funding).map((entry) => [entry.feature_id, entry.funding]),
    );
    this.catalogReadAt = Date.now();
    return { kind: "modified", data, etag: responseEtag, headers: response.headers, ...metadata };
  }

  balance(signal?: AbortSignal): Promise<WeirgateResult<Balance>> {
    this.requireAppId();
    return this.requestJson("GET", "/v1/balance", undefined, { signal });
  }

  deleteAccount(signal?: AbortSignal): Promise<WeirgateResult<AccountDeletionResult>> {
    this.requireAppId();
    return this.requestJson("DELETE", "/v1/account", undefined, { signal });
  }

  /**
   * A chat completion. The feature's funding chain decides who pays. Retries happen here:
   * `user_credential_expired` refreshes the plan once and repeats the request with the same
   * idempotency key; `funding_rail_refused` with `next_rail` repeats it once on that rail.
   */
  async chat(
    featureId: string,
    request: ChatCompletionInput,
    options: RequestOptions = {},
  ): Promise<WeirgateResult<ChatCompletion>> {
    this.requireAppId();
    const { response, metadata, funding } = await this.funded(
      "/v1/chat/completions", featureId, { ...request, stream: false }, options,
    );
    return { data: await this.json<ChatCompletion>(response, metadata), headers: response.headers, funding, ...metadata };
  }

  async embedding(
    featureId: string,
    request: EmbeddingRequest,
    options: RequestOptions = {},
  ): Promise<WeirgateResult<EmbeddingResponse>> {
    this.requireAppId();
    const { response, metadata, funding } = await this.funded("/v1/embeddings", featureId, request, options);
    return { data: await this.json<EmbeddingResponse>(response, metadata), headers: response.headers, funding, ...metadata };
  }

  telemetry(
    input: ClientTelemetryInput,
    options: RequestOptions = {},
  ): Promise<WeirgateResult<Accepted>> {
    this.requireAppId();
    return this.requestJson("POST", "/v1/telemetry/client", input, options);
  }

  /**
   * A streamed chat completion with `chat`'s funding behavior before headers. After the
   * stream starts, a rail refusal is the stream's final frame: `chunks` throws a
   * `FundingRailRefusedError` (no usage, no `[DONE]`). Discard the partial answer and call
   * again with `error.retryOptions(options)`. When `error.disable` is set for the plan this
   * call sent, `requireReconnect({ kind: "rail_disabled" })` has already been called.
   */
  async streamChat(
    featureId: string,
    request: ChatCompletionInput,
    options: RequestOptions = {},
  ): Promise<ChatStream> {
    this.requireAppId();
    const { response, metadata, funding, idempotencyKey, planSource } = await this.funded(
      "/v1/chat/completions", featureId, { ...request, stream: true }, options,
    );
    if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
      throw new WeirgateStreamError(
        "invalid_content_type",
        metadata.requestId,
        metadata.apiVersion,
        "Weirgate streaming response was not text/event-stream",
      );
    }
    if (!response.body) {
      throw new WeirgateStreamError("missing_body", metadata.requestId, metadata.apiVersion, "Stream body was missing");
    }
    const body = response.body;
    return {
      ...metadata,
      creditsRemaining: numericHeader(response.headers.get("x-credits-remaining")),
      chunks: this.parseSSE(body, metadata, idempotencyKey, planSource),
      funding,
    };
  }

  usage(appId: string, query: UsageQuery = {}): Promise<WeirgateResult<UsageRollupPage>> {
    const parameters = new URLSearchParams();
    if (query.since) parameters.set("since", dateParameter(query.since));
    if (query.until) parameters.set("until", dateParameter(query.until));
    if (query.limit !== undefined) parameters.set("limit", String(query.limit));
    if (query.groupBy) parameters.set("group_by", query.groupBy);
    const suffix = parameters.size ? `?${parameters}` : "";
    return this.requestJson(
      "GET",
      `/v1/admin/apps/${encodeURIComponent(appId)}/usage${suffix}`,
      undefined,
      { admin: true, signal: query.signal },
    );
  }

  async completeUsage(appId: string, query: Omit<UsageQuery, "limit"> = {}): Promise<WeirgateResult<UsageRollupPage>> {
    const result = await this.usage(appId, { ...query, limit: 500 });
    if (result.data.pagination.truncated) {
      throw new UsageTruncatedError(
        result.requestId,
        result.apiVersion,
        result.data.pagination.limit,
        result.data.pagination.returned,
      );
    }
    return result;
  }

  assignUserTier(
    appId: string,
    externalId: string,
    input: UserTierAssignmentInput,
    options: RequestOptions = {},
  ): Promise<WeirgateResult<UserTierChangeResult>> {
    const { expires_at: expiresAt, ...rest } = input;
    const body = expiresAt === undefined ? rest : { ...rest, expires_at: dateParameter(expiresAt) };
    return this.requestJson(
      "PUT",
      `/v1/admin/apps/${encodeURIComponent(appId)}/users/${encodeURIComponent(externalId)}/tier`,
      body,
      { admin: true, ...options },
    );
  }

  revertUserTier(
    appId: string,
    externalId: string,
    input: UserTierRevertInput = {},
    options: RequestOptions = {},
  ): Promise<WeirgateResult<UserTierChangeResult>> {
    return this.requestJson(
      "DELETE",
      `/v1/admin/apps/${encodeURIComponent(appId)}/users/${encodeURIComponent(externalId)}/tier`,
      input,
      { admin: true, ...options },
    );
  }

  /** Add purchased credits. The same key and body replay the original grant. */
  createGrant(
    appId: string,
    externalId: string,
    input: GrantInput,
    options: CreditWriteOptions,
  ): Promise<WeirgateResult<GrantResult>> {
    return this.requestJson(
      "POST",
      `/v1/admin/apps/${encodeURIComponent(appId)}/users/${encodeURIComponent(externalId)}/grants`,
      input,
      { admin: true, requireIdempotencyKey: true, ...options },
    );
  }

  /** Cancel a whole grant, e.g. on a full refund. Reversing twice returns it unchanged. */
  reverseGrant(
    appId: string,
    grantId: string,
    options: CreditWriteOptions,
  ): Promise<WeirgateResult<GrantReversalResult>> {
    return this.requestJson(
      "POST",
      `/v1/admin/apps/${encodeURIComponent(appId)}/grants/${encodeURIComponent(grantId)}/reverse`,
      undefined,
      { admin: true, requireIdempotencyKey: true, ...options },
    );
  }

  /**
   * Record a signed correction. A deduction below zero throws `InsufficientBalanceError`
   * unless `allow_negative` is true, which is the default for `reason: "clawback"`.
   */
  adjustCredits(
    appId: string,
    externalId: string,
    input: CreditAdjustmentInput,
    options: CreditWriteOptions,
  ): Promise<WeirgateResult<CreditAdjustmentResult>> {
    return this.requestJson(
      "POST",
      `/v1/admin/apps/${encodeURIComponent(appId)}/users/${encodeURIComponent(externalId)}/adjustments`,
      input,
      { admin: true, requireIdempotencyKey: true, ...options },
    );
  }

  /** Balance, unlimited state, grants, adjustments, tier changes, and recent usage. */
  getUserCredits(
    appId: string,
    externalId: string,
    signal?: AbortSignal,
  ): Promise<WeirgateResult<UserCredits>> {
    return this.requestJson(
      "GET",
      `/v1/admin/apps/${encodeURIComponent(appId)}/users/${encodeURIComponent(externalId)}`,
      undefined,
      { admin: true, signal },
    );
  }

  /**
   * Replace a management key. The new value is revealed once in `data.value`; the old
   * key keeps working for `overlap_seconds`. A second rotation of the same key throws
   * `ResourceConflictError` with `replacedByKeyId`.
   */
  rotateAdminKey(
    keyId: string,
    input: ManagementKeyRotateInput = {},
    options: RotateAdminKeyOptions = {},
  ): Promise<WeirgateResult<RotatedManagementKey>> {
    const suffix = options.tenantId ? `?${new URLSearchParams({ tenant_id: options.tenantId })}` : "";
    return this.requestJson(
      "POST",
      `/v1/admin/keys/${encodeURIComponent(keyId)}/rotate${suffix}`,
      input,
      { admin: true, signal: options.signal },
    );
  }

  /** One funded data-plane call with plan header injection and the funding retry rules. */
  private async funded(
    path: string,
    featureId: string,
    body: unknown,
    options: RequestOptions,
  ): Promise<{
    response: Response;
    metadata: ResponseMetadata;
    funding: FundingOutcome | null;
    idempotencyKey: string;
    /** The plan whose token this response's request carried, if any. */
    planSource: PlanCredentialSource | null;
  }> {
    let idempotencyKey = options.idempotencyKey ?? randomIdempotencyKey();
    let preference = options.funding ?? this.fundingPreference;
    const source = this.planCredential;
    let token = await this.planToken(featureId, preference, source);
    let refreshed = false;
    let hops = 0;
    for (;;) {
      const headers: Record<string, string> = { "X-Feature-Id": featureId };
      const funding = this.fundingHeader(featureId, preference, token, source);
      if (funding) headers["X-Weirgate-Funding"] = funding;
      if (token) headers["X-Weirgate-User-Credential"] = token;
      const response = await this.send("POST", path, body, { ...options, idempotencyKey, headers });
      const metadata = this.metadata(response);
      if (response.ok) {
        const outcome = parseFundingHeaders(response.headers);
        if (source && token && outcome?.fallback?.disable && outcome.fallback.refusedRail === "user_plan") {
          await source.requireReconnect({ kind: "rail_disabled", reason: outcome.fallback.reason });
        }
        return { response, metadata, funding: outcome, idempotencyKey, planSource: token && source ? source : null };
      }
      const error = await WeirgateError.fromResponse(response);
      if (error instanceof FundingRailError) error.idempotencyKey = idempotencyKey;
      if (error.type === "user_credential_expired" && source && token) {
        if (refreshed) {
          const reason = { kind: "credential_rejected" as const, providerCode: (error as FundingRailError).providerCode };
          await source.requireReconnect(reason);
          throw new PlanReconnectRequiredError(reason, error);
        }
        refreshed = true;
        const result = await source.refreshAccessToken(token);
        if (result.kind === "reconnect_required") throw new PlanReconnectRequiredError(result.reason, error);
        token = result.accessToken;
        continue;
      }
      if (error instanceof FundingRailError && error.type === "funding_rail_refused" && error.nextRail && hops < MAX_RAIL_HOPS) {
        hops += 1;
        const next: FundingRail = error.nextRail;
        idempotencyKey = `${idempotencyKey}:rail:${next}`;
        preference = { startAt: next };
        if (next !== "user_plan") token = null;
        continue;
      }
      throw error;
    }
  }

  /** The plan token to send, or null when the chain starts past the plan, the feature does not accept the provider, or the plan is not funding. */
  private async planToken(
    featureId: string,
    preference: FundingPreference,
    source: PlanCredentialSource | undefined,
  ): Promise<string | null> {
    if (!source) return null;
    if (preference !== "server_chain") {
      if (preference.startAt !== "user_plan") return null;
      if (preference.provider && preference.provider !== source.provider) return null;
    }
    const accepts = (funding: FeatureFunding | undefined) => Boolean(funding
      && (funding.order as readonly string[]).includes("user_plan")
      && (funding.plan_providers as readonly string[]).includes(source.provider));
    const known = this.catalogFunding.get(featureId);
    if (known) return accepts(known) ? await source.fundingAccessToken() : null;
    // Read the catalog only when there is a token to send.
    const token = await source.fundingAccessToken();
    if (!token) return null;
    return accepts(await this.featureFunding(featureId)) ? token : null;
  }

  private fundingHeader(
    featureId: string,
    preference: FundingPreference,
    token: string | null,
    source: PlanCredentialSource | undefined,
  ): string | null {
    if (!token || !source) return fundingHeaderValue(preference);
    const plan = fundingHeaderValue({ startAt: "user_plan", provider: source.provider });
    if (preference !== "server_chain") return plan;
    // The server defaults to the feature's first plan provider; name ours otherwise.
    return this.catalogFunding.get(featureId)?.plan_providers[0] === source.provider ? null : plan;
  }

  /** A failed catalog read means "no plan" rather than a failed call. */
  private async featureFunding(featureId: string): Promise<FeatureFunding | undefined> {
    const known = this.catalogFunding.get(featureId);
    if (known) return known;
    if (this.catalogReadAt !== null && Date.now() - this.catalogReadAt < CATALOG_REFRESH_MS) return undefined;
    this.catalogReadAt = Date.now();
    await this.features().catch(() => undefined);
    return this.catalogFunding.get(featureId);
  }

  private async requestJson<T>(
    method: string,
    path: string,
    body: unknown,
    options: InternalRequestOptions = {},
  ): Promise<WeirgateResult<T>> {
    const response = await this.send(method, path, body, options);
    const metadata = this.metadata(response);
    if (!response.ok) throw await WeirgateError.fromResponse(response);
    return { data: await this.json<T>(response, metadata), headers: response.headers, ...metadata };
  }

  private async send(
    method: string,
    path: string,
    body: unknown,
    options: InternalRequestOptions,
  ): Promise<Response> {
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json, text/event-stream");
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (this.appId && !options.admin) headers.set("X-App-Id", this.appId);
    if (options.admin) {
      if (!this.adminKey) throw new TypeError("adminKey is required for management API calls");
      headers.set("X-Admin-Key", this.adminKey);
    } else if (this.token) {
      headers.set("Authorization", `Bearer ${await this.resolveToken()}`);
    }
    if (options.userProviderKey) headers.set("X-User-Provider-Key", options.userProviderKey);
    if (options.requireIdempotencyKey && !options.idempotencyKey?.trim()) {
      throw new TypeError("idempotencyKey is required: derive it from your payment event or order ID");
    }
    if (!safeMethod(method)) headers.set("X-Idempotency-Key", options.idempotencyKey ?? randomIdempotencyKey());

    try {
      return await this.fetcher(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      throw new WeirgateNetworkError(error);
    }
  }

  private async *parseSSE(
    body: ReadableStream<Uint8Array>,
    metadata: ResponseMetadata,
    idempotencyKey: string | null = null,
    planSource: PlanCredentialSource | null = null,
  ): AsyncGenerator<ChatCompletionChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawDone = false;
    let sawFinalUsage = false;
    let sawFinishReason = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? "";
        if (done && buffer.trim()) {
          frames.push(buffer);
          buffer = "";
        }
        for (const frame of frames) {
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          if (data === "[DONE]") {
            sawDone = true;
            continue;
          }
          let chunk: ChatCompletionChunk;
          try {
            chunk = JSON.parse(data) as ChatCompletionChunk;
          } catch {
            throw new WeirgateStreamError(
              "invalid_frame",
              metadata.requestId,
              metadata.apiVersion,
              "Weirgate stream contained invalid JSON",
            );
          }
          const frameError = (chunk as { error?: unknown }).error;
          if (frameError && typeof frameError === "object") {
            // A typed refusal after the stream started (x-weirgate-sse mid_stream_error).
            const error = errorFromStreamFrame(frameError, metadata);
            if (error instanceof FundingRailError) {
              error.idempotencyKey = idempotencyKey;
              // `next_and_disable` mid-stream: stop offering the plan until the user re-consents.
              if (planSource && error.disable && error.rail === "user_plan") {
                await planSource.requireReconnect({ kind: "rail_disabled", reason: error.reason });
              }
            }
            throw error;
          }
          if (!Array.isArray(chunk.choices)) {
            throw new WeirgateStreamError(
              "invalid_frame",
              metadata.requestId,
              metadata.apiVersion,
              "Weirgate stream frame omitted choices",
            );
          }
          if (chunk.usage) sawFinalUsage = true;
          if (chunk.choices.some((choice) => choice["finish_reason"] != null)) sawFinishReason = true;
          yield chunk;
        }
        if (done) break;
      }
    } finally {
      reader.releaseLock();
    }
    if (!sawDone || !sawFinalUsage || !sawFinishReason) {
      throw new WeirgateStreamError(
        "interrupted",
        metadata.requestId,
        metadata.apiVersion,
        "Weirgate stream ended before final usage, finish reason, and [DONE]",
      );
    }
  }

  private metadata(response: Response): ResponseMetadata {
    const requestId = response.headers.get("x-weirgate-request-id");
    const apiVersion = response.headers.get("weirgate-api-version");
    if (!requestId || !apiVersion) {
      throw new WeirgateProtocolError(
        "Weirgate response omitted required correlation headers",
        requestId ?? "unavailable",
        apiVersion ?? API_VERSION,
        response.status,
      );
    }
    return { requestId, apiVersion, status: response.status };
  }

  private async json<T>(response: Response, metadata: ResponseMetadata): Promise<T> {
    try {
      return await response.json() as T;
    } catch {
      throw new WeirgateProtocolError(
        "Weirgate response body was not valid JSON",
        metadata.requestId,
        metadata.apiVersion,
        response.status,
      );
    }
  }

  private requireAppId(): string {
    if (!this.appId) throw new TypeError("appId is required for data-plane calls");
    return this.appId;
  }

  private async resolveToken(): Promise<string> {
    return typeof this.token === "function" ? await this.token() : this.token ?? "";
  }
}

function safeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function dateParameter(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function numericHeader(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function randomIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `wg_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
