/**
 * Settings test helpers — TypeScript port of the probing logic in
 * `api/routers/settings.py` (`GET /env-default`, `POST /test-endpoint`,
 * `POST /test-image-provider`).
 *
 * Pure functions taking settings as an argument (no storage imports, so no
 * circular-import risk). Thrown Errors carry the same messages the Python
 * endpoints put in their HTTP 400 `detail` bodies.
 */

import { envFlag, normalizeBaseUrl } from './llm.server.js';

const DEFAULT_BASE_URL = 'http://localhost:1234/v1';

// Module-scoped ambient (no node import): tsconfig.app.json ships only
// vite/client types, so the `process` global is untyped there.
declare const process: { env: Record<string, string | undefined> };

// ---------------------------------------------------------------------------
// GET /env-default
// ---------------------------------------------------------------------------

export interface EnvDefaults {
  base_url: string;
  model: string;
  from_env: { base_url: boolean; model: boolean };
}

/**
 * Effective .env values (what the fallback path would actually use) plus
 * independent explicit-presence flags. URL + model only — no credentials.
 * Mirrors `get_env_default`.
 */
export function getEnvDefaults(): EnvDefaults {
  return {
    base_url: normalizeBaseUrl(
      (process.env.LM_STUDIO_BASE_URL ?? '').trim() || DEFAULT_BASE_URL,
    ),
    model: (process.env.LM_STUDIO_MODEL ?? '').trim(),
    from_env: {
      base_url: 'LM_STUDIO_BASE_URL' in process.env,
      model: 'LM_STUDIO_MODEL' in process.env,
    },
  };
}

// ---------------------------------------------------------------------------
// POST /test-endpoint
// ---------------------------------------------------------------------------

export interface TestEndpointInput {
  base_url?: string;
  api_key?: string;
  model?: string;
}

export interface EndpointProbe {
  ok: boolean;
  status?: number;
  detail?: string;
}

