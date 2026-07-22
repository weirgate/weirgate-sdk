import {
  API_VERSION,
  type Accepted,
  type Balance,
  type CatalogResult,
  type ChatCompletion,
  type ChatCompletionChunk,
  type ChatCompletionInput,
  type ChatStream,
  type ClientTelemetryInput,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type FeatureCatalog,
  type Health,
  type RequestOptions,
  type ResponseMetadata,
  type UsageQuery,
  type UsageRollupPage,
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
