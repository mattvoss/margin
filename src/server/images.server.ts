/**
 * Image generation server utilities (TanStack Start, Node 22, Docker/Linux).
 *
 * TypeScript port of the Python image-generation stack. No npm dependencies:
 * only the global fetch / FormData / Blob / atob / btoa / structuredClone /
 * URLSearchParams APIs plus node:fs/promises and node:path.
 *
 * Export -> Python source map.
 *
 * api/services/image_providers.py:
 *   BUILTIN_STYLES, SELECTABLE_PROVIDERS, resolveStylePrompt
 *   (resolve_style_prompt), listStyles (list_styles), composeFinalPrompt
 *   (compose_final_prompt), GeneratedImage (dataclass -> interface),
 *   ImageProvider (Protocol -> interface), OpenAICompatibleProvider
 *   (incl. _headers -> headers, _decode_image_payload -> decodeImagePayload),
 *   StabilityProvider, FalProvider, GeminiProvider (incl. check_model ->
 *   checkModel), extractGeminiImage (_extract_gemini_image),
 *   decodeGeminiBlock (_decode_gemini_block), scanGeminiBlocks
 *   (_scan_gemini_blocks), ComfyUIBundle, ComfyUIProvider (incl.
 *   _describe_node -> describeNode, _upload_reference -> uploadReference,
 *   _roll_seed -> ComfyUIProvider.rollSeed, _submit -> submitWorkflow,
 *   _poll -> pollHistory, _download_first -> downloadFirst),
 *   comfyValidationHint (_comfy_validation_hint), inferUploadExt
 *   (_infer_upload_ext), firstComfyImage (_first_comfy_image),
 *   MAX_COMFY_WORKFLOW_NODES / MAX_COMFY_WORKFLOW_BYTES,
 *   validateComfyWorkflow / validateComfyPromptMap /
 *   validateComfyEditImageMap / validateComfySeedMap, isSeedValue
 *   (_is_seed_value), extractComfySeedCandidates /
 *   extractComfyImageCandidates / extractComfyTextCandidates,
 *   comfyTextBundle (_comfy_text_bundle), comfyEditBundle
 *   (_comfy_edit_bundle), activeImageEntry (_active_image_entry),
 *   getImageProvider (get_image_provider).
 *   Private helpers: styleOverrides (_style_overrides), entryGet (_entry_get).
 *
 * api/routers/images.py:
 *   getImageLogs (get_image_logs), deleteImageLog (delete_image_log),
 *   revealGeneratedFolder (reveal_generated_folder), analyzeComfyWorkflow
 *   (analyze_comfy_workflow), generateImage (generate_image). The router's
 *   400-vs-502 substring table is preserved in imageErrorStatus; the HTTP
 *   layer is represented by ImageHttpError (status + message).
 *
 * api/services/file_storage.py:
 *   saveGeneratedBytes (save_generated_bytes), saveImageLog
 *   (save_image_log), getImageLogs (get_image_logs), deleteImageLog
 *   (delete_image_log), imageLogsPath (_image_logs_path), generated assets
 *   dir (generated_dir -> <workspace>/assets/generated), resolveMediaPath
 *   (_media_resolve), sniffImageExt (_sniff_image_ext).
 *
 * New in this port (no direct Python equivalent):
 *   ImageHttpError, imageErrorStatus, base64Encode / decodeBase64Image
 *   (atob/btoa replacing the base64 module; decode strips an optional
 *   data-URL prefix), fetchWithTimeout / sleep (replacing requests
 *   timeouts), uuidHex (replacing uuid4().hex), toBlob (FormData file
 *   parts), and the SettingsRecord / StyleInfo / ComfyCandidate /
 *   ComfyAnalysis / SavedGenerated / GenerateImageInput /
 *   GenerateImageResult types.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Loose settings bag (Python: Dict[str, Any] from storage.get_settings()). */
