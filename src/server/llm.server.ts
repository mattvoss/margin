/**
 * LLM client — OpenAI-compatible chat completions with streaming support.
 *
 * TypeScript port of `llm.py` (+ `config.py` env defaults and
 * `_resolve_simple_assist_client` from `api/routers/assist.py`) for the
 * TanStack Start server layer. Transport is the AI SDK's OpenAI provider;
 * a thin fetch wrapper merges llama.cpp-specific body fields and keeps the
 * raw response shape the old client exposed.
 */

import { createOpenAI } from '@ai-sdk/openai'
import {
  generateText,
  streamText,
  type LanguageModelUsage,
  type ModelMessage,
} from 'ai'
import { ThinkingTagFilter } from './thinking-filter.server'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  [key: string]: unknown;
}

export interface LLMClientOptions {
  model?: string;
  temperature?: number;
  baseUrl?: string;
  apiKey?: string;
  /** Capture thinking-model reasoning (default: REASONING_MODEL env, else true). */
  isThinking?: boolean;
  customOpeningTags?: string[];
  customClosingTags?: string[];
}

export interface PayloadOptions {
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
  /**
   * llama.cpp prefix-KV reuse (`cache_prompt`). Sent as `cache_prompt` in the
   * /chat/completions body; ignored by servers that don't understand it.
   * Default true (see cacheOptsForSession) — set false to force full prefill.
   */
  cachePrompt?: boolean;
  /**
   * llama.cpp `n_keep`: prompt tokens retained when context overflows.
   * Set to the static-system prefix size so eviction hits the volatile tail.
   */
  nKeep?: number;
  /**
   * llama.cpp `id_slot`: pin to a slot for same-slot KV reuse. Omit (-1 /
   * absent) to let the server's `-sps` similarity routing choose.
   */
  slotId?: number;
  /**
   * Ask the chat template to disable model-side thinking. llama.cpp and
   * template-aware servers accept this as `chat_template_kwargs`.
   */
  enableThinking?: boolean;
}

export interface GenerateOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** See PayloadOptions.cachePrompt (llama.cpp `cache_prompt`). */
  cachePrompt?: boolean;
  /** See PayloadOptions.nKeep (llama.cpp `n_keep`). */
  nKeep?: number;
  /** See PayloadOptions.slotId (llama.cpp `id_slot`). */
  slotId?: number;
  /** See PayloadOptions.enableThinking. */
  enableThinking?: boolean;
  /** Called for each captured reasoning delta (when the model thinks). */
  onThinking?: (chunk: string) => void;
  /**
   * When `message.content` is empty, use `reasoning_content` as the answer.
   * Intended for structured utility calls; prose callers should leave this off.
   */
  fallbackToReasoning?: boolean;
}

interface ChatPayload {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  stream: boolean;
  stream_options?: { include_usage: boolean };
  max_tokens?: number;
  cache_prompt?: boolean;
  n_keep?: number;
  id_slot?: number;
  chat_template_kwargs?: Record<string, unknown>;
}

const DEFAULT_BASE_URL = 'http://localhost:1234/v1';
const DEFAULT_TEMPERATURE = 0.8;

// Module-scoped ambient (no node import): tsconfig.app.json ships only
// vite/client types, so the `process` global is untyped there. Safe to
// shadow — it disappears at compile time and never clashes with @types/node.
declare const process: { env: Record<string, string | undefined> };

/** True for "true"/"1"/"yes" (case-insensitive), mirroring config.py. */
export function envFlag(name: string): boolean {
  return ['true', '1', 'yes'].includes((process.env[name] ?? '').trim().toLowerCase());
}

/** Mirrors `DISABLE_TOKEN_LIMITS` in config.py. */
export function isTokenLimitsDisabled(): boolean {
  return envFlag('DISABLE_TOKEN_LIMITS');
}

/** Strip trailing `/`, then append `/v1` unless already present (mirrors llm.py). */
export function normalizeBaseUrl(raw: string | undefined | null): string {
  let base = (raw ?? '').trim().replace(/\/+$/, '');
  if (!base.endsWith('/v1')) base += '/v1';
  return base;
}

function envBaseUrl(): string {
  const raw = (process.env.LM_STUDIO_BASE_URL ?? '').trim() || DEFAULT_BASE_URL;
  return normalizeBaseUrl(raw);
}

