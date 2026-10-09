/**
 * LLM client — OpenAI-compatible chat completions with streaming support.
 *
 * TypeScript port of `llm.py` (+ `config.py` env defaults and
 * `_resolve_simple_assist_client` from `api/routers/assist.py`) for the
 * TanStack Start server layer. Uses global `fetch` only — no dependencies.
 */

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

const OPENING_TAGS = ['<|channel|>', '<think>'];
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
  /** Reasoning text captured during the last streaming call (isThinking mode). */
  lastThinking: string | null = null;
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

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
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
    return payload;
  }

  private payloadWithMessages(
    messages: ChatMessage[],
    stream: boolean,
    opts: GenerateOptions = {},
  ): ChatPayload {
    const payload: ChatPayload = {
      model: this.model,
      messages,
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
    return payload;
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
    const payload = this.payloadWithMessages(messages, true, opts);
    yield* this.runStream(payload, opts.signal);
  }

  private async *runStream(
    payload: ChatPayload,
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    const openings = [...OPENING_TAGS, ...this.customOpeningTags];
    const closings = [...CLOSING_TAGS, ...this.customClosingTags];
    const maxTagLen = Math.max(...[...openings, ...closings].map((t) => t.length), 12);

    let thinking = '';
    let inThinking = false;
    let thinkingBuffer = '';
    let pending = '';

    const takeThinking = (text: string): void => {
      thinking += text;
    };

    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal,
      });
    } catch (e) {
      throw new Error(`LMStudio API error: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!resp.ok || !resp.body) {
      const detail = await resp.text().catch(() => '');
      throw new Error(
        `LMStudio API error (${resp.status}): ${detail.slice(0, 300)}`,
      );
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') continue;
          let data: unknown;
          try {
            data = JSON.parse(dataStr);
          } catch {
            continue;
          }
          this.rememberUsage(data);
          const choices =
            typeof data === 'object' && data !== null && 'choices' in data
              ? (data as { choices?: Array<{ delta?: Record<string, string> }> }).choices
              : undefined;
          if (!choices || choices.length === 0) continue;
          const delta = choices[0].delta ?? {};

          const reasoning = delta['reasoning_content'] ?? '';
          if (reasoning) {
            if (this.isThinking) takeThinking(reasoning);
            else yield reasoning;
          }

          const content = delta['content'] ?? '';
          if (!content) continue;
          if (!this.isThinking) {
            yield content;
          } else if (inThinking) {
            thinkingBuffer += content;
            let closed = false;
            for (const close of closings) {
              const idx = thinkingBuffer.indexOf(close);
              if (idx === -1) continue;
              takeThinking(thinkingBuffer.slice(0, idx));
              const rest = thinkingBuffer.slice(idx + close.length);
              thinkingBuffer = '';
              inThinking = false;
              closed = true;
              if (rest) yield rest;
              break;
            }
            if (!closed) {
              // Fail-safe: reasoning block too long, keep capturing but
              // don't grow the buffer unboundedly.
              if (thinkingBuffer.length > 6000) {
                takeThinking(thinkingBuffer);
                thinkingBuffer = '';
                inThinking = false;
              }
            }
          } else {
            pending += content;
            let opened = false;
            for (const open of openings) {
              const idx = pending.indexOf(open);
              if (idx === -1) continue;
              const before = pending.slice(0, idx);
              if (before) yield before;
              inThinking = true;
              thinkingBuffer = pending.slice(idx + open.length);
              pending = '';
              opened = true;
              break;
            }
            if (!opened && pending.length > maxTagLen) {
              const safe = pending.slice(0, pending.length - maxTagLen);
              yield safe;
              pending = pending.slice(pending.length - maxTagLen);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (pending && !inThinking) yield pending;
    // Unclosed thinking block at end of stream: treat the remainder as
    // reasoning (mirrors the fail-safe flush in llm.py).
    if (thinkingBuffer) takeThinking(thinkingBuffer);
    this.lastThinking = thinking || null;
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
    const payload = this.payloadWithMessages(messages, false, opts);
    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: opts.signal,
      });
    } catch (e) {
      throw new Error(`LMStudio API error: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(
        `LMStudio API error (${resp.status}): ${detail.slice(0, 300)}`,
      );
    }
    const data = (await resp.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
    };
    this.rememberUsage(data);
    if (!this.lastUsage) {
      this.lastUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    }
    this.lastModelUsed = data.model ?? this.model;
    const content = data.choices?.[0]?.message?.content ?? '';
    return this.cleanReasoning(content);
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
    text = text.replace(/<\|?channel\|?>.*?<[\|/]?channel[\|/>]/gs, '');
    text = text.replace(/<[\|/]?channel[\|>][^<]*/gs, '');
    text = text.trim().replace(/^[\*\-\+]\s*\n?/, '');
    return text.trim();
  }
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
export function loadLlmConfig(settings?: LlmSettingsLike | null): LLMClient {
  const epId = settings?.active_endpoint;
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