export type SettingsRecord = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Python repr() for strings ('single-quoted'); used in error messages. */
function pyRepr(value: unknown): string {
  if (typeof value === "string") return `'${value}'`;
  if (value === null || value === undefined) return "None";
  return String(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 32 lowercase hex chars (Python: uuid.uuid4().hex). */
function uuidHex(): string {
  const digits = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += digits[Math.floor(Math.random() * 16)];
  }
  return out;
}

function base64Encode(data: Uint8Array): string {
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < data.length; i += CHUNK) {
    bin += String.fromCharCode(...data.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function stripDataUrlPrefix(s: string): string {
  const m = /^data:[^,]*;base64,/i.exec(s.trim());
  return m ? s.trim().slice(m[0].length) : s;
}

/** atob-based base64 decode; throws on invalid input (mirrors b64decode). */
function decodeBase64Image(b64: string): Uint8Array {
  const bin = atob(stripDataUrlPrefix(String(b64)));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Copy bytes into a Blob for multipart FormData file parts. */
function toBlob(bytes: Uint8Array, type: string): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type });
}

/**
 * Mirror of `str(detail.get("error", {}).get("message", detail))[:300]`:
 * returns the nested message, or null when the body is not a JSON error
 * envelope (caller then falls back to response text).
 */
function jsonErrorMessage(detail: unknown): string | null {
  if (isRecord(detail) && isRecord(detail["error"])) {
    const inner = detail["error"] as Record<string, unknown>;
    const m = inner["message"];
    return String(m === undefined ? detail : m).slice(0, 300);
  }
  return null;
}

async function providerErrorText(resp: Response): Promise<string> {
  let msg: string | null = null;
  try {
    msg = jsonErrorMessage(await resp.json());
  } catch {
    msg = null;
  }
  if (msg == null) msg = (await resp.text()).slice(0, 300);
  return msg;
}

// ---------------------------------------------------------------------------
// Styles (Margin concern)
// ---------------------------------------------------------------------------

export const BUILTIN_STYLES: Record<string, string | null> = {
  // None key is represented as "None" over the wire; null prompt = no suffix.
  None: null,
  Cinematic:
    "cinematic lighting, dramatic composition, 35mm film look, rich color grade",
  Illustration:
    "detailed hand-drawn illustration, expressive linework, balanced composition",
};

/** Providers offered in Settings. ComfyUI is listed but conditionally usable. */
export const SELECTABLE_PROVIDERS = [
  "openai-compatible",
  "stability",
  "fal",
  "gemini",
  "comfyui",
] as const;

export type SelectableProvider = (typeof SELECTABLE_PROVIDERS)[number];

function styleOverrides(settings: SettingsRecord): Record<string, string> {
  const raw = settings["image_style_overrides"];
  if (!isRecord(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) out[String(k)] = String(v);
  return out;
}

export function resolveStylePrompt(
  styleName: unknown,
  settings: SettingsRecord,
): string | null {
  const name: unknown =
    styleName == null ? settings["image_default_style"] : styleName;
  if (name == null) return null;
  if (
    typeof name === "string" &&
    ["", "none", "null"].includes(name.trim().toLowerCase())
  ) {
    return null;
  }
  if (typeof name !== "string") {
    throw new Error(`Unknown image style: ${pyRepr(name)}`);
  }
  const key = name.trim();
  const customs = settings["image_custom_styles"];
  if (Array.isArray(customs)) {
    for (const entry of customs) {
      if (
        isRecord(entry) &&
        String(entry["name"] ?? "").trim().toLowerCase() === key.toLowerCase()
      ) {
        const p = String(entry["prompt"] ?? "").trim();
        return p || null;
      }
    }
  }
  const overrides = styleOverrides(settings);
  for (const [builtinName, prompt] of Object.entries(BUILTIN_STYLES)) {
    if (builtinName.toLowerCase() === key.toLowerCase()) {
      if (builtinName === "None") return null;
      return overrides[builtinName] ?? prompt;
    }
  }
  throw new Error(`Unknown image style: ${pyRepr(key)}`);
}

export interface StyleInfo {
  name: string;
  prompt: string | null;
  defaultPrompt?: string | null;
  builtin: boolean;
  overridden?: boolean;
}

export function listStyles(settings: SettingsRecord): StyleInfo[] {
  const overrides = styleOverrides(settings);
  const out: StyleInfo[] = Object.entries(BUILTIN_STYLES).map(([n, p]) => ({
    name: n,
    prompt: overrides[n] ?? p,
    defaultPrompt: p,
    builtin: true,
    overridden: n in overrides,
  }));
  const customs = settings["image_custom_styles"];
  if (Array.isArray(customs)) {
    for (const entry of customs) {
      if (isRecord(entry) && String(entry["name"] ?? "").trim()) {
        out.push({
          name: String(entry["name"]).trim(),
          prompt: String(entry["prompt"] ?? ""),
          builtin: false,
        });
      }
    }
  }
  return out;
}

export function composeFinalPrompt(
  prompt: string,
  stylePrompt: string | null | undefined,
): string {
  const p = (prompt ?? "").trim();
  if (stylePrompt && stylePrompt.trim()) {
    return p ? `${p}\nStyle: ${stylePrompt.trim()}` : stylePrompt.trim();
  }
  return p;
}

// ---------------------------------------------------------------------------
// Generated image + provider contract
// ---------------------------------------------------------------------------

export interface GeneratedImage {
  data: Uint8Array;
  mimeType: string;
  // ComfyUI seed actually submitted, for display/comparison. Cloud
  // providers leave this unset/null.
  seed?: number | null;
}

export interface ImageProvider {
  generate(
    prompt: string,
    referenceBytes?: Uint8Array | null,
  ): Promise<GeneratedImage>;
}

export class OpenAICompatibleProvider implements ImageProvider {
  baseUrl: string;
  apiKey: string;
  model: string;

  constructor(baseUrl: string, apiKey: string, model: string) {
    this.baseUrl = (baseUrl || "").replace(/\/+$/, "");
    this.apiKey = apiKey || "";
    this.model = (model || "").trim();
  }

  private headers(contentJson = true): Record<string, string> {
    const h: Record<string, string> = {};
    if (contentJson) h["Content-Type"] = "application/json";
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  private async decodeImagePayload(payload: unknown): Promise<GeneratedImage> {
    const data = isRecord(payload) ? payload["data"] : undefined;
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error("Image provider returned no image data");
    }
    const first = isRecord(data[0]) ? data[0] : {};
    const b64 = first["b64_json"];
    if (typeof b64 === "string" && b64) {
      try {
        return { data: decodeBase64Image(b64), mimeType: "image/png", seed: null };
      } catch (e) {
        throw new Error(`Could not decode provider image: ${errMsg(e)}`);
      }
    }
    const url = first["url"];
    if (typeof url === "string" && url) {
      // urllib raises on non-2xx in Python; surface as a download failure
      // (downstream this classifies as HTTP 502, same as the raw raise).
      const dl = await fetchWithTimeout(
        url,
        { headers: { "User-Agent": "margin-writing-app/1.0" } },
        120_000,
      );
      if (!dl.ok) {
        throw new Error(`Could not download provider image (${dl.status})`);
      }
      return {
        data: new Uint8Array(await dl.arrayBuffer()),
        mimeType: dl.headers.get("Content-Type") ?? "image/png",
        seed: null,
      };
    }
    throw new Error("Image provider returned neither b64_json nor url");
  }

  async generate(
    prompt: string,
    referenceBytes?: Uint8Array | null,
  ): Promise<GeneratedImage> {
    if (!this.baseUrl) {
      throw new Error(
        "Image base URL is not configured (Settings → Image Generation)",
      );
    }
    if (!this.model) {
      throw new Error(
        "Image model is not configured (Settings → Image Generation)",
      );
    }
    if (!(prompt || "").trim()) throw new Error("Prompt is required");
    let resp: Response;
    try {
      if (referenceBytes && referenceBytes.length > 0) {
        const url = `${this.baseUrl}/v1/images/edits`;
        const form = new FormData();
        form.append("image", toBlob(referenceBytes, "image/png"), "reference.png");
        form.append("model", this.model);
        form.append("prompt", prompt);
        form.append("n", "1");
        form.append("size", "1024x1024");
        const headers: Record<string, string> = {};
        if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
        resp = await fetchWithTimeout(
          url,
          { method: "POST", headers, body: form },
          120_000,
        );
      } else {
        const url = `${this.baseUrl}/v1/images/generations`;
        resp = await fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify({
              model: this.model,
              prompt,
              n: 1,
              size: "1024x1024",
              response_format: "b64_json",
            }),
          },
          120_000,
        );
      }
    } catch (e) {
      throw new Error(`Image provider request failed: ${errMsg(e)}`);
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new Error("Image provider rejected the API key (401/403)");
    }
    if (resp.status === 404) {
      throw new Error(
        "Image endpoint not found — is this base URL image-capable?",
      );
    }
    if (!resp.ok) {
      throw new Error(
        `Image provider error (${resp.status}): ${await providerErrorText(resp)}`,
      );
    }
    let payload: unknown;
    try {
      payload = await resp.json();
    } catch (e) {
      throw new Error(`Image provider returned invalid JSON: ${errMsg(e)}`);
    }
    return this.decodeImagePayload(payload);
  }
}

export class StabilityProvider implements ImageProvider {
  static readonly API_ROOT = "https://api.stability.ai";
  apiKey: string;
  model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = (apiKey || "").trim();
    this.model = (model || "").trim() || "sd3.5-large";
  }

  async generate(
    prompt: string,
    referenceBytes?: Uint8Array | null,
  ): Promise<GeneratedImage> {
    if (!this.apiKey) {
      throw new Error(
        "Stability API key is not configured (Settings → Image Generation)",
      );
    }
    if (!(prompt || "").trim()) throw new Error("Prompt is required");
    const url = `${StabilityProvider.API_ROOT}/v2beta/stable-image/generate/sd3`;
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "image/*",
    };
    const form = new FormData();
    form.append("prompt", prompt);
    form.append("output_format", "png");
    form.append("model", this.model);
    if (referenceBytes && referenceBytes.length > 0) {
      form.append("image", toBlob(referenceBytes, "image/png"), "reference.png");
      form.append("mode", "image-to-image");
      form.append("strength", "0.7");
    }
    let resp: Response;
    try {
      resp = await fetchWithTimeout(
        url,
        { method: "POST", headers, body: form },
        120_000,
      );
    } catch (e) {
      throw new Error(`Stability request failed: ${errMsg(e)}`);
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new Error("Stability rejected the API key (401/403)");
    }
    if (!resp.ok) {
      throw new Error(
        `Stability error (${resp.status}): ${(await resp.text()).slice(0, 300)}`,
      );
    }
    return {
      data: new Uint8Array(await resp.arrayBuffer()),
      mimeType: resp.headers.get("Content-Type") ?? "image/png",
      seed: null,
    };
  }
}