function envModel(): string {
  return (process.env.LM_STUDIO_MODEL ?? '').trim();
}

function envIsThinking(): boolean {
  // REASONING_MODEL is opt-in in .env.example ("false" default); when unset,
  // keep llm.py's default of True.
  if ('REASONING_MODEL' in process.env) return envFlag('REASONING_MODEL');
  return true;
}

/**
 * TOKENS_* per-beat env defaults from .env.example. Mirrors the documented
 * floor values (style output_size overrides these upward in the writer).
 */
export function tokenDefaults(): Record<string, number> {
  const read = (name: string, fallback: number): number => {
    const raw = Number((process.env[name] ?? '').trim());
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  };
  return {
    blueprint: read('TOKENS_BLUEPRINT', 2000),
    scene: read('TOKENS_SCENE', 600),
    dialogue: read('TOKENS_DIALOGUE', 800),
    narration: read('TOKENS_NARRATION', 800),
    decomposer: read('TOKENS_DECOMPOSER', 600),
    writer: read('TOKENS_WRITER', 500),
    transition: read('TOKENS_TRANSITION', 400),
  };
}

const CLOSING_TAGS = [
  '<channel|>',
  '<|channel|>',
  '</channel|>',
  '|channel|>',
  '</think>',
];

export interface LlmTimings {
  prompt_ms?: number;
  prompt_n?: number;
  predicted_ms?: number;
  predicted_n?: number;
  tokens_cached?: number;
  [key: string]: unknown;
}

export class LLMClient {
  readonly baseUrl: string;
  readonly model: string;
  readonly temperature: number;
  readonly apiKey?: string;
  readonly isThinking: boolean;
  readonly customOpeningTags: string[];
  readonly customClosingTags: string[];
  lastUsage: TokenUsage | null = null;
  /** Reasoning text captured during the last call (streaming or blocking). */
  lastThinking: string | null = null;
  /** `finish_reason` from the last call, when the server sent one. */
  lastFinishReason: string | null = null;
  /** Length of generated answer text captured during the last call. */
  lastContentChars: number | null = null;
  /** llama.cpp `timings` object from the last call (null on OpenAI servers). */
  lastTimings: LlmTimings | null = null;
  /** Prefix-reused prompt tokens reported by the server, when available. */
  lastTokensCached: number | null = null;
  lastModelUsed: string;

