/**
 * OpenAI provider adapter for the CLU-E Model Gateway — DEV-P2-09.
 *
 * Uses the Responses API for interactive calls and the Batch API for latency-tolerant
 * work. The adapter owns HTTP syntax only: routing, budgets, mission authority and durable
 * recording stay in the gateway service. Fetch is injectable so every network path is
 * exercised without a live credential.
 */

import { TextDecoder } from 'node:util';

import { z } from 'zod';

import { redactSecretText } from '../../shared/secretSafety.js';
import type { GatewayRoutingPolicy } from './policy.js';

export type GatewayFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface OpenAiRequest {
  readonly callId: string;
  readonly model: string;
  readonly input: string;
  readonly instructions: string | null;
  readonly maxOutputTokens: number;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface OpenAiUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface OpenAiCompletedResponse {
  readonly providerRequestId: string;
  readonly model: string;
  readonly outputText: string;
  readonly usage: OpenAiUsage;
  readonly raw: unknown;
}

export interface OpenAiBatchSubmission {
  readonly inputFileId: string;
  readonly providerBatchId: string;
  readonly providerStatus: string;
  readonly raw: unknown;
}

export type OpenAiBatchReconciliation =
  | {
      readonly state: 'pending';
      readonly providerBatchId: string;
      readonly providerStatus: string;
      readonly raw: unknown;
    }
  | {
      readonly state: 'completed';
      readonly providerBatchId: string;
      readonly providerStatus: string;
      readonly response: OpenAiCompletedResponse;
      readonly raw: unknown;
    }
  | {
      readonly state: 'failed';
      readonly providerBatchId: string;
      readonly providerStatus: string;
      readonly code: string;
      readonly message: string;
      readonly raw: unknown;
    };

export class OpenAiGatewayError extends Error {
  public readonly code: string;
  public readonly status: number | null;
  public readonly retryable: boolean;

  public constructor(
    code: string,
    message: string,
    options: { readonly status?: number | null; readonly retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'OpenAiGatewayError';
    this.code = code;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
  }
}

const uploadSchema = z.object({ id: z.string().min(1) }).passthrough();
const batchSchema = z
  .object({
    id: z.string().min(1),
    status: z.string().min(1),
    output_file_id: z.string().min(1).nullable().optional(),
    error_file_id: z.string().min(1).nullable().optional(),
    errors: z.unknown().optional(),
  })
  .passthrough();

const batchOutputLineSchema = z
  .object({
    custom_id: z.string().min(1),
    response: z
      .object({
        status_code: z.number().int(),
        request_id: z.string().nullable().optional(),
        body: z.unknown(),
      })
      .nullable()
      .optional(),
    error: z.unknown().nullable().optional(),
  })
  .passthrough();

const terminalBatchFailures = new Set(['failed', 'expired', 'cancelled']);
const pendingBatchStates = new Set([
  'validating',
  'in_progress',
  'finalizing',
  'cancelling',
]);

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, '')}${path}`;
}

function readInteger(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

interface ProviderErrorDetails {
  readonly message: string;
  readonly code: string | null;
  readonly type: string | null;
}

function providerErrorDetails(body: unknown, fallback: string): ProviderErrorDetails {
  const record = asRecord(body);
  const error = record === null ? null : asRecord(record['error']);
  return {
    message: typeof error?.['message'] === 'string' && error['message'].length > 0
      ? error['message']
      : fallback,
    code: typeof error?.['code'] === 'string' ? error['code'] : null,
    type: typeof error?.['type'] === 'string' ? error['type'] : null,
  };
}

/** Billing exhaustion is narrower than a generic 429/rate-limit response. */
export function classifyProviderHttpError(
  status: number,
  body: unknown,
  fallback: string,
): OpenAiGatewayError {
  const detail = providerErrorDetails(body, fallback);
  const evidence = `${detail.code ?? ''} ${detail.type ?? ''} ${detail.message}`.toLowerCase();
  const budgetExhausted =
    status === 402 ||
    /(?:insufficient[_\s-]*(?:quota|credit|funds)|billing[_\s-]*(?:hard[_\s-]*limit|limit|inactive|exhausted)|credit[_\s-]*(?:balance[_\s-]*)?exhausted|payment[_\s-]*required|hard[_\s-]*limit[_\s-]*(?:reached|exceeded))/u.test(evidence);
  const safeMessage = redactSecretText(detail.message).text;
  if (budgetExhausted) {
    return new OpenAiGatewayError('PROVIDER_BUDGET_EXHAUSTED', safeMessage, {
      status,
      retryable: false,
    });
  }
  if (status === 429) {
    return new OpenAiGatewayError('PROVIDER_RATE_LIMIT', safeMessage, { status, retryable: true });
  }
  return new OpenAiGatewayError(`PROVIDER_HTTP_${status}`, safeMessage, {
    status,
    retryable: status >= 500,
  });
}

function extractOutputText(body: Record<string, unknown>): string {
  const direct = body['output_text'];
  if (typeof direct === 'string') return direct;
  const output = body['output'];
  if (!Array.isArray(output)) return '';
  const parts: string[] = [];
  for (const item of output) {
    const itemRecord = asRecord(item);
    const content = itemRecord?.['content'];
    if (!Array.isArray(content)) continue;
    for (const contentItem of content) {
      const contentRecord = asRecord(contentItem);
      if (contentRecord?.['type'] !== 'output_text') continue;
      const text = contentRecord['text'];
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('');
}

function parseCompletedResponse(
  body: unknown,
  fallbackRequestId: string | null = null,
  expectedModel: string | null = null,
): OpenAiCompletedResponse {
  const record = asRecord(body);
  if (record === null) throw new OpenAiGatewayError('PROVIDER_RESPONSE_INVALID', 'OpenAI response is not an object.');
  const providerRequestId =
    typeof record['id'] === 'string' && record['id'].length > 0
      ? record['id']
      : fallbackRequestId;
  if (providerRequestId === null) {
    throw new OpenAiGatewayError('PROVIDER_RESPONSE_INVALID', 'OpenAI response has no request id.');
  }
  const model = record['model'];
  if (typeof model !== 'string' || model.length === 0) {
    throw new OpenAiGatewayError('PROVIDER_RESPONSE_INVALID', 'OpenAI response has no model id.');
  }
  if (expectedModel !== null && model !== expectedModel) {
    throw new OpenAiGatewayError(
      'PROVIDER_MODEL_ID_MISMATCH',
      `OpenAI response expected exact model ${expectedModel}, received ${model}.`,
    );
  }
  const usageRecord = asRecord(record['usage']);
  if (usageRecord === null) {
    throw new OpenAiGatewayError('PROVIDER_RESPONSE_INVALID', 'OpenAI response has no usage object.');
  }
  const inputDetails = asRecord(usageRecord['input_tokens_details']);
  const inputTokens = readInteger(usageRecord, 'input_tokens');
  const outputTokens = readInteger(usageRecord, 'output_tokens');
  const reportedTotal = readInteger(usageRecord, 'total_tokens');
  const usage: OpenAiUsage = {
    inputTokens,
    cachedInputTokens: inputDetails === null ? 0 : readInteger(inputDetails, 'cached_tokens'),
    outputTokens,
    totalTokens: reportedTotal === 0 ? inputTokens + outputTokens : reportedTotal,
  };
  return {
    providerRequestId,
    model,
    outputText: extractOutputText(record),
    usage,
    raw: body,
  };
}

async function readBoundedBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const bytes = Number.parseInt(declared, 10);
    if (Number.isFinite(bytes) && bytes > maximumBytes) {
      throw new OpenAiGatewayError(
        'PROVIDER_RESPONSE_TOO_LARGE',
        `Provider declared ${bytes} response bytes; limit is ${maximumBytes}.`,
        { status: response.status },
      );
    }
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel('response exceeds CLU-E gateway limit');
        throw new OpenAiGatewayError(
          'PROVIDER_RESPONSE_TOO_LARGE',
          `Provider response exceeded ${maximumBytes} bytes.`,
          { status: response.status },
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

async function readJson(response: Response, maximumBytes: number): Promise<unknown> {
  const bytes = await readBoundedBytes(response, maximumBytes);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new OpenAiGatewayError(
      'PROVIDER_RESPONSE_INVALID_UTF8',
      `Provider response is not valid UTF-8: ${(error as Error).message}`,
      { status: response.status },
    );
  }
  if (text.trim().length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new OpenAiGatewayError(
      'PROVIDER_RESPONSE_INVALID_JSON',
      `Provider response is not JSON: ${(error as Error).message}`,
      { status: response.status },
    );
  }
}

export { readJson as readOpenAiJson };

async function readText(response: Response, maximumBytes: number): Promise<string> {
  const bytes = await readBoundedBytes(response, maximumBytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new OpenAiGatewayError(
      'PROVIDER_RESPONSE_INVALID_UTF8',
      `Provider response is not valid UTF-8: ${(error as Error).message}`,
      { status: response.status },
    );
  }
}

async function fetchWithTimeout(
  fetchImpl: GatewayFetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new OpenAiGatewayError('PROVIDER_TIMEOUT', `OpenAI request exceeded ${timeoutMs} ms.`, {
        retryable: true,
      });
    }
    const safeMessage = redactSecretText(
      error instanceof Error ? error.message : String(error),
    ).text;
    throw new OpenAiGatewayError(
      'PROVIDER_NETWORK_ERROR',
      safeMessage,
      { retryable: true },
    );
  } finally {
    clearTimeout(timer);
  }
}

export class OpenAiResponsesAdapter {
  readonly #apiKey: string;
  readonly #routing: GatewayRoutingPolicy;
  readonly #fetch: GatewayFetch;
  readonly #timeoutMs: number;

  public constructor(options: {
    readonly apiKey: string;
    readonly routing: GatewayRoutingPolicy;
    readonly fetchImpl?: GatewayFetch;
  }) {
    if (options.apiKey.length === 0) throw new Error('OpenAI API key is empty.');
    this.#apiKey = options.apiKey;
    this.#routing = options.routing;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.routing.api.request_timeout_seconds * 1000;
  }

  #headers(contentType = 'application/json'): Record<string, string> {
    return {
      Authorization: `Bearer ${this.#apiKey}`,
      'Content-Type': contentType,
      'User-Agent': 'CLU-E/0.1 ModelGateway',
    };
  }

  #responseBody(request: OpenAiRequest): Record<string, unknown> {
    return {
      model: request.model,
      input: request.input,
      ...(request.instructions === null ? {} : { instructions: request.instructions }),
      max_output_tokens: request.maxOutputTokens,
      store: this.#routing.api.store,
      metadata: request.metadata,
    };
  }

  /** No-token provider/model health probe used to clear a controlled budget pause. */
  public async probeModel(model: string): Promise<{ readonly id: string }> {
    const response = await fetchWithTimeout(
      this.#fetch,
      `${endpoint(this.#routing.api.base_url, this.#routing.api.models_path)}/${encodeURIComponent(model)}`,
      { method: 'GET', headers: this.#headers() },
      this.#timeoutMs,
    );
    const body = await readJson(response, this.#routing.api.max_response_bytes);
    if (!response.ok) {
      throw classifyProviderHttpError(
        response.status,
        body,
        `OpenAI model probe returned HTTP ${response.status}.`,
      );
    }
    const record = asRecord(body);
    const id = record?.['id'];
    if (typeof id !== 'string' || id !== model) {
      throw new OpenAiGatewayError(
        'PROVIDER_MODEL_ID_MISMATCH',
        `OpenAI model probe expected ${model}, received ${typeof id === 'string' ? id : 'no id'}.`,
      );
    }
    return { id };
  }

  public async invokeInteractive(request: OpenAiRequest): Promise<OpenAiCompletedResponse> {
    const response = await fetchWithTimeout(
      this.#fetch,
      endpoint(this.#routing.api.base_url, this.#routing.api.responses_path),
      {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(this.#responseBody(request)),
      },
      this.#timeoutMs,
    );
    const body = await readJson(response, this.#routing.api.max_response_bytes);
    if (!response.ok) {
      throw classifyProviderHttpError(
        response.status,
        body,
        `OpenAI Responses API returned HTTP ${response.status}.`,
      );
    }
    const completed = parseCompletedResponse(body, response.headers.get('x-request-id'));
    if (completed.model !== request.model) {
      throw new OpenAiGatewayError(
        'PROVIDER_MODEL_ID_MISMATCH',
        `OpenAI response expected model ${request.model}, received ${completed.model}.`,
      );
    }
    return completed;
  }

  public async submitBatch(request: OpenAiRequest): Promise<OpenAiBatchSubmission> {
    const line = JSON.stringify({
      custom_id: request.callId,
      method: 'POST',
      url: this.#routing.api.responses_path,
      body: this.#responseBody(request),
    });
    const form = new FormData();
    form.set('purpose', 'batch');
    form.set('file', new Blob([`${line}\n`], { type: 'application/jsonl' }), `${request.callId}.jsonl`);

    const uploadResponse = await fetchWithTimeout(
      this.#fetch,
      endpoint(this.#routing.api.base_url, this.#routing.api.files_path),
      { method: 'POST', headers: { Authorization: `Bearer ${this.#apiKey}` }, body: form },
      this.#timeoutMs,
    );
    const uploadBody = await readJson(uploadResponse, this.#routing.api.max_response_bytes);
    if (!uploadResponse.ok) {
      throw classifyProviderHttpError(
        uploadResponse.status,
        uploadBody,
        `OpenAI file upload returned HTTP ${uploadResponse.status}.`,
      );
    }
    const upload = uploadSchema.parse(uploadBody);

    const batchResponse = await fetchWithTimeout(
      this.#fetch,
      endpoint(this.#routing.api.base_url, this.#routing.api.batches_path),
      {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify({
          input_file_id: upload.id,
          endpoint: this.#routing.api.responses_path,
          completion_window: '24h',
          metadata: { clue_call_id: request.callId },
        }),
      },
      this.#timeoutMs,
    );
    const batchBody = await readJson(batchResponse, this.#routing.api.max_response_bytes);
    if (!batchResponse.ok) {
      throw classifyProviderHttpError(
        batchResponse.status,
        batchBody,
        `OpenAI Batch API returned HTTP ${batchResponse.status}.`,
      );
    }
    const batch = batchSchema.parse(batchBody);
    return {
      inputFileId: upload.id,
      providerBatchId: batch.id,
      providerStatus: batch.status,
      raw: { upload: uploadBody, batch: batchBody },
    };
  }

  public async reconcileBatch(
    providerBatchId: string,
    callId: string,
    expectedModel: string | null = null,
  ): Promise<OpenAiBatchReconciliation> {
    const batchResponse = await fetchWithTimeout(
      this.#fetch,
      `${endpoint(this.#routing.api.base_url, this.#routing.api.batches_path)}/${encodeURIComponent(providerBatchId)}`,
      { method: 'GET', headers: this.#headers() },
      this.#timeoutMs,
    );
    const batchBody = await readJson(batchResponse, this.#routing.api.max_response_bytes);
    if (!batchResponse.ok) {
      throw classifyProviderHttpError(
        batchResponse.status,
        batchBody,
        `OpenAI Batch API returned HTTP ${batchResponse.status}.`,
      );
    }
    const batch = batchSchema.parse(batchBody);
    if (batch.id !== providerBatchId) {
      throw new OpenAiGatewayError(
        'PROVIDER_BATCH_ID_MISMATCH',
        `Requested batch ${providerBatchId}, provider returned ${batch.id}.`,
      );
    }
    if (batch.status !== 'completed') {
      if (terminalBatchFailures.has(batch.status)) {
        return {
          state: 'failed',
          providerBatchId,
          providerStatus: batch.status,
          code: `BATCH_${batch.status.toUpperCase()}`,
          message: `OpenAI batch ${providerBatchId} ended as ${batch.status}.`,
          raw: batchBody,
        };
      }
      if (!pendingBatchStates.has(batch.status)) {
        return {
          state: 'failed',
          providerBatchId,
          providerStatus: batch.status,
          code: 'BATCH_STATUS_UNKNOWN',
          message: `OpenAI batch ${providerBatchId} returned unknown status ${batch.status}.`,
          raw: batchBody,
        };
      }
      return {
        state: 'pending',
        providerBatchId,
        providerStatus: batch.status,
        raw: batchBody,
      };
    }

    const outputFileId = batch.output_file_id ?? null;
    if (outputFileId === null) {
      return {
        state: 'failed',
        providerBatchId,
        providerStatus: batch.status,
        code: 'BATCH_OUTPUT_MISSING',
        message: `Completed OpenAI batch ${providerBatchId} has no output_file_id.`,
        raw: batchBody,
      };
    }
    const outputResponse = await fetchWithTimeout(
      this.#fetch,
      `${endpoint(this.#routing.api.base_url, this.#routing.api.files_path)}/${encodeURIComponent(outputFileId)}/content`,
      { method: 'GET', headers: { Authorization: `Bearer ${this.#apiKey}` } },
      this.#timeoutMs,
    );
    if (!outputResponse.ok) {
      const body = await readJson(outputResponse, this.#routing.api.max_response_bytes);
      throw classifyProviderHttpError(
        outputResponse.status,
        body,
        `OpenAI output download returned HTTP ${outputResponse.status}.`,
      );
    }
    const text = await readText(outputResponse, this.#routing.api.max_response_bytes);
    let selected: z.infer<typeof batchOutputLineSchema> | null = null;
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      if (line.trim().length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch (error) {
        throw new OpenAiGatewayError(
          'BATCH_OUTPUT_INVALID_JSONL',
          `Batch output line ${index + 1} is not JSON: ${(error as Error).message}`,
        );
      }
      const parsed = batchOutputLineSchema.parse(value);
      if (parsed.custom_id === callId) {
        if (selected !== null) {
          throw new OpenAiGatewayError(
            'BATCH_OUTPUT_DUPLICATE',
            `Batch output contains more than one row for ${callId}.`,
          );
        }
        selected = parsed;
      }
    }
    if (selected === null) {
      return {
        state: 'failed',
        providerBatchId,
        providerStatus: batch.status,
        code: 'BATCH_OUTPUT_CALL_MISSING',
        message: `Batch output contains no row for ${callId}.`,
        raw: { batch: batchBody, output: text },
      };
    }
    if (selected.response === null || selected.response === undefined) {
      return {
        state: 'failed',
        providerBatchId,
        providerStatus: batch.status,
        code: 'BATCH_REQUEST_FAILED',
        message: `Batch row ${callId} has no response.`,
        raw: { batch: batchBody, row: selected },
      };
    }
    if (selected.response.status_code < 200 || selected.response.status_code >= 300) {
      throw classifyProviderHttpError(
        selected.response.status_code,
        selected.response.body,
        `Batch row ${callId} returned HTTP ${selected.response.status_code}.`,
      );
    }
    return {
      state: 'completed',
      providerBatchId,
      providerStatus: batch.status,
      response: parseCompletedResponse(
        selected.response.body,
        selected.response.request_id ?? null,
        expectedModel,
      ),
      raw: { batch: batchBody, row: selected },
    };
  }
}