export class FalProvider implements ImageProvider {
  apiKey: string;
  model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = (apiKey || "").trim();
    this.model = (model || "").trim();
  }

  async generate(
    prompt: string,
    referenceBytes?: Uint8Array | null,
  ): Promise<GeneratedImage> {
    if (!this.apiKey) {
      throw new Error(
        "FAL API key is not configured (Settings → Image Generation)",
      );
    }
    if (!this.model) {
      throw new Error(
        "FAL model is not configured (Settings → Image Generation)",
      );
    }
    if (!(prompt || "").trim()) throw new Error("Prompt is required");
    const headers = {
      Authorization: `Key ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    const payload: Record<string, unknown> = { prompt };
    if (referenceBytes && referenceBytes.length > 0) {
      payload["image_url"] =
        `data:image/png;base64,${base64Encode(referenceBytes)}`;
    }
    let sub: Response;
    try {
      sub = await fetchWithTimeout(
        `https://queue.fal.run/${this.model}`,
        { method: "POST", headers, body: JSON.stringify(payload) },
        30_000,
      );
    } catch (e) {
      throw new Error(`FAL submit failed: ${errMsg(e)}`);
    }
    if (sub.status === 401 || sub.status === 403) {
      throw new Error("FAL rejected the API key (401/403)");
    }
    if (!sub.ok) {
      throw new Error(
        `FAL submit error (${sub.status}): ${(await sub.text()).slice(0, 300)}`,
      );
    }
    let requestId: unknown;
    try {
      const subBody: unknown = await sub.json();
      requestId = isRecord(subBody) ? subBody["request_id"] : undefined;
    } catch {
      requestId = undefined;
    }
    if (!requestId) throw new Error("FAL did not return a request_id");
    const rid = String(requestId);
    const deadline = Date.now() + 180_000;
    let resultUrl: string | null = null;
    while (Date.now() < deadline) {
      let st: Response;
      try {
        st = await fetchWithTimeout(
          `https://queue.fal.run/${this.model}/requests/${rid}/status`,
          { headers: { Authorization: `Key ${this.apiKey}` } },
          30_000,
        );
      } catch (e) {
        throw new Error(`FAL status check failed: ${errMsg(e)}`);
      }
      if (!st.ok) {
        throw new Error(
          `FAL status error (${st.status}): ${(await st.text()).slice(0, 300)}`,
        );
      }
      const body: unknown = await st.json();
      const status = isRecord(body) ? body["status"] : undefined;
      if (status === "COMPLETED") {
        const responseUrl = isRecord(body) ? body["response_url"] : undefined;
        resultUrl =
          (typeof responseUrl === "string" && responseUrl) ||
          `https://queue.fal.run/${this.model}/requests/${rid}`;
        break;
      }
      if (status === "FAILED") {
        throw new Error(`FAL generation failed: ${String(body).slice(0, 300)}`);
      }
      await sleep(2000);
    }
    if (!resultUrl) throw new Error("FAL generation timed out");
    let out: unknown;
    try {
      const res = await fetchWithTimeout(
        resultUrl,
        { headers: { Authorization: `Key ${this.apiKey}` } },
        60_000,
      );
      if (!res.ok) throw new Error(`status ${res.status}`);
      out = await res.json();
    } catch (e) {
      throw new Error(`FAL result fetch failed: ${errMsg(e)}`);
    }
    const direct = isRecord(out) ? out["images"] : undefined;
    const nested =
      isRecord(out) && isRecord(out["data"]) ? out["data"]["images"] : undefined;
    const images = (
      Array.isArray(direct) ? direct : Array.isArray(nested) ? nested : []
    ) as unknown[];
    if (images.length === 0) throw new Error("FAL returned no images");
    const first = images[0];
    const imgUrl =
      isRecord(first) && typeof first["url"] === "string" ? first["url"] : null;
    if (!imgUrl) throw new Error("FAL returned an image without a url");
    try {
      const dl = await fetchWithTimeout(imgUrl, {}, 120_000);
      if (!dl.ok) throw new Error(`status ${dl.status}`);
      return {
        data: new Uint8Array(await dl.arrayBuffer()),
        mimeType: dl.headers.get("Content-Type") ?? "image/png",
        seed: null,
      };
    } catch (e) {
      throw new Error(`Could not download FAL image: ${errMsg(e)}`);
    }
  }
}

export class GeminiProvider implements ImageProvider {
  static readonly API_ROOT =
    "https://generativelanguage.googleapis.com/v1beta";
  apiKey: string;
  model: string;
  apiRoot: string;

  constructor(apiKey: string, model: string, baseUrl = "") {
    this.apiKey = (apiKey || "").trim();
    this.model = (model || "").trim();
    this.apiRoot = (baseUrl || "").replace(/\/+$/, "") || GeminiProvider.API_ROOT;
  }

  async generate(
    prompt: string,
    referenceBytes?: Uint8Array | null,
  ): Promise<GeneratedImage> {
    if (!this.apiKey) {
      throw new Error("Gemini API key is not configured (Settings → Images)");
    }
    if (!this.model) {
      throw new Error("Gemini model is not configured (Settings → Images)");
    }
    if (!(prompt || "").trim()) throw new Error("Prompt is required");
    const inputs: Record<string, unknown>[] = [{ type: "text", text: prompt }];
    if (referenceBytes && referenceBytes.length > 0) {
      const ext = inferUploadExt(referenceBytes);
      const mime =
        ext === "png" ? "image/png" : ext === "jpg" ? "image/jpeg" : "image/webp";
      inputs.push({
        type: "image",
        data: base64Encode(referenceBytes),
        mime_type: mime,
      });
    }
    let resp: Response;
    try {
      resp = await fetchWithTimeout(
        `${this.apiRoot}/interactions`,
        {
          method: "POST",
          headers: {
            "x-goog-api-key": this.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model: this.model, input: inputs }),
        },
        180_000,
      );
    } catch (e) {
      throw new Error(`Gemini request failed: ${errMsg(e)}`);
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new Error("Gemini rejected the API key (401/403)");
    }
    if (!resp.ok) {
      const msg = await providerErrorText(resp);
      if (msg.toUpperCase().includes("SAFETY")) {
        throw new Error(
          `Gemini refused the request on safety grounds: ${msg}`,
        );
      }
      throw new Error(`Gemini error (${resp.status}): ${msg}`);
    }
    let body: unknown;
    try {
      body = await resp.json();
    } catch {
      throw new Error("Gemini returned invalid JSON");
    }
    return extractGeminiImage(body);
  }

  /** Lightweight validation: confirms key + model exist, no generation. */
  async checkModel(): Promise<void> {
    if (!this.apiKey) {
      throw new Error("Gemini API key is not configured (Settings → Images)");
    }
    if (!this.model) {
      throw new Error("Gemini model is not configured (Settings → Images)");
    }
    let resp: Response;
    try {
      resp = await fetchWithTimeout(
        `${this.apiRoot}/models/${this.model}`,
        { headers: { "x-goog-api-key": this.apiKey } },
        30_000,
      );
    } catch (e) {
      throw new Error(`Could not reach Gemini: ${errMsg(e)}`);
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new Error("Gemini rejected the API key (401/403)");
    }
    if (resp.status === 404) {
      throw new Error(`Gemini model not found: ${pyRepr(this.model)}`);
    }
    if (!resp.ok) {
      throw new Error(
        `Gemini test failed (${resp.status}): ${(await resp.text()).slice(0, 300)}`,
      );
    }
  }
}

export function extractGeminiImage(body: unknown): GeneratedImage {
  if (isRecord(body)) {
    const direct = body["output_image"];
    if (isRecord(direct) && typeof direct["data"] === "string") {
      return decodeGeminiBlock(direct);
    }
  }
  const found = scanGeminiBlocks(body);
  if (found) return found;
  throw new Error(
    "Gemini returned no image (the request may have been safety-blocked)",
  );
}