  constructor(opts: LLMClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl ?? envBaseUrl());
    this.model = (opts.model ?? envModel()).trim();
    this.temperature = opts.temperature ?? DEFAULT_TEMPERATURE;
    this.apiKey = opts.apiKey || undefined;
    this.isThinking = opts.isThinking ?? envIsThinking();
    this.customOpeningTags = opts.customOpeningTags ?? [];
    this.customClosingTags = opts.customClosingTags ?? [];
    this.lastModelUsed = this.model;
  }

  /** Build a /chat/completions payload. Omits max_tokens when token limits are disabled. */
  buildPayload(
    systemPrompt: string,
    userPrompt: string,
    opts: PayloadOptions = {},
  ): ChatPayload {
    const stream = opts.stream ?? false;
    const payload: ChatPayload = {
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: opts.temperature ?? this.temperature,
      stream,
    };
    if (stream) payload.stream_options = { include_usage: true };
    if (!isTokenLimitsDisabled() && opts.maxTokens != null) {
      payload.max_tokens = opts.maxTokens;
    }
    if (opts.cachePrompt != null) payload.cache_prompt = opts.cachePrompt;
    if (opts.nKeep != null) payload.n_keep = opts.nKeep;
    if (opts.slotId != null) payload.id_slot = opts.slotId;
    if (opts.enableThinking === false) {
      payload.chat_template_kwargs = { enable_thinking: false };
    }
    return payload;
  }

  /**
   * llama.cpp-specific request-body fields. The OpenAI provider only exposes
   * standard options, so a fetch wrapper merges these into the JSON body.
   */
  private requestBody(opts: GenerateOptions): Record<string, unknown> {
    const extra: Record<string, unknown> = {};
    if (opts.cachePrompt != null) extra['cache_prompt'] = opts.cachePrompt;
    if (opts.nKeep != null) extra['n_keep'] = opts.nKeep;
    if (opts.slotId != null) extra['id_slot'] = opts.slotId;
    if (opts.enableThinking === false) {
      extra['chat_template_kwargs'] = { enable_thinking: false };
    }
    return extra;
  }

  private createModel(opts: GenerateOptions) {
    const extra = this.requestBody(opts);
    const provider = createOpenAI({
      baseURL: this.baseUrl,
      // Local OpenAI-compatible servers usually accept any key; the provider
      // requires one to be present for its headers.
      apiKey: this.apiKey || 'lm-studio',
      name: 'margin',
      fetch: createRequestBodyFetch(extra),
    });
    return provider.chat(this.model);
  }

  private tokenLimit(opts: GenerateOptions): number | undefined {
    if (isTokenLimitsDisabled() || opts.maxTokens == null) return undefined;
    return opts.maxTokens;
  }

  private rememberUsage(data: unknown): void {
    const usage =
      typeof data === 'object' && data !== null && 'usage' in data
        ? (data as { usage?: TokenUsage | null }).usage
        : null;
    if (usage && typeof usage === 'object') {
      this.lastUsage = usage;
    }
    this.rememberTimings(data);
  }

  /**
   * Best-effort capture of llama.cpp timing / prefix-reuse telemetry.
   * Non-streaming bodies carry `timings {prompt_ms, prompt_n, ...}` and may
   * carry `tokens_cached`; streaming deltas may carry `timings` on the final
   * chunk. OpenAI servers simply omit these — all fields stay null.
   */
  private rememberTimings(data: unknown): void {
    if (typeof data !== 'object' || data === null) return;
    const rec = data as Record<string, unknown>;
    const timings = rec['timings'];
    if (timings && typeof timings === 'object') {
      this.lastTimings = timings as LlmTimings;
      const cached = (timings as Record<string, unknown>)['tokens_cached'];
      if (typeof cached === 'number' && Number.isFinite(cached)) this.lastTokensCached = Math.trunc(cached);
    }
    const topCached = rec['tokens_cached'];
    if (typeof topCached === 'number' && Number.isFinite(topCached)) {
      this.lastTokensCached = Math.trunc(topCached);
    }
  }

  /**
   * Streaming generation — yields answer text as it arrives.
   *
   * Reasoning (`reasoning_content` deltas and `<think>`/channel-tagged
   * blocks) is captured into `lastThinking` when `isThinking` instead of
   * being yielded; with `isThinking: false` reasoning surfaces as normal
   * text, mirroring llm.py's `("thinking", …)` vs `("chunk", …)` split
   * collapsed into a string-only channel.
   */
  async *streamGenerate(
    systemPrompt: string,
    userPrompt: string,
    opts: GenerateOptions = {},
  ): AsyncGenerator<string> {
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
    yield* this.streamWithMessages(messages, opts);
  }

  /** Streaming generation with a pre-built message history. */
  async *streamWithMessages(
    messages: ChatMessage[],
    opts: GenerateOptions = {},
  ): AsyncGenerator<string> {
    this.lastTimings = null;
    this.lastTokensCached = null;
    this.lastFinishReason = null;
    this.lastThinking = null;
    this.lastContentChars = null;

    const maxTokens = this.tokenLimit(opts);
    const result = streamText({
      model: this.createModel(opts),
      messages: messages as ModelMessage[],
      allowSystemInMessages: true,
      temperature: opts.temperature ?? this.temperature,
      abortSignal: opts.signal,
      // Raw chunks carry llama.cpp telemetry and `reasoning_content`, which
      // the OpenAI provider's schema intentionally drops.
      include: { rawChunks: true },
      ...(maxTokens != null ? { maxOutputTokens: maxTokens } : {}),
    });

    const filter = new ThinkingTagFilter(
      this.isThinking,
      this.customOpeningTags,
      this.customClosingTags,
    );
    let thinking = '';
    let contentChars = 0;
    const takeThinking = (text: string): void => {
      thinking += text;
      if (text) opts.onThinking?.(text);
    };

    try {
      for await (const part of result.fullStream) {
        if (part.type === 'raw') {
          this.rememberUsage(part.rawValue);
          const reasoning = streamingReasoning(part.rawValue);
          if (reasoning) {
            if (this.isThinking) takeThinking(reasoning);
            else yield reasoning;
          }
        } else if (part.type === 'text-delta') {
          const pushed = filter.push(part.text);
          if (pushed.thinking) takeThinking(pushed.thinking);
          if (pushed.text) {
            contentChars += pushed.text.length;
            yield pushed.text;
          }
        } else if (part.type === 'reasoning-delta') {
          // Providers that surface reasoning as a first-class part.
          if (this.isThinking) takeThinking(part.text);
          else {
            contentChars += part.text.length;
            yield part.text;
          }
        } else if (part.type === 'finish') {
          this.lastFinishReason = part.rawFinishReason ?? part.finishReason ?? null;
          this.rememberUnifiedUsage(part.totalUsage);
        } else if (part.type === 'error') {
          throw part.error;
        }
      }
    } catch (error) {
      throw llmError(error);
    }

    const tail = filter.flush();
    if (tail.thinking) takeThinking(tail.thinking);
    if (tail.text) {
      contentChars += tail.text.length;
      yield tail.text;
    }
    this.lastThinking = thinking || null;
    this.lastContentChars = contentChars;
  }

  /** Fill usage from the SDK when the provider did not echo a raw object. */
  private rememberUnifiedUsage(usage: LanguageModelUsage): void {
    if (this.lastUsage) return;
    const input = usage.inputTokens;
    const output = usage.outputTokens;
    const total = usage.totalTokens;
    if (input == null && output == null && total == null) return;
    this.lastUsage = {
      prompt_tokens: input ?? 0,
      completion_tokens: output ?? 0,
      total_tokens: total ?? (input ?? 0) + (output ?? 0),
    };
  }

  /** Blocking (non-streaming) generation, mirroring `generate_to_completion`. */
  async generateBlocking(
    systemPrompt: string,
    userPrompt: string,
    opts: GenerateOptions = {},
  ): Promise<string> {
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
    return this.generateBlockingWithMessages(messages, opts);
  }

  /** Blocking generation with a pre-built message history. */
  async generateBlockingWithMessages(
    messages: ChatMessage[],
    opts: GenerateOptions = {},
  ): Promise<string> {
    this.lastTimings = null;
    this.lastTokensCached = null;
    this.lastUsage = null;
    this.lastThinking = null;
    this.lastFinishReason = null;
    this.lastContentChars = null;

    const maxTokens = this.tokenLimit(opts);
    const result = await generateText({
      model: this.createModel(opts),
      messages: messages as ModelMessage[],
      allowSystemInMessages: true,
      temperature: opts.temperature ?? this.temperature,
      abortSignal: opts.signal,
      // `response.body` is the provider's raw JSON, which keeps llama.cpp
      // timings and `reasoning_content` that the SDK result otherwise drops.
      include: { responseBody: true },
      ...(maxTokens != null ? { maxOutputTokens: maxTokens } : {}),
    }).catch((error: unknown) => {
      throw llmError(error);
    });

    // `response.body` is the provider's raw JSON, so llama.cpp timings and
    // `reasoning_content` survive the SDK's schema conversion.
    const data = result.response.body;
    this.rememberUsage(data);
    if (!this.lastUsage) {
      this.rememberUnifiedUsage(result.usage);
      if (!this.lastUsage) {
        this.lastUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      }
    }
    this.lastModelUsed = result.response.modelId || this.model;

    const content = typeof result.text === 'string' ? result.text : '';
    this.lastContentChars = content.length;
    const reasoning = blockingReasoning(data);
    this.lastThinking = reasoning || null;
    this.lastFinishReason =
      result.rawFinishReason ?? result.finishReason ?? null;

    const source = content.trim()
      ? content
      : opts.fallbackToReasoning
        ? reasoning
        : '';
    if (!source.trim()) return '';
    const cleaned = this.cleanReasoning(source);
    // cleanReasoning can erase a channel-tagged answer. If the model did send
    // content, prefer that over reporting a misleading empty response.
    return cleaned.trim() ? cleaned : source.trim();
  }

  /** Strip thinking-model reasoning blocks (mirrors `_clean_reasoning`). */
  cleanReasoning(text: string): string {
    if (!this.isThinking) return text;
    const closings = [...CLOSING_TAGS, ...this.customClosingTags];
    let lastIdx = -1;
    let lastLen = 0;
    for (const tag of closings) {
      const idx = text.lastIndexOf(tag);
      if (idx > lastIdx) {
        lastIdx = idx;
        lastLen = tag.length;
      }
    }
    if (lastIdx !== -1) text = text.slice(lastIdx + lastLen).trim();
    text = text.replace(/<think>.*?<\/think>/gs, '');
    text = text.replace(/<think>.*/gs, '');
    for (let i = 0; i < this.customOpeningTags.length; i++) {
      const open = escapeRegExp(this.customOpeningTags[i]);
      const close = escapeRegExp(this.customClosingTags[i] ?? '');
      if (close) text = text.replace(new RegExp(`${open}.*?${close}`, 'gs'), '');
      text = text.replace(new RegExp(`${open}.*`, 'gs'), '');
    }
    text = text.replace(/<\|?channel\|?>.*?<[|/]?channel[|/>]/gs, '');
    text = text.replace(/<[|/]?channel[|>][^<]*/gs, '');
    text = text.trim().replace(/^[*+-]\s*\n?/, '');
    return text.trim();
  }
}

