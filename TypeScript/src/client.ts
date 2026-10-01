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
  UsageTruncatedError,
  WeirgateError,
  WeirgateNetworkError,
  WeirgateProtocolError,
  WeirgateStreamError,
} from "./errors.js";

export interface WeirgateOptions {
  appId?: string;
  baseUrl?: string;
  token?: string | (() => string | Promise<string>);
  adminKey?: string;
  fetch?: typeof globalThis.fetch;
}

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

  constructor(options: WeirgateOptions = {}) {
    this.appId = options.appId;
    this.baseUrl = (options.baseUrl ?? "https://api.weirgate.com").replace(/\/$/, "");
    this.token = options.token;
    this.adminKey = options.adminKey;
    this.fetcher = options.fetch ?? globalThis.fetch;
    if (!this.fetcher) throw new TypeError("A Fetch API implementation is required");
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

  chat(
    featureId: string,
    request: ChatCompletionInput,
    options: RequestOptions = {},
  ): Promise<WeirgateResult<ChatCompletion>> {
    this.requireAppId();
    return this.requestJson("POST", "/v1/chat/completions", { ...request, stream: false }, {
      ...options,
      headers: { "X-Feature-Id": featureId },
    });
  }

  embedding(
    featureId: string,
    request: EmbeddingRequest,
    options: RequestOptions = {},
  ): Promise<WeirgateResult<EmbeddingResponse>> {
    this.requireAppId();
    return this.requestJson("POST", "/v1/embeddings", request, {
      ...options,
      headers: { "X-Feature-Id": featureId },
    });
  }

  telemetry(
    input: ClientTelemetryInput,
    options: RequestOptions = {},
  ): Promise<WeirgateResult<Accepted>> {
    this.requireAppId();
    return this.requestJson("POST", "/v1/telemetry/client", input, options);
  }

  async streamChat(
    featureId: string,
    request: ChatCompletionInput,
    options: RequestOptions = {},
  ): Promise<ChatStream> {
    this.requireAppId();
    const response = await this.send("POST", "/v1/chat/completions", { ...request, stream: true }, {
      ...options,
      headers: { "X-Feature-Id": featureId },
    });
    const metadata = this.metadata(response);
    if (!response.ok) throw await WeirgateError.fromResponse(response);
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
      chunks: this.parseSSE(body, metadata),
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