export function decodeGeminiBlock(
  block: Record<string, unknown>,
): GeneratedImage {
  let raw: Uint8Array;
  try {
    raw = decodeBase64Image(String(block["data"]));
  } catch (e) {
    throw new Error(`Gemini returned undecodable image data: ${errMsg(e)}`);
  }
  let ext: UploadExt;
  try {
    ext = inferUploadExt(raw);
  } catch {
    throw new Error("Gemini returned an invalid image");
  }
  const mime =
    ext === "png" ? "image/png" : ext === "jpg" ? "image/jpeg" : "image/webp";
  return { data: raw, mimeType: mime, seed: null };
}

export function scanGeminiBlocks(node: unknown): GeneratedImage | null {
  if (isRecord(node)) {
    for (const value of Object.values(node)) {
      const found = scanGeminiBlocks(value);
      if (found) return found;
    }
  } else if (Array.isArray(node)) {
    for (const item of node) {
      const found = scanGeminiBlocks(item);
      if (found) return found;
    }
  } else if (typeof node === "string" && node.length > 50) {
    try {
      return decodeGeminiBlock({ data: node });
    } catch {
      // Not image bytes — keep scanning.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// ComfyUI
// ---------------------------------------------------------------------------

export type ComfyWorkflow = Record<string, unknown>;
export type ComfyMapping = Record<string, unknown>;

export class ComfyUIBundle {
  workflow: ComfyWorkflow;
  promptMap: ComfyMapping;
  imageMap: ComfyMapping | null;
  seedMap: ComfyMapping | null;

  constructor(
    workflow: ComfyWorkflow,
    promptMap: ComfyMapping,
    imageMap: ComfyMapping | null = null,
    seedMap: ComfyMapping | null = null,
  ) {
    this.workflow = workflow;
    this.promptMap = promptMap;
    this.imageMap = imageMap;
    this.seedMap = seedMap;
  }
}

export class ComfyUIProvider implements ImageProvider {
  baseUrl: string;
  text: ComfyUIBundle | null;
  edit: ComfyUIBundle | null;

  constructor(
    baseUrl: string,
    text: ComfyUIBundle | null = null,
    edit: ComfyUIBundle | null = null,
  ) {
    this.baseUrl = (baseUrl || "").replace(/\/+$/, "");
    this.text = text;
    this.edit = edit;
  }

  /** Identify a failing node from the saved workflow for error messages. */
  describeNode(workflow: ComfyWorkflow, nodeId: unknown): string {
    const raw = workflow[String(nodeId)];
    const node = isRecord(raw) ? raw : {};
    const meta = isRecord(node["_meta"]) ? node["_meta"] : {};
    const title = typeof meta["title"] === "string" ? meta["title"] : "";
    const classType = node["class_type"] ?? "?";
    const label = title ? ` "${title}"` : "";
    return `node ${String(nodeId)}${label} (${String(classType)})`;
  }

  async uploadReference(referenceBytes: Uint8Array): Promise<string> {
    const ext = inferUploadExt(referenceBytes);
    const filename = `margin-${uuidHex()}.${ext}`;
    const mime =
      ext === "png" ? "image/png" : ext === "jpg" ? "image/jpeg" : "image/webp";
    let resp: Response;
    try {
      const form = new FormData();
      form.append("image", toBlob(referenceBytes, mime), filename);
      form.append("overwrite", "true");
      form.append("type", "input");
      resp = await fetchWithTimeout(
        `${this.baseUrl}/upload/image`,
        { method: "POST", body: form },
        60_000,
      );
    } catch (e) {
      throw new Error(`Could not reach ComfyUI at ${this.baseUrl}: ${errMsg(e)}`);
    }
    if (!resp.ok) {
      throw new Error(
        `ComfyUI reference upload failed (${resp.status}): ${(await resp.text()).slice(0, 300)}`,
      );
    }
    let name: unknown;
    try {
      const body: unknown = await resp.json();
      name = isRecord(body) ? body["name"] : undefined;
    } catch {
      name = undefined;
    }
    if (!name) throw new Error("ComfyUI upload returned no filename");
    return String(name);
  }

  async generate(
    prompt: string,
    referenceBytes?: Uint8Array | null,
  ): Promise<GeneratedImage> {
    if (!this.baseUrl) {
      throw new Error("ComfyUI base URL is not configured (Settings → Images)");
    }
    if (!(prompt || "").trim()) throw new Error("Prompt is required");

    // Route by operation. Only the needed slot is validated, so a stale
    // edit workflow never breaks text generation and vice versa. Note:
    // `!= null` (not emptiness) mirrors Python's `is not None` check.
    let bundle: ComfyUIBundle;
    let uploadedName: string | null = null;
    if (referenceBytes != null) {
      if (this.edit == null) {
        throw new Error(
          "Reference regeneration needs an edit workflow — import one " +
            "in Settings → Images (ComfyUI edit workflow).",
        );
      }
      bundle = this.edit;
      validateComfyPromptMap(bundle.workflow, bundle.promptMap);
      validateComfyEditImageMap(bundle.workflow, bundle.imageMap);
      uploadedName = await this.uploadReference(referenceBytes);
    } else {
      if (this.text == null) {
        throw new Error(
          "Plain image generation needs a text-to-image workflow — " +
            "import one in Settings → Images (ComfyUI text workflow).",
        );
      }
      bundle = this.text;
      validateComfyPromptMap(bundle.workflow, bundle.promptMap);
    }

    const nodeId = String(bundle.promptMap["nodeId"]);
    const inputName = String(bundle.promptMap["input"]);
    // Deep copy: the saved workflow is immutable configuration.
    const outgoing: ComfyWorkflow = structuredClone(bundle.workflow);
    (outgoing[nodeId] as Record<string, unknown>)["inputs"] = {
      ...((outgoing[nodeId] as Record<string, unknown>)["inputs"] as Record<string, unknown>),
      [inputName]: prompt,
    };
    if (uploadedName != null && bundle.imageMap != null) {
      const refNode = String(bundle.imageMap["nodeId"]);
      const refInput = String(bundle.imageMap["input"]);
      (outgoing[refNode] as Record<string, unknown>)["inputs"] = {
        ...((outgoing[refNode] as Record<string, unknown>)["inputs"] as Record<string, unknown>),
        [refInput]: uploadedName,
      };
    }
    const submittedSeed = ComfyUIProvider.rollSeed(bundle, outgoing);

    const promptId = await this.submitWorkflow(outgoing, bundle.workflow);
    const outputs = await this.pollHistory(promptId);
    const result = await this.downloadFirst(outputs);
    result.seed = submittedSeed;
    return result;
  }

  static rollSeed(
    bundle: ComfyUIBundle,
    outgoing: ComfyWorkflow,
  ): number | null {
    if (bundle.seedMap == null) return null;
    validateComfySeedMap(bundle.workflow, bundle.seedMap);
    const seed = Math.floor(Math.random() * 4294967296);
    const node = outgoing[String(bundle.seedMap["nodeId"])] as Record<string, unknown>;
    node["inputs"] = {
      ...(node["inputs"] as Record<string, unknown>),
      [String(bundle.seedMap["input"])]: seed,
    };
    return seed;
  }

  /** Queue the overlaid workflow copy; return the prompt id. */
  private async submitWorkflow(
    outgoing: ComfyWorkflow,
    workflow: ComfyWorkflow,
  ): Promise<string> {
    let sub: Response;
    try {
      sub = await fetchWithTimeout(
        `${this.baseUrl}/prompt`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: outgoing }),
        },
        30_000,
      );
    } catch (e) {
      throw new Error(`Could not reach ComfyUI at ${this.baseUrl}: ${errMsg(e)}`);
    }
    if (!sub.ok) {
      throw new Error(
        `ComfyUI rejected the workflow (${sub.status}): ${(await sub.text()).slice(0, 300)}`,
      );
    }
    let body: unknown;
    try {
      body = await sub.json();
    } catch {
      throw new Error("ComfyUI returned invalid JSON for /prompt");
    }
    const rec = isRecord(body) ? body : {};
    const nodeErrors = isRecord(rec["node_errors"])
      ? (rec["node_errors"] as Record<string, unknown>)
      : {};
    const entries = Object.entries(nodeErrors);
    if (entries.length > 0) {
      const [errId, first] = entries[0];
      const detail = String(
        isRecord(first) && first["errors"] !== undefined ? first["errors"] : first,
      ).slice(0, 300);
      throw new Error(
        `ComfyUI workflow error on ${this.describeNode(workflow, errId)}: ` +
          `${detail}${comfyValidationHint(detail)}`,
      );
    }
    const promptId = rec["prompt_id"];
    if (!promptId) throw new Error("ComfyUI did not return a prompt_id");
    return String(promptId);
  }

  /** Poll /history until completion; return the output map. */
  private async pollHistory(promptId: string): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      let hist: Response;
      try {
        hist = await fetchWithTimeout(
          `${this.baseUrl}/history/${promptId}`,
          {},
          30_000,
        );
      } catch (e) {
        throw new Error(`ComfyUI poll failed: ${errMsg(e)}`);
      }
      if (!hist.ok) {
        throw new Error(
          `ComfyUI history error (${hist.status}): ${(await hist.text()).slice(0, 300)}`,
        );
      }
      let entry: Record<string, unknown> = {};
      try {
        const body: unknown = await hist.json();
        if (!isRecord(body)) throw new Error("bad envelope");
        const raw = body[promptId];
        entry = isRecord(raw) ? raw : {};
      } catch {
        throw new Error("ComfyUI returned invalid JSON for /history");
      }
      const status = isRecord(entry["status"]) ? entry["status"] : {};
      if (status["status_str"] === "error") {
        const msgs = String(
          "messages" in status ? status["messages"] : status,
        ).slice(0, 300);
        throw new Error(`ComfyUI execution failed: ${msgs}`);
      }
      if (status["completed"]) {
        const outputs = entry["outputs"];
        return isRecord(outputs) ? outputs : {};
      }
      await sleep(2000);
    }
    throw new Error("ComfyUI generation timed out");
  }

  /** Download the first output image (v1 simplification). */
  private async downloadFirst(
    outputs: Record<string, unknown>,
  ): Promise<GeneratedImage> {
    const imageRef = firstComfyImage(outputs);
    if (!imageRef) throw new Error("ComfyUI finished with no output images");
    try {
      const qs = new URLSearchParams({
        filename: imageRef.filename,
        subfolder: imageRef.subfolder,
        type: imageRef.type,
      });
      const dl = await fetchWithTimeout(
        `${this.baseUrl}/view?${qs.toString()}`,
        {},
        120_000,
      );
      if (!dl.ok) throw new Error(`status ${dl.status}`);
      return {
        data: new Uint8Array(await dl.arrayBuffer()),
        mimeType: dl.headers.get("Content-Type") ?? "image/png",
        seed: null,
      };
    } catch (e) {
      throw new Error(`Could not download ComfyUI image: ${errMsg(e)}`);
    }
  }
}