/**
 * Wrap fetch so the provider request carries llama.cpp fields and, for
 * blocking calls, so content arrays are flattened into the string shape the
 * provider's schema expects. Both are compatibility shims for local servers.
 */
function createRequestBodyFetch(extra: Record<string, unknown>) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await globalThis.fetch(input, mergeRequestBody(init, extra));
    if (!response.ok) return response;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('json')) {
      return normalizeJsonResponse(response);
    }
    return response;
  };
}

function mergeRequestBody(
  init: RequestInit | undefined,
  extra: Record<string, unknown>,
): RequestInit | undefined {
  if (!init || typeof init.body !== 'string' || Object.keys(extra).length === 0) {
    return init;
  }
  try {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const merged = { ...body, ...extra };
    const baseTemplate = body['chat_template_kwargs'];
    const extraTemplate = extra['chat_template_kwargs'];
    if (
      baseTemplate &&
      typeof baseTemplate === 'object' &&
      extraTemplate &&
      typeof extraTemplate === 'object'
    ) {
      merged['chat_template_kwargs'] = { ...baseTemplate, ...extraTemplate };
    }
    return { ...init, body: JSON.stringify(merged) };
  } catch {
    return init;
  }
}

async function normalizeJsonResponse(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) return response;

  let text: string;
  try {
    text = await response.text();
  } catch {
    return response;
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders(response),
    });
  }

  normalizeChoices(data);
  const choices =
    typeof data === 'object' && data !== null && 'choices' in data
      ? (data as { choices?: unknown }).choices
      : undefined;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!choice || typeof choice !== 'object') continue;
      const message = (choice as { message?: unknown }).message;
      if (!message || typeof message !== 'object') continue;
      const record = message as Record<string, unknown>;
      if (typeof record['content'] !== 'string') {
        record['content'] = contentText(record['content']);
      }
    }
  }

  return new Response(JSON.stringify(data), {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response),
  });
}