export interface TestEndpointResult {
  success: boolean;
  /** Alias of `success` for convenience. */
  ok: boolean;
  reachable: boolean;
  model_count: number;
  models: unknown;
  model_found: boolean | null;
  probe: EndpointProbe | null;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function readJsonOrThrow(resp: Response): Promise<unknown> {
  try {
    return await resp.json();
  } catch {
    throw new Error('Endpoint reachable but /models did not return JSON');
  }
}

/**
 * Probe an OpenAI-compatible endpoint: `GET {base}/models`, then (when the
 * wanted model is listed) a minimal 1-token chat completion. Mirrors
 * `test_endpoint`; throws with a clear message on failure.
 */
export async function testEndpoint(
  input: TestEndpointInput,
): Promise<TestEndpointResult> {
  const raw = (input.base_url ?? '').trim();
  const baseUrl =
    raw === 'default' || raw === ''
      ? normalizeBaseUrl(
          (process.env.LM_STUDIO_BASE_URL ?? '').trim() || DEFAULT_BASE_URL,
        )
      : normalizeBaseUrl(raw);
  const headers: Record<string, string> = {};
  if (input.api_key) headers['Authorization'] = `Bearer ${input.api_key}`;

  let resp: Response;
  try {
    resp = await fetch(`${baseUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    throw new Error(`Endpoint not reachable: ${errorMessage(e)}`);
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Endpoint not reachable: HTTP ${resp.status} ${detail.slice(0, 200)}`.trim());
  }
  const payload = await readJsonOrThrow(resp);
  const listed =
    typeof payload === 'object' && payload !== null && 'data' in payload
      ? (payload as { data?: unknown }).data
      : null;
  const listedIds = (
    Array.isArray(listed) ? listed : []
  ).flatMap((m) =>
    typeof m === 'object' && m !== null && typeof (m as { id?: unknown }).id === 'string'
      ? [(m as { id: string }).id]
      : [],
  );
  const modelCount = listedIds.length;

  const ok = (
    modelFound: boolean | null,
    probe: EndpointProbe | null,
  ): TestEndpointResult => ({
    success: true,
    ok: true,
    reachable: true,
    model_count: modelCount,
    models: payload,
    model_found: modelFound,
    probe,
  });

  const wanted = (input.model ?? '').trim() || null;
  if (!wanted) return ok(null, null);
  if (!listedIds.includes(wanted)) return ok(false, null);

  // Minimal cheap probe: 1-token completion to verify the id is accepted.
  // A rejection may still mean format mismatch, not an invalid model —
  // callers must surface probe failure as a warning, not invalid-model.
  try {
    const probeResp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        model: wanted,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (probeResp.ok) return ok(true, { ok: true });
    const detail = await probeResp.text().catch(() => '');
    return ok(true, {
      ok: false,
      status: probeResp.status,
      detail: detail.slice(0, 300),
    });
  } catch (e) {
    return ok(true, { ok: false, detail: errorMessage(e).slice(0, 300) });
  }
}

// ---------------------------------------------------------------------------
// POST /test-image-provider
// ---------------------------------------------------------------------------

export interface ImageEndpointEntry {
  provider?: string;
  base_url?: string;
  api_key?: string;
  model?: string;
}

export interface TestImageProviderInput {
  provider?: string;
  base_url?: string | null;
  api_key?: string | null;
  model?: string | null;
}

export interface ImageProviderSettingsLike {
  image_endpoints?: Record<string, ImageEndpointEntry> | null;
  active_image_endpoint?: string | null;
  image_comfy_text_workflow?: Record<string, unknown> | null;
  image_comfy_text_prompt_map?: unknown;
  image_comfy_text_seed_map?: unknown;
  image_comfy_edit_workflow?: Record<string, unknown> | null;
  image_comfy_edit_prompt_map?: unknown;
  image_comfy_edit_image_map?: unknown;
  image_comfy_edit_seed_map?: unknown;
}

export interface TestImageProviderResult {
  success: boolean;
  ok: boolean;
  provider: string;
  models?: number;
  model?: string;
  note?: string;
  text?: string;
  edit?: string;
}

function resolveImageEntry(
  input: TestImageProviderInput,
  settings?: ImageProviderSettingsLike | null,
): ImageEndpointEntry {
  const entries = settings?.image_endpoints;
  const active =
    (settings?.active_image_endpoint &&
      entries?.[settings.active_image_endpoint]) ||
    undefined;
  const activeEntry: ImageEndpointEntry =
    active && typeof active === 'object' ? active : {};
  return {
    provider:
      input.provider ?? activeEntry.provider ?? 'openai-compatible',
    base_url:
      input.base_url !== undefined && input.base_url !== null
        ? input.base_url
        : (activeEntry.base_url ?? ''),
    api_key:
      input.api_key !== undefined && input.api_key !== null
        ? input.api_key
        : (activeEntry.api_key ?? ''),
    model:
      input.model !== undefined && input.model !== null
        ? input.model
        : (activeEntry.model ?? ''),
  };
}

/**
 * Validate image provider connectivity/config without a full generation.
 * Mirrors `test_image_provider`; throws with a clear message on failure.
 *
 * Deviation: the ComfyUI workflow-map validation (`validate_comfy_*_map`)
 * runs against the workflow JSON structurally here is not replicated — the
 * presence check (workflow configured) is enforced, and slot status is
 * reported as "ok" when a workflow object exists. Full node/input
 * validation still happens on generation via the Python backend.
 */
export async function testImageProvider(
  input: TestImageProviderInput,
  settings?: ImageProviderSettingsLike | null,
): Promise<TestImageProviderResult> {
  const entry = resolveImageEntry(input, settings);
  const provider = (entry.provider ?? 'openai-compatible').trim().toLowerCase();
  const baseUrl = (entry.base_url ?? '').trim();
  const apiKey = entry.api_key ?? '';
  const model = (entry.model ?? '').trim();

  if (
    provider === 'openai-compatible' ||
    provider === 'openai' ||
    provider === 'lmstudio' ||
    provider === 'local'
  ) {
    if (!baseUrl) throw new Error('Image base URL is not configured');
    const url = `${baseUrl.replace(/\/+$/, '')}/v1/models`;
    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    let resp: Response;
    try {
      resp = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    } catch (e) {
      throw new Error(`Could not reach image provider: ${errorMessage(e)}`);
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new Error('Image provider rejected the API key (401/403)');
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(
        `Image provider test failed (${resp.status}): ${text.slice(0, 300)}`,
      );
    }
    let n = 0;
    try {
      const body = (await resp.json()) as { data?: unknown };
      n = Array.isArray(body.data) ? body.data.length : 0;
    } catch {
      n = 0;
    }
    return { success: true, ok: true, provider, models: n };
  }

  if (provider === 'stability') {
    if (!apiKey) throw new Error('Stability API key is not configured');
    let resp: Response;
    try {
      resp = await fetch('https://api.stability.ai/v2beta/user/account', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {
      throw new Error(`Could not reach Stability: ${errorMessage(e)}`);
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new Error('Stability rejected the API key (401/403)');
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Stability test failed (${resp.status}): ${text.slice(0, 300)}`);
    }
    return { success: true, ok: true, provider };
  }

  if (provider === 'fal') {
    if (!apiKey) throw new Error('FAL API key is not configured');
    if (!model) throw new Error('FAL model is not configured');
    return {
      success: true,
      ok: true,
      provider,
      note: 'Key + model present; generation tested on use.',
    };
  }

  if (provider === 'gemini') {
    // Mirrors GeminiProvider.check_model: key + model presence, then a
    // lightweight GET on the model resource (no generation).
    if (!apiKey) throw new Error('Gemini API key is not configured (Settings → Images)');
    if (!model) throw new Error('Gemini model is not configured (Settings → Images)');
    const apiRoot = baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
    let resp: Response;
    try {
      resp = await fetch(
        `${apiRoot.replace(/\/+$/, '')}/models/${encodeURIComponent(model)}`,
        {
          headers: { 'x-goog-api-key': apiKey },
          signal: AbortSignal.timeout(30000),
        },
      );
    } catch (e) {
      throw new Error(`Could not reach Gemini: ${errorMessage(e)}`);
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new Error('Gemini rejected the API key (401/403)');
    }
    if (resp.status === 404) throw new Error(`Gemini model not found: ${JSON.stringify(model)}`);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Gemini test failed (${resp.status}): ${text.slice(0, 300)}`);
    }
    return { success: true, ok: true, provider, model };
  }

  if (provider === 'comfyui') {
    // Workflow presence is required (mirrors the "missing"/stale slot
    // check); full prompt/image/seed map validation is backend-owned.
    const hasText =
      settings?.image_comfy_text_workflow &&
      typeof settings.image_comfy_text_workflow === 'object' &&
      Object.keys(settings.image_comfy_text_workflow).length > 0;
    const hasEdit =
      settings?.image_comfy_edit_workflow &&
      typeof settings.image_comfy_edit_workflow === 'object' &&
      Object.keys(settings.image_comfy_edit_workflow).length > 0;
    if (!hasText && !hasEdit) {
      throw new Error(
        'No ComfyUI workflow is configured — import a text-to-image ' +
          'and/or edit workflow in Settings → Images',
      );
    }
    if (!baseUrl) throw new Error('ComfyUI base URL is not configured');
    let resp: Response;
    try {
      resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/system_stats`, {
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {
      throw new Error(`Could not reach ComfyUI: ${errorMessage(e)}`);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`ComfyUI test failed (${resp.status}): ${text.slice(0, 300)}`);
    }
    return {
      success: true,
      ok: true,
      provider,
      text: hasText ? 'ok' : 'missing',
      edit: hasEdit ? 'ok' : 'missing',
    };
  }

  throw new Error(`Unknown image provider: ${JSON.stringify(provider)}`);
}

export { envFlag };