export function comfyValidationHint(detail: string): string {
  // `not in []` means the server's model list for that loader is empty:
  // the file isn't installed on the instance Margin is talking to.
  if (detail.includes("not in []")) {
    return (
      " — that file isn't installed on the ComfyUI server at the " +
      "configured base URL (its model list is empty). Check Settings → " +
      "Images points at the same instance where the workflow runs, and " +
      "that the file exists in its models folder."
    );
  }
  return "";
}

export type UploadExt = "png" | "jpg" | "webp";

function startsWithBytes(head: Uint8Array, sig: number[]): boolean {
  if (head.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (head[i] !== sig[i]) return false;
  }
  return true;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47];
const JPG_SIG = [0xff, 0xd8, 0xff];
const GIF87_SIG = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89_SIG = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const RIFF_SIG = [0x52, 0x49, 0x46, 0x46];
const WEBP_SIG = [0x57, 0x45, 0x42, 0x50];

export function inferUploadExt(data: Uint8Array): UploadExt {
  const head = data.subarray(0, 12);
  if (startsWithBytes(head, PNG_SIG)) return "png";
  if (startsWithBytes(head, JPG_SIG)) return "jpg";
  if (startsWithBytes(head, RIFF_SIG) && startsWithBytes(head.subarray(8, 12), WEBP_SIG)) {
    return "webp";
  }
  throw new Error(
    "Reference image format is not supported by the ComfyUI upload " +
      "(png, jpg, webp)",
  );
}

export interface ComfyImageRef {
  filename: string;
  subfolder: string;
  type: string;
}