/**
 * OpenAI-compatible servers always send `index`, but fixtures and a few
 * minimal servers omit it; the provider's schema requires a number.
 */
function normalizeChoices(data: unknown): void {
  if (!data || typeof data !== 'object') return;
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return;
  choices.forEach((choice, index) => {
    if (!choice || typeof choice !== 'object') return;
    const record = choice as Record<string, unknown>;
    if (typeof record['index'] !== 'number') record['index'] = index;
  });
}

function responseHeaders(response: Response): Headers {
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return headers;
}

function blockingReasoning(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const choices = (data as {
    choices?: Array<{
      message?: { reasoning_content?: unknown; reasoning?: unknown };
    }>;
  }).choices;
  const message = choices?.[0]?.message;
  if (!message) return '';
  return contentText(message.reasoning_content) || contentText(message.reasoning);
}

function streamingReasoning(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const choices = (data as {
    choices?: Array<{ delta?: { reasoning_content?: unknown } }>;
  }).choices;
  return contentText(choices?.[0]?.delta?.reasoning_content);
}

/** Keep the public error shape the previous transport produced. */
function llmError(error: unknown): Error {
  if (error instanceof Error && error.name === 'AbortError') return error;
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) return error;
  const record = error as {
    statusCode?: unknown;
    responseBody?: unknown;
    message?: unknown;
  } | null;
  if (record && typeof record.statusCode === 'number') {
    const detail =
      typeof record.responseBody === 'string'
        ? record.responseBody
        : error instanceof Error
          ? error.message
          : String(record.message ?? '');
    return new Error(`LMStudio API error (${record.statusCode}): ${detail.slice(0, 300)}`, {
      cause: error,
    });
  }
  return new Error(
    `LMStudio API error: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const text = (part as { text?: unknown }).text;
          if (typeof text === 'string') return text;
        }
        return '';
      })
      .join('');
  }
  if (content && typeof content === 'object') {
    const text = (content as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return '';
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Endpoint resolution (mirrors `_resolve_simple_assist_client`)
// ---------------------------------------------------------------------------

export interface EndpointEntry {
  /** Python/file_storage key. Task spec calls this `base_url`; both accepted. */
  url?: string;
  base_url?: string;
  api_key?: string;
  model?: string;
  is_thinking?: boolean;
  custom_thinking_tags?: Array<{ open: string; close: string }>;
}

export interface LlmSettingsLike {
  active_endpoint?: string | null;
  endpoints?: Record<string, EndpointEntry> | null;
}

/**
 * Build an LLMClient from the active endpoint in settings.
 *
 * Deviation from `_resolve_simple_assist_client`: the Python version raises
 * HTTP 400 when no endpoint is configured (no .env fallback — endpoints are
 * sourced centrally from Settings). This port falls back to the
 * LM_STUDIO_* env config instead so server-side callers (CLI harnesses,
 * scripts) keep working without stored settings.
 */
export function loadLlmConfig(
  settings?: LlmSettingsLike | null,
  endpointId?: string | null,
): LLMClient {
  const requested = endpointId ? settings?.endpoints?.[endpointId] : undefined;
  const epId = requested ? endpointId : settings?.active_endpoint;
  const ep = (epId && settings?.endpoints?.[epId]) || undefined;
  if (ep) {
    const tags = Array.isArray(ep.custom_thinking_tags) ? ep.custom_thinking_tags : [];
    return new LLMClient({
      model: ep.model || undefined,
      baseUrl: ep.url ?? ep.base_url ?? undefined,
      apiKey: ep.api_key || undefined,
      isThinking: ep.is_thinking ?? true,
      customOpeningTags: tags
        .filter((t) => typeof t?.open === 'string')
        .map((t) => t.open),
      customClosingTags: tags
        .filter((t) => typeof t?.close === 'string')
        .map((t) => t.close),
    });
  }
  return new LLMClient();
}

/**
 * Pick writer max_tokens from `default_verbosity` (concise 250 / balanced
 * 500 / expansive 1000 / none → null). Null when token limits are disabled.
 * Mirrors `_pick_writer_max_tokens`.
 */
export function pickWriterMaxTokens(
  settings?: { default_verbosity?: string } | null,
): number | null {
  if (isTokenLimitsDisabled()) return null;
  const mapping: Record<string, number | null> = {
    concise: 250,
    balanced: 500,
    expansive: 1000,
    none: null,
  };
  const key = settings?.default_verbosity ?? 'balanced';
  return key in mapping ? mapping[key] : 500;
}

/**
 * FNV-1a 32-bit hash — stable slot derivation without dependencies.
 * Used for prefix-cache diagnostics and optional llama.cpp `id_slot` pinning.
 */
export function hashPrefix(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Derive a stable llama.cpp `id_slot` from a session id.
 *
 * Returns undefined unless slot pinning is explicitly enabled via
 * `settings.llama_pin_slots === true`: pinning to a nonexistent slot errors
 * on servers whose `-np` is smaller than the id, so the default relies on the
 * server's `-sps` prefix-similarity routing instead. `slotCount` bounds the
 * id into `[0, slotCount)`.
 */
export function slotIdForSession(
  sessionId: string | null | undefined,
  settings?: { llama_pin_slots?: boolean; llama_slot_count?: number } | null,
  slotCount?: number,
): number | undefined {
  if (settings?.llama_pin_slots !== true) return undefined;
  if (!sessionId) return undefined;
  const n = slotCount ?? settings?.llama_slot_count ?? 4;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  let h = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % Math.trunc(n);
}