export function firstComfyImage(
  outputs: Record<string, unknown>,
): ComfyImageRef | null {
  // Node ids are numeric strings — sort numerically so node 9 beats node 10.
  const order = (key: string): [number, number] => {
    const n = Number(key);
    if (key.trim() !== "" && Number.isInteger(n)) return [0, n];
    return [1, 0];
  };
  const keys = Object.keys(outputs).sort((a, b) => {
    const [ao, an] = order(a);
    const [bo, bn] = order(b);
    if (ao !== bo) return ao - bo;
    if (an !== bn) return an - bn;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (const nodeId of keys) {
    const nodeOut = outputs[nodeId];
    if (!isRecord(nodeOut)) continue;
    const images = nodeOut["images"];
    if (!Array.isArray(images) || images.length === 0) continue;
    const img = images[0];
    if (isRecord(img) && typeof img["filename"] === "string" && img["filename"]) {
      return {
        filename: img["filename"],
        subfolder: String(img["subfolder"] ?? ""),
        type: String(img["type"] ?? "output"),
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// ComfyUI workflow validators / candidate extractors
// ---------------------------------------------------------------------------

export const MAX_COMFY_WORKFLOW_NODES = 500;
export const MAX_COMFY_WORKFLOW_BYTES = 2_000_000;

export function validateComfyWorkflow(workflow: unknown): ComfyWorkflow {
  if (!isRecord(workflow) || Object.keys(workflow).length === 0) {
    throw new Error("ComfyUI workflow must be a non-empty object");
  }
  if ("nodes" in workflow || "links" in workflow) {
    throw new Error(
      "That looks like ComfyUI graph format — export as API format " +
        "(ComfyUI Manager/menu → Export (API)) and import that file instead.",
    );
  }
  if (Object.keys(workflow).length > MAX_COMFY_WORKFLOW_NODES) {
    throw new Error(
      `ComfyUI workflow has ${Object.keys(workflow).length} nodes (max ${MAX_COMFY_WORKFLOW_NODES})`,
    );
  }
  if (JSON.stringify(workflow).length > MAX_COMFY_WORKFLOW_BYTES) {
    throw new Error("ComfyUI workflow is too large to store (max ~2MB)");
  }
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!isRecord(node) || !isRecord(node["inputs"])) {
      throw new Error(
        `ComfyUI workflow node ${pyRepr(nodeId)} is not API format ` +
          "(expected {class_type, inputs})",
      );
    }
    if (!node["class_type"]) {
      throw new Error(
        `ComfyUI workflow node ${pyRepr(nodeId)} has no class_type`,
      );
    }
  }
  return workflow;
}

function mappingTarget(
  workflow: ComfyWorkflow,
  map: ComfyMapping,
): { nodeId: string; inputName: string; inputs: Record<string, unknown> } | null {
  const nodeId = String(map["nodeId"] ?? "");
  const inputName = String(map["input"] ?? "");
  const node = workflow[nodeId];
  if (!isRecord(node)) return null;
  const inputs = isRecord(node["inputs"]) ? node["inputs"] : {};
  return { nodeId, inputName, inputs };
}

export function validateComfyPromptMap(
  workflow: ComfyWorkflow,
  promptMap: unknown,
): void {
  if (!isRecord(promptMap)) {
    throw new Error(
      "ComfyUI prompt mapping is not configured — import an API-format " +
        "workflow and pick the prompt input (Settings → Images)",
    );
  }
  const target = mappingTarget(workflow, promptMap);
  if (!target) {
    throw new Error(
      "The saved ComfyUI prompt mapping no longer matches the workflow " +
        `(node ${pyRepr(String(promptMap["nodeId"] ?? ""))} missing) — re-import the workflow.`,
    );
  }
  const { nodeId, inputName, inputs } = target;
  if (!(inputName in inputs)) {
    throw new Error(
      "The saved ComfyUI prompt mapping no longer matches the workflow " +
        `(input ${pyRepr(inputName)} missing on node ${pyRepr(nodeId)}) — re-import the workflow.`,
    );
  }
  const current = inputs[inputName];
  if (current != null && typeof current !== "string") {
    throw new Error(
      `ComfyUI prompt input ${pyRepr(inputName)} on node ${pyRepr(nodeId)} is not a ` +
        "text field — pick a text input instead.",
    );
  }
}

export function validateComfyEditImageMap(
  workflow: ComfyWorkflow,
  refMap: unknown,
): void {
  if (refMap == null) {
    throw new Error(
      "ComfyUI edit workflow needs a reference image input — pick a " +
        "LoadImage input (Settings → Images)",
    );
  }
  if (!isRecord(refMap)) {
    throw new Error(
      "ComfyUI reference mapping is invalid — re-pick the reference " +
        "image input (Settings → Images)",
    );
  }
  const target = mappingTarget(workflow, refMap);
  if (!target) {
    throw new Error(
      "The saved ComfyUI reference mapping no longer matches the workflow " +
        `(node ${pyRepr(String(refMap["nodeId"] ?? ""))} missing) — re-import the workflow.`,
    );
  }
  const { nodeId, inputName, inputs } = target;
  if (!(inputName in inputs)) {
    throw new Error(
      "The saved ComfyUI reference mapping no longer matches the workflow " +
        `(input ${pyRepr(inputName)} missing on node ${pyRepr(nodeId)}) — re-import the workflow.`,
    );
  }
  const current = inputs[inputName];
  if (current != null && typeof current !== "string") {
    throw new Error(
      `ComfyUI reference input ${pyRepr(inputName)} on node ${pyRepr(nodeId)} is not ` +
        "an image field — pick a LoadImage input instead.",
    );
  }
}

export function isSeedValue(value: unknown): boolean {
  // typeof boolean excludes JSON booleans, mirroring Python's
  // `isinstance(int) and not isinstance(bool)` guard.
  return typeof value === "number" && Number.isInteger(value);
}

export function validateComfySeedMap(
  workflow: ComfyWorkflow,
  seedMap: unknown,
): void {
  if (seedMap == null) return;
  if (!isRecord(seedMap)) {
    throw new Error(
      "ComfyUI seed mapping is invalid — re-pick the seed input " +
        "(Settings → Images)",
    );
  }
  const target = mappingTarget(workflow, seedMap);
  if (!target) {
    throw new Error(
      "The saved ComfyUI seed mapping no longer matches the workflow " +
        `(node ${pyRepr(String(seedMap["nodeId"] ?? ""))} missing) — re-import the workflow.`,
    );
  }
  const { nodeId, inputName, inputs } = target;
  if (!(inputName in inputs)) {
    throw new Error(
      "The saved ComfyUI seed mapping no longer matches the workflow " +
        `(input ${pyRepr(inputName)} missing on node ${pyRepr(nodeId)}) — re-import the workflow.`,
    );
  }
  const current = inputs[inputName];
  if (current != null && !isSeedValue(current)) {
    throw new Error(
      `ComfyUI seed input ${pyRepr(inputName)} on node ${pyRepr(nodeId)} is not ` +
        "a seed field — pick an integer seed input instead.",
    );
  }
}

export interface ComfyCandidate {
  nodeId: string;
  classType: string;
  input: string;
  preview: string;
  kind: string;
  score: number;
}

function candidateOrder(a: ComfyCandidate, b: ComfyCandidate): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.nodeId !== b.nodeId) return a.nodeId < b.nodeId ? -1 : 1;
  if (a.input !== b.input) return a.input < b.input ? -1 : 1;
  return 0;
}

function truncPreview(value: string): string {
  return value.length <= 80 ? value : `${value.slice(0, 77)}...`;
}

function seedScore(name: string): [number, string] {
  const n = name.toLowerCase();
  if (n === "seed" || n === "noise_seed") return [100, "seed"];
  if (n.includes("seed")) return [80, "seed-like"];
  return [10, "other-int"];
}

export function extractComfySeedCandidates(
  workflow: ComfyWorkflow,
): ComfyCandidate[] {
  const out: ComfyCandidate[] = [];
  for (const nodeId of Object.keys(workflow).sort()) {
    const node = workflow[nodeId];
    if (!isRecord(node)) continue;
    const classType = String(node["class_type"] ?? "");
    const inputs = isRecord(node["inputs"]) ? node["inputs"] : null;
    if (!inputs) continue;
    for (const [name, value] of Object.entries(inputs)) {
      if (!isSeedValue(value)) continue;
      const [score, kind] = seedScore(String(name));
      out.push({
        nodeId: String(nodeId),
        classType,
        input: String(name),
        preview: String(value),
        kind,
        score,
      });
    }
  }
  out.sort(candidateOrder);
  return out;
}

function imageScore(classType: string, name: string): [number, string] {
  const n = name.toLowerCase();
  const ct = classType.toLowerCase();
  if (ct.includes("loadimage") && n === "image") return [100, "reference-image"];
  if (ct.includes("loadimage")) return [80, "loader-input"];
  if (n === "image") return [70, "image"];
  if (n === "upload" || n === "filename" || n === "file" || n === "path") {
    return [50, "file-like"];
  }
  if (n.includes("image")) return [40, "image-like"];
  return [10, "other-text"];
}

export function extractComfyImageCandidates(
  workflow: ComfyWorkflow,
): ComfyCandidate[] {
  const out: ComfyCandidate[] = [];
  for (const nodeId of Object.keys(workflow).sort()) {
    const node = workflow[nodeId];
    if (!isRecord(node)) continue;
    const classType = String(node["class_type"] ?? "");
    const inputs = isRecord(node["inputs"]) ? node["inputs"] : null;
    if (!inputs) continue;
    for (const [name, value] of Object.entries(inputs)) {
      if (typeof value !== "string") continue;
      // The LoadImage `upload` widget is a mode selector
      // ("image"/"mask"), not an image field — never inject there.
      if (classType === "LoadImage" && String(name) === "upload") continue;
      const [score, kind] = imageScore(classType, String(name));
      out.push({
        nodeId: String(nodeId),
        classType,
        input: String(name),
        preview: truncPreview(value),
        kind,
        score,
      });
    }
  }
  out.sort(candidateOrder);
  return out;
}

function textScore(classType: string, name: string): [number, string] {
  const n = name.toLowerCase();
  if (classType === "CLIPTextEncode" && name === "text") {
    return [100, "positive-prompt"];
  }
  if (
    (n.includes("positive") && n.includes("prompt")) ||
    n === "positive" ||
    n === "pos_prompt"
  ) {
    return [80, "positive-prompt"];
  }
  if (n.includes("prompt")) return [75, "prompt-like"];
  if (n === "text") return [70, "text"];
  if (n.includes("text") || n.includes("caption")) return [60, "text-like"];
  return [10, "other-text"];
}

export function extractComfyTextCandidates(
  workflow: ComfyWorkflow,
): ComfyCandidate[] {
  const out: ComfyCandidate[] = [];
  for (const nodeId of Object.keys(workflow).sort()) {
    const node = workflow[nodeId];
    if (!isRecord(node)) continue;
    const classType = String(node["class_type"] ?? "");
    const inputs = isRecord(node["inputs"]) ? node["inputs"] : null;
    if (!inputs) continue;
    for (const [name, value] of Object.entries(inputs)) {
      if (typeof value !== "string") continue;
      const [score, kind] = textScore(classType, String(name));
      out.push({
        nodeId: String(nodeId),
        classType,
        input: String(name),
        preview: truncPreview(value),
        kind,
        score,
      });
    }
  }
  out.sort(candidateOrder);
  return out;
}

export function comfyTextBundle(
  settings: SettingsRecord,
): ComfyUIBundle | null {
  const workflow = settings["image_comfy_text_workflow"];
  const promptMap = settings["image_comfy_text_prompt_map"];
  if (!isRecord(workflow) || Object.keys(workflow).length === 0) return null;
  if (!isRecord(promptMap)) return null;
  const seedMap = settings["image_comfy_text_seed_map"];
  return new ComfyUIBundle(
    workflow,
    promptMap,
    null,
    isRecord(seedMap) ? seedMap : null,
  );
}

export function comfyEditBundle(
  settings: SettingsRecord,
): ComfyUIBundle | null {
  const workflow = settings["image_comfy_edit_workflow"];
  const promptMap = settings["image_comfy_edit_prompt_map"];
  const imageMap = settings["image_comfy_edit_image_map"];
  if (!isRecord(workflow) || Object.keys(workflow).length === 0) return null;
  if (!isRecord(promptMap)) return null;
  if (!isRecord(imageMap)) return null;
  const seedMap = settings["image_comfy_edit_seed_map"];
  return new ComfyUIBundle(
    workflow,
    promptMap,
    imageMap,
    isRecord(seedMap) ? seedMap : null,
  );
}

export function activeImageEntry(settings: SettingsRecord): SettingsRecord {
  const entries = settings["image_endpoints"];
  if (!isRecord(entries) || Object.keys(entries).length === 0) {
    throw new Error(
      "No image provider is configured — add one in Settings → Imagine.",
    );
  }
  const key = settings["active_image_endpoint"];
  const entry = typeof key === "string" ? entries[key] : undefined;
  if (!isRecord(entry)) {
    throw new Error(
      "No image provider is selected — pick one in Settings → Imagine.",
    );
  }
  return entry;
}

function entryGet(entry: SettingsRecord, key: string): string {
  const v = entry[key];
  if (!v) return "";
  return typeof v === "string" ? v.trim() : String(v).trim();
}

export function getImageProvider(settings: SettingsRecord): ImageProvider {
  const entry = activeImageEntry(settings);
  const name = (entryGet(entry, "provider") || "openai-compatible").toLowerCase();
  if (
    name === "openai-compatible" ||
    name === "openai" ||
    name === "lmstudio" ||
    name === "local"
  ) {
    return new OpenAICompatibleProvider(
      entryGet(entry, "base_url"),
      entryGet(entry, "api_key"),
      entryGet(entry, "model"),
    );
  }
  if (name === "stability") {
    return new StabilityProvider(
      entryGet(entry, "api_key"),
      entryGet(entry, "model"),
    );
  }
  if (name === "fal") {
    return new FalProvider(entryGet(entry, "api_key"), entryGet(entry, "model"));
  }
  if (name === "gemini") {
    return new GeminiProvider(
      entryGet(entry, "api_key"),
      entryGet(entry, "model"),
      entryGet(entry, "base_url"),
    );
  }
  if (name === "comfyui") {
    const text = comfyTextBundle(settings);
    const edit = comfyEditBundle(settings);
    if (text == null && edit == null) {
      throw new Error(
        "No ComfyUI workflow is configured — import a text-to-image " +
          "and/or edit workflow in Settings → Images.",
      );
    }
    return new ComfyUIProvider(entryGet(entry, "base_url"), text, edit);
  }
  throw new Error(
    `Unknown image provider: ${pyRepr(name)} (expected one of: ${SELECTABLE_PROVIDERS.join(", ")})`,
  );
}

// ---------------------------------------------------------------------------
// Workspace storage (logs + generated assets)
// ---------------------------------------------------------------------------

/** Mirror of file_storage `_image_logs_path` (per-workspace history). */
export function imageLogsPath(workspaceDir: string): string {
  return join(workspaceDir, "outputs", "image_logs", "images.json");
}

export async function getImageLogs(
  workspaceDir: string,
): Promise<Record<string, unknown>[]> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(imageLogsPath(workspaceDir), "utf8"));
  } catch {
    return [];
  }
  const logs = (Array.isArray(data) ? data : []).filter(isRecord);
  logs.sort((a, b) => {
    const ta = String(a["timestamp"] ?? "");
    const tb = String(b["timestamp"] ?? "");
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
  return logs;
}

export async function saveImageLog(
  workspaceDir: string,
  entry: Record<string, unknown>,
): Promise<void> {
  try {
    await mkdir(join(workspaceDir, "outputs", "image_logs"), { recursive: true });
  } catch {
    // Mirror Python's pass-through; getImageLogs degrades to [] below.
  }
  const logs = await getImageLogs(workspaceDir);
  const full: Record<string, unknown> = { ...entry };
  if (full["id"] == null) full["id"] = uuidHex();
  logs.push(full);
  const capped = logs.slice(-100);
  try {
    await writeFile(imageLogsPath(workspaceDir), JSON.stringify(capped, null, 2));
  } catch {
    // Logging must never fail the generation itself.
  }
}

export async function deleteImageLog(
  workspaceDir: string,
  logId: string,
): Promise<boolean> {
  const logs = await getImageLogs(workspaceDir);
  const kept = logs.filter((e) => e["id"] !== logId);
  if (kept.length === logs.length) return false;
  try {
    await writeFile(imageLogsPath(workspaceDir), JSON.stringify(kept, null, 2));
  } catch {
    // Mirror Python's pass-through.
  }
  return true;
}

function startsWithSig(head: Uint8Array, sig: number[]): boolean {
  return startsWithBytes(head, sig);
}

/** Mirror of `_sniff_image_ext` (bytes win; jpeg normalizes to jpg). */
function sniffImageExt(head: Uint8Array): string | null {
  if (startsWithSig(head, PNG_SIG)) return "png";
  if (startsWithSig(head, JPG_SIG)) return "jpg";
  if (startsWithSig(head, GIF87_SIG) || startsWithSig(head, GIF89_SIG)) {
    return "gif";
  }
  if (
    startsWithSig(head, RIFF_SIG) &&
    head.length >= 12 &&
    startsWithSig(head.subarray(8, 12), WEBP_SIG)
  ) {
    return "webp";
  }
  return null;
}

export interface SavedGenerated {
  name: string;
  path: string;
}

/**
 * Mirror of `save_generated_bytes`: opaque uuid4 names under
 * assets/generated/, never overwrites. `_contentType` is accepted for
 * signature parity — magic bytes win, same as Python.
 */
export async function saveGeneratedBytes(
  workspaceDir: string,
  data: Uint8Array,
  _contentType = "",
): Promise<SavedGenerated> {
  void _contentType;
  if (!data || data.length === 0) throw new Error("Empty file");
  const sniffed = sniffImageExt(data.subarray(0, 12));
  if (!sniffed) throw new Error("Not a supported image (png, jpg, webp, gif)");
  const ext = sniffed === "jpeg" ? "jpg" : sniffed;
  const genDir = join(workspaceDir, "assets", "generated");
  await mkdir(genDir, { recursive: true });
  for (let i = 0; i < 5; i++) {
    const fname = `${uuidHex()}.${ext}`;
    try {
      await writeFile(join(genDir, fname), data, { flag: "wx" });
      return { name: fname, path: `assets/generated/${fname}` };
    } catch (e) {
      if ((e as { code?: unknown })?.code !== "EEXIST") throw e;
      // Name collision — retry with a fresh uuid.
    }
  }
  throw new Error("Could not allocate a generated asset name");
}

/** Mirror of `_media_resolve`: strictly inside <workspace>/assets/. */
export function resolveMediaPath(workspaceDir: string, relPath: string): string {
  let cleaned = (relPath ?? "").replace(/\\/g, "/").trim();
  if (cleaned.startsWith("assets/")) cleaned = cleaned.slice("assets/".length);
  if (
    !cleaned ||
    cleaned.startsWith(".") ||
    cleaned.startsWith("/") ||
    cleaned.split("/").includes("..")
  ) {
    throw new Error("Access denied");
  }
  const base = resolve(join(workspaceDir, "assets"));
  const full = resolve(base, cleaned);
  const rel = relative(base, full);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Access denied");
  }
  return full;
}

async function readReferenceBytes(
  workspaceDir: string,
  refPath: string,
): Promise<Uint8Array> {
  let full: string;
  try {
    full = resolveMediaPath(workspaceDir, refPath);
  } catch (e) {
    // read_media ValueError ("Access denied") surfaces verbatim (HTTP 400).
    throw new ImageHttpError(400, errMsg(e));
  }
  try {
    return new Uint8Array(await readFile(full));
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    const msg = errMsg(e);
    if (code === "ENOENT" || code === "EISDIR" || /ENOENT|EISDIR/.test(msg)) {
      // read_media FileNotFoundError (missing file or directory).
      throw new ImageHttpError(400, `Reference image not found: ${refPath}`);
    }
    throw new ImageHttpError(400, `Could not read reference image: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Router behavior (api/routers/images.py)
// ---------------------------------------------------------------------------

/**
 * HTTP status carrier for image-route failures. The TS route layer maps
 * ImageHttpError -> { status, detail } directly, mirroring FastAPI's
 * HTTPException(status_code, detail).
 */
export class ImageHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ImageHttpError";
    this.status = status;
  }
}

/**
 * Mirror of the generate_image except-ValueError classifier: config/auth
 * style errors are client errors (400); upstream failures are 502.
 */
export function imageErrorStatus(message: string): 400 | 502 {
  const markers = [
    "not configured",
    "Unknown image provider",
    "Unknown image style",
    "Prompt is required",
    "rejected the API key",
    "not found — is this",
    "not supported by the",
    "no longer matches",
    "API format",
    "not API format",
    "is not a text field",
    "is not an image field",
    "is not a seed field",
    "seed mapping is invalid",
    "needs a reference image input",
    "needs an edit workflow",
    "needs a text-to-image workflow",
    "Settings → Images",
    "ComfyUI workflow error",
    "ComfyUI rejected the workflow",
  ];
  return markers.some((s) => message.includes(s)) ? 400 : 502;
}

export interface ComfyAnalysis {
  nodeCount: number;
  candidates: ComfyCandidate[];
  imageCandidates: ComfyCandidate[];
  seedCandidates: ComfyCandidate[];
}

/** Mirror of analyze_comfy_workflow (camelCase keys; throws on invalid). */
export function analyzeComfyWorkflow(workflow: unknown): ComfyAnalysis {
  const typed = validateComfyWorkflow(workflow);
  return {
    nodeCount: Object.keys(typed).length,
    candidates: extractComfyTextCandidates(typed),
    imageCandidates: extractComfyImageCandidates(typed),
    seedCandidates: extractComfySeedCandidates(typed),
  };
}

/**
 * Docker reveal: no OS file explorer is ever spawned (never xdg-open);
 * the fixed generated-asset dir is ensured and its workspace-relative
 * path returned.
 */
export async function revealGeneratedFolder(
  workspaceDir: string,
): Promise<{ success: boolean; path: string }> {
  await mkdir(join(workspaceDir, "assets", "generated"), { recursive: true });
  return { success: true, path: "assets/generated" };
}

export interface GenerateImageInput {
  prompt: string;
  /** Maps to Python's `style_name`. */
  style?: string | null;
  reference_path?: string | null;
}

export interface GenerateImageResult {
  path: string;
  seed: number | null;
  /** Final composed prompt sent to the provider (style suffix included). */
  prompt: string;
}

/** Mirror of generate_image (throws ImageHttpError with 400/502 status). */
export async function generateImage(
  input: GenerateImageInput,
  settings: SettingsRecord,
  workspaceDir: string,
): Promise<GenerateImageResult> {
  const prompt = (input.prompt ?? "").trim();
  const refPath = (input.reference_path ?? "").trim() || null;

  // Every entry point requires typed content — empty prompts are always
  // a client error, never silently expanded server-side.
  if (!prompt) throw new ImageHttpError(400, "Prompt is required");

  let stylePrompt: string | null;
  try {
    stylePrompt = resolveStylePrompt(input.style ?? null, settings);
  } catch (e) {
    throw new ImageHttpError(400, errMsg(e));
  }

  const referenceBytes =
    refPath != null ? await readReferenceBytes(workspaceDir, refPath) : null;

  const finalPrompt = composeFinalPrompt(prompt, stylePrompt);

  let provider: ImageProvider;
  try {
    provider = getImageProvider(settings);
  } catch (e) {
    throw new ImageHttpError(400, errMsg(e));
  }

  let result: GeneratedImage;
  try {
    result = await provider.generate(finalPrompt, referenceBytes);
  } catch (e) {
    const msg = errMsg(e);
    throw new ImageHttpError(imageErrorStatus(msg), msg);
  }

  let saved: SavedGenerated;
  try {
    saved = await saveGeneratedBytes(workspaceDir, result.data, result.mimeType);
  } catch (e) {
    throw new ImageHttpError(502, `Provider returned an invalid image: ${errMsg(e)}`);
  }

  // Persist the run (prompt, seed, asset) for the history view. Logging
  // must never fail the generation itself. Stored keys keep the Python
  // snake_case shape so existing images.json files stay compatible.
  try {
    const active = settings["active_image_endpoint"];
    await saveImageLog(workspaceDir, {
      timestamp: new Date().toISOString(),
      prompt,
      final_prompt: finalPrompt,
      style: input.style ?? null,
      provider: !active ? "openai-compatible" : String(active),
      reference_path: refPath,
      seed: result.seed ?? null,
      path: saved.path,
    });
  } catch {
    // Never fail the generation over logging.
  }

  // Backend never touches Markdown — it returns the asset path and the
  // editor inserts/swaps the reference. Seed is informational only
  // (ComfyUI mapped runs; cloud providers report null).
  return { path: saved.path, seed: result.seed ?? null, prompt: finalPrompt };
}
