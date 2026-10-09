/**
 * Workspace storage layer — TypeScript port of the Python workspace storage
 * stack for the TanStack Start server layer (Docker on Linux, Node 22).
 *
 * Uses only node:fs/promises, node:path, node:os, node:child_process
 * (execFile for git). No npm dependencies. All workspace-scoped functions
 * take an optional workspaceDir (absolute path); when omitted the active
 * workspace from settings is used (linked_workspace_dir when it exists and
 * is a directory, else defaultWorkspaceDir()).
 *
 * Python -> TS export mapping (mirrors, not verbatim copies):
 *   _migrate_image_endpoints      -> migrateImageEndpoints
 *   FileStorageService.get_settings    -> getSettings (+ defaultSettings)
 *   FileStorageService.update_settings -> updateSettings
 *   FileStorageService.load_settings    -> getActiveWorkspaceDir (resolve +
 *                                          ensure chapters/characters/styles/
 *                                          assets/outputs via ensureDataDirs)
 *   _is_subpath                   -> isSubpath
 *   FileStorageService._safe_resolve    -> resolveWorkspacePath
 *   FileStorageService._load_manifest   -> loadManifest (internal)
 *   FileStorageService.list_input_files -> listInputFiles
 *   FileStorageService.read_input_file  -> readWorkspaceFile
 *   FileStorageService.create_input_file-> createWorkspaceFile
 *   FileStorageService.update_input_file-> writeWorkspaceFile
 *   FileStorageService.delete_input_file-> deleteWorkspaceFile
 *   FileStorageService.rename_input_file-> renameWorkspaceFile
 *   FileStorageService.rename_folder    -> renameFolder
 *   FileStorageService.delete_folder    -> deleteFolder
 *   workspace._resolve_browse_dir +
 *     GET /api/workspace/browse        -> browseFolders
 *   _validate_workspace_name           -> validateWorkspaceName
 *   _resolve_workspace_create_target   -> resolveWorkspaceCreateTarget
 *   FileStorageService.create_workspace-> createWorkspace
 *   POST /api/workspace/link (+ _upsert_profile_entry,
 *     _resolve_profile_path)           -> linkWorkspace
 *   workspace_profiles settings reads  -> listProfiles
 *   POST /api/workspace/profiles       -> upsertProfile
 *   PATCH /api/workspace/profiles/{id} -> renameProfile
 *   DELETE /api/workspace/profiles/{id}-> deleteProfile
 *   is_git_available + GET /git-status -> gitStatus
 *   _init_git_repo + POST /git-init    -> gitInit
 *   GET /git-tracked (+ _own_git_dir,
 *     _resolve_existing_dir)           -> gitTracked
 *   DELETE /git                        -> gitRemove
 *   FileStorageService.get_workspace_stats
 *     (+ _parse_log_time, _is_manifest_file,
 *      get_image_logs)                 -> workspaceStats
 *   FileStorageService.save_media_bytes
 *     (+ _sniff_image_ext, _slugify_media_name,
 *      _media_resolve)                 -> saveMediaBuffer
 *   FileStorageService.read_media      -> readMedia
 *   FileStorageService (global singleton)-> storage
 *
 * Simplifications / deliberate deviations from the Python original:
 * - Async throughout (fs/promises only); Python is sync.
 * - Path errors say "Invalid path: ..." (spec-required) where Python says
 *   "Access denied"; media-scope errors keep Python's "Access denied".
 * - Hidden-path rejection checks only the workspace-relative portion, not
 *   the absolute root prefix (Python checks every absolute part, which
 *   would reject legitimate roots like ~/.margin).
 * - resolveWorkspacePath returns the lexically resolved absolute path after
 *   verifying symlink containment, instead of the fully realised path.
 * - browseFolders defaults a blank path to DATA_ROOT (Python defaults to
 *   the process cwd).
 * - createWorkspace defaults a missing parent_path to
 *   DATA_ROOT/workspaces (Python requires it) and inlines the three
 *   default style files (no sample-workspace copy source in this layer).
 * - Profile ids use Math.random hex (node:crypto is out of scope for the
 *   allowed imports); Python uses uuid4.
 * - workspaceStats adds a `total_bytes` key (sum of content file sizes);
 *   all other keys match get_workspace_stats exactly.
 * - saveMediaBuffer writes bytes directly (Python stages an upload temp
 *   file then moves it); save_media_file / save_generated_bytes have no
 *   direct export. Timestamps use whole seconds like Python's time.time().
 */

import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  DATA_ROOT,
  SETTINGS_PATH,
  defaultWorkspaceDir,
  ensureDataDirs,
} from './env.server.js';
import { CLIENT_ONLY_KEYS, CLIENT_SETTINGS_HEADER } from '../lib/settingsScope';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Settings = Record<string, unknown>;

export interface WorkspaceProfile {
  id: string;
  name: string;
  path: string;
}

export interface InputFileEntry {
  name: string;
  path: string;
  description: string;
}

export interface CreatedFile {
  name: string;
  path: string;
  content: string;
}

export interface RenamedEntry {
  name: string;
  path: string;
}

export interface GitInfo {
  initialized: boolean;
  committed: boolean;
  already_tracked: boolean;
  git_parent: string | null;
  git_unavailable: boolean;
  init_failed: boolean;
  error: string | null;
}

export interface GitAvailability {
  available: boolean;
  version: string | null;
}

export interface BrowseFolder {
  name: string;
  path: string;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  cwd: string;
  folders: BrowseFolder[];
}

export interface CreateWorkspaceOptions {
  name: string;
  parent_path?: string;
  init_git?: boolean;
}

export interface CreateWorkspaceResult {
  success: boolean;
  path: string;
  git: GitInfo;
}

export interface LinkWorkspaceOptions {
  name?: string;
  init_git?: boolean;
}

export interface ActivityDay {
  date: string;
  chats: number;
  images: number;
}

export interface WorkspaceStats {
  markdown_files: number;
  chat_sessions: number;
  prompt_tokens: number;
  completion_tokens: number;
  images_generated: number;
  last_activity: string | null;
  activity: ActivityDay[];
  total_bytes: number;
}

export interface MediaRef {
  name: string;
  path: string;
}

export interface MediaData {
  bytes: Uint8Array;
  mime: string;
}

// ---------------------------------------------------------------------------
// Constants (mirrors module-level Python names)
// ---------------------------------------------------------------------------

const LEGACY_IMAGE_KEYS: string[] = [
  'image_provider',
  'image_base_url',
  'image_api_key',
  'image_model',
];

const ALLOWED_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

const MANIFEST_LINE_RE =
  /^\s*-\s+(?:\*\*|)?([a-zA-Z0-9_.\-]+)(?:\*\*|)?\s*(?:[—–:\-]+)\s*(.+)/;

const FOLDER_NAME_RE = /^[a-z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function expandUser(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** Forward-slash relative path, safe on all platforms (mirrors _posix_rel). */
function posixRel(abs: string, base: string): string {
  return relative(base, abs).split(sep).join('/');
}

function randomHexId(): string {
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function existsDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function existsFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Settings (mirrors get_settings / update_settings / _migrate_image_endpoints)
// ---------------------------------------------------------------------------

/** One-time migration: legacy singleton image keys -> image_endpoints. */
export function migrateImageEndpoints(data: Record<string, unknown>): void {
  if ('image_endpoints' in data || 'active_image_endpoint' in data) {
    for (const k of LEGACY_IMAGE_KEYS) delete data[k];
    return;
  }
  const provider =
    String(data['image_provider'] ?? 'openai-compatible')
      .trim()
      .toLowerCase() || 'openai-compatible';
  const baseUrl = String(data['image_base_url'] ?? '').trim();
  const apiKey = String(data['image_api_key'] ?? '');
  const model = String(data['image_model'] ?? '').trim();
  if (
    provider === 'openai-compatible' &&
    !baseUrl &&
    !apiKey &&
    !model
  ) {
    data['image_endpoints'] = {};
    data['active_image_endpoint'] = null;
  } else {
    const entryId = provider.replace(/-/g, '_') || 'openai_compatible';
    data['image_endpoints'] = {
      [entryId]: {
        provider,
        base_url: baseUrl,
        api_key: apiKey,
        model,
      },
    };
    data['active_image_endpoint'] = entryId;
  }
  for (const k of LEGACY_IMAGE_KEYS) delete data[k];
}

/** Exact default keys from FileStorageService.get_settings. */
export function defaultSettings(): Settings {
  return {
    linked_workspace_dir: null,
    workspace_profiles: [],
    is_thinking: true,
    prepend_thinking_preamble: false,
    dialogue_density: 0.5,
    default_mode: 'edit',
    default_verbosity: 'balanced',
    show_thinking_by_default: false,
    pinned_ref_files: [],
    ignored_ref_files: [],
    endpoints: {},
    active_endpoint: null,
    default_harness: 'none',
    harnesses: {},
    theme: 'light',
    theme_family: 'sand',
    text_style: 'system',
    editor_stats: 'both',
    planner_include_outline: false,
    history_turns: 5,
    image_endpoints: {},
    active_image_endpoint: null,
    image_default_style: null,
    image_custom_styles: [],
    image_deleted_styles: [],
    image_style_overrides: {},
    image_comfy_text_workflow: null,
    image_comfy_text_prompt_map: null,
    image_comfy_text_seed_map: null,
    image_comfy_edit_workflow: null,
    image_comfy_edit_prompt_map: null,
    image_comfy_edit_image_map: null,
    image_comfy_edit_seed_map: null,
    image_comfy_negative_map: null,
  };
}

async function readSettingsFile(): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(SETTINGS_PATH, 'utf-8');
    const data: unknown = JSON.parse(raw);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function pickWorkspaceDirSync(
  linked: unknown,
  linkedIsDir: boolean,
): string {
  if (typeof linked === 'string' && linked && linkedIsDir) return linked;
  return defaultWorkspaceDir();
}

async function pickWorkspaceDir(settings: Settings): Promise<string> {
  const linked = settings['linked_workspace_dir'];
  let ok = false;
  if (typeof linked === 'string' && linked) {
    try {
      ok = (await stat(linked)).isDirectory();
    } catch {
      ok = false;
    }
  }
  const dir = pickWorkspaceDirSync(linked, ok);
  console.log(`Picked workspace directory: ${dir}`);
  ensureDataDirs(dir);
  return dir;
}

export async function getSettings(): Promise<Settings> {
  const settings = defaultSettings();
  const data = await readSettingsFile();
  if (data) {
    migrateImageEndpoints(data);
    for (const [k, v] of Object.entries(data)) {
      if (
        k !== 'context_mode' &&
        k !== 'context_threshold_pct' &&
        k !== 'updates' &&
        k !== 'update'
      ) {
        settings[k] = v;
      }
    }
  }
  await pickWorkspaceDir(settings);
  return settings;
}

function isPlainObjectRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Normalize a settings payload: unwrap a `{ updates: {...} }` /
 * `{ update: {...} }` envelope when present so a wrapped client body can
 * never persist a stray top-level `updates`/`update` key.
 */
function normalizeSettingsUpdates(
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const src = updates ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if ((k === 'updates' || k === 'update') && isPlainObjectRecord(v)) {
      for (const [ik, iv] of Object.entries(v)) out[ik] = iv;
    } else if (k !== 'updates' && k !== 'update') {
      out[k] = v;
    }
  }
  return out;
}

export async function updateSettings(
  updates: Record<string, unknown>,
): Promise<Settings> {
  const current = await getSettings();
  const merged: Settings = { ...current, ...normalizeSettingsUpdates(updates) };
  delete merged['context_mode'];
  delete merged['context_threshold_pct'];
  delete merged['updates'];
  delete merged['update'];
  for (const k of LEGACY_IMAGE_KEYS) delete merged[k];
  try {
    await mkdir(DATA_ROOT, { recursive: true });
    await writeFile(SETTINGS_PATH, JSON.stringify(merged, null, 2), 'utf-8');
    await pickWorkspaceDir(merged);
  } catch (e) {
    console.warn(`Failed to save settings: ${errMsg(e)}`);
  }
  return merged;
}

/** Active workspace dir (mirrors load_settings path resolution). */
export async function getActiveWorkspaceDir(): Promise<string> {
  const settings = await getSettings();
  const dir = await pickWorkspaceDir(settings);
  return dir;
}

// ---------------------------------------------------------------------------
// Per-client settings (localStorage-backed browsers vs shared settings.json)
// ---------------------------------------------------------------------------

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Not JSON (or a URI-encoded payload we try next).
  }
  return null;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Settings this client carries on the request: the `x-margin-client-settings`
 * header set by apiFetch, plus `linked_workspace_dir` from query strings
 * (`<img src>` can't send headers) and workspace payloads. Null for callers
 * that aren't a configured browser (scripts, tests, curl) — those keep
 * resolving everything from settings.json.
 */
export function clientSettingsFromRequest(
  request: Request,
  body?: Record<string, unknown>,
): Record<string, unknown> | null {
  let client: Record<string, unknown> | null = null;
  const header = request.headers.get(CLIENT_SETTINGS_HEADER);
  if (header) {
    const parsed =
      parseJsonObject(header) ?? parseJsonObject(safeDecodeURIComponent(header));
    if (parsed) client = parsed;
  }
  let query: URLSearchParams | null;
  try {
    query = new URL(request.url).searchParams;
  } catch {
    query = null;
  }
  if (query?.has('linked_workspace_dir')) {
    client = { ...(client ?? {}), linked_workspace_dir: query.get('linked_workspace_dir') };
  }
  if (body && 'linked_workspace_dir' in body) {
    client = { ...(client ?? {}), linked_workspace_dir: body.linked_workspace_dir };
  }
  return client;
}

/**
 * Effective settings for a request: settings.json overlaid with this
 * client's browser-owned keys. The allowlist means a client can only ever
 * steer its own workspace/appearance — never the shared blob.
 */
export async function requestSettings(
  request: Request,
  body?: Record<string, unknown>,
): Promise<Settings> {
  const base = await getSettings();
  const client = clientSettingsFromRequest(request, body);
  if (!client) return base;
  const settings: Settings = { ...base };
  for (const key of CLIENT_ONLY_KEYS) {
    if (key in client) settings[key] = client[key];
  }
  return settings;
}

/**
 * Workspace dir for a request: this client's selection wins (null/''/'sample'
 * = the default workspace, not whatever settings.json points at), while
 * callers without client settings keep the active dir from settings.json.
 */
export async function requestWorkspaceDir(
  request: Request,
  body?: Record<string, unknown>,
): Promise<string> {
  const client = clientSettingsFromRequest(request, body);
  if (!client) return getActiveWorkspaceDir();
  const raw = client.linked_workspace_dir;
  const linked = typeof raw === 'string' && raw.trim() !== 'sample' ? raw.trim() : '';
  return pickWorkspaceDir({ linked_workspace_dir: linked });
}

async function resolveWorkspace(workspaceDir?: string): Promise<string> {
  if (workspaceDir) {
    ensureDataDirs(workspaceDir);
    return workspaceDir;
  }
  const dir = await getActiveWorkspaceDir();
  return dir;
}

// ---------------------------------------------------------------------------
// Path safety (mirrors _is_subpath / _safe_resolve)
// ---------------------------------------------------------------------------

/** True when target == base or lies inside base (symlinks resolved). */
export async function isSubpath(
  target: string,
  base: string,
): Promise<boolean> {
  try {
    let t = target;
    let b = base;
    try {
      t = await realpath(target);
    } catch {
      t = resolve(target);
    }
    try {
      b = await realpath(base);
    } catch {
      b = resolve(base);
    }
    if (process.platform === 'win32' || process.platform === 'darwin') {
      t = t.toLowerCase();
      b = b.toLowerCase();
    }
    if (t === b) return true;
    const rel = relative(b, t);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/**
 * Resolve a workspace-relative posix path to an absolute path, rejecting
 * escapes (../, absolute paths, dot-parts, outputs/, symlink escapes).
 * A null/undefined/empty `rel` resolves to the workspace root itself.
 * Throws Error containing "Invalid path" on violation.
 */
export async function resolveWorkspacePath(
  workspaceDir: string,
  rel: string | null | undefined,
): Promise<string> {
  const root = resolve(workspaceDir);
  if (rel == null) return root;
  if (typeof rel !== 'string') throw new Error('Invalid path: empty path.');
  const cleaned = rel.replace(/\\/g, '/').trim();
  if (!cleaned) return root;
  if (
    cleaned.startsWith('/') ||
    posix.isAbsolute(cleaned) ||
    /^[A-Za-z]:\//.test(cleaned)
  ) {
    throw new Error(`Invalid path: absolute paths are not allowed: ${rel}`);
  }
  const full = resolve(root, cleaned);
  const relToRoot = relative(root, full);
  if (relToRoot === '' || relToRoot.startsWith('..') || isAbsolute(relToRoot)) {
    throw new Error(`Invalid path: escapes the workspace: ${rel}`);
  }
  const parts = relToRoot.split(sep);
  if (parts[0] === 'outputs') {
    throw new Error('Invalid path: outputs/ is not editable via this API.');
  }
  for (const part of parts) {
    if (part.startsWith('.')) {
      throw new Error(`Invalid path: hidden paths are not allowed: ${rel}`);
    }
  }
  try {
    const [realFull, realRoot] = await Promise.all([
      realpath(full),
      realpath(root),
    ]);
    const r = relative(realRoot, realFull);
    if (r.startsWith('..') || isAbsolute(r)) {
      throw new Error(
        `Invalid path: resolves outside the workspace: ${rel}`,
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('Invalid path')) throw e;
    // Target does not exist yet — lexical containment already verified.
  }
  return full;
}

// ---------------------------------------------------------------------------
// Manifests + file listing (mirrors _load_manifest / list_input_files)
// ---------------------------------------------------------------------------

async function loadManifest(manifestAbsPath: string): Promise<Record<string, string>> {
  let content: string;
  try {
    content = await readFile(manifestAbsPath, 'utf-8');
  } catch {
    return {};
  }
  const mapping: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const m = MANIFEST_LINE_RE.exec(line);
    if (m) {
      const name = (m[1] ?? '').trim();
      const desc = (m[2] ?? '').trim();
      if (!name) continue;
      mapping[name] = desc;
      if (name.toLowerCase().endsWith('.md')) {
        mapping[name.slice(0, -3)] = desc;
      } else {
        mapping[`${name}.md`] = desc;
      }
    }
  }
  return mapping;
}

async function collectMarkdownFiles(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectMarkdownFiles(full, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
}

export async function listInputFiles(
  workspaceDir?: string,
): Promise<InputFileEntry[]> {
  const ws = await resolveWorkspace(workspaceDir);
  const root = resolve(ws);
  const folders: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      !entry.name.startsWith('.') &&
      entry.name !== 'outputs'
    ) {
      folders.push(entry.name);
    }
  }

  const manifests = new Map<string, Record<string, string>>();
  for (const folder of folders) {
    const manifestPath = join(root, folder, `${folder.toUpperCase()}.md`);
    if (await existsFile(manifestPath)) {
      manifests.set(`${folder}/`, await loadManifest(manifestPath));
    }
  }

  const files: InputFileEntry[] = [];
  for (const folder of folders) {
    const found: string[] = [];
    await collectMarkdownFiles(join(root, folder), found);
    for (const abs of found) {
      const relPath = posixRel(abs, root);
      let desc = '';
      for (const [prefix, manifest] of manifests) {
        if (relPath.startsWith(prefix)) {
          desc = manifest[basename(abs)] ?? '';
          break;
        }
      }
      files.push({ name: basename(abs), path: relPath, description: desc });
    }
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      entry.name.toLowerCase().endsWith('.md') &&
      !entry.name.startsWith('.')
    ) {
      files.push({ name: entry.name, path: entry.name, description: '' });
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

// ---------------------------------------------------------------------------
// Workspace files (mirrors read/create/update/delete/rename_input_file,
// rename_folder, delete_folder)
// ---------------------------------------------------------------------------

export async function readWorkspaceFile(
  relPath: string,
  workspaceDir?: string,
): Promise<string> {
  const ws = await resolveWorkspace(workspaceDir);
  const full = await resolveWorkspacePath(ws, relPath);
  if (!(await existsFile(full))) {
    throw new Error(`File not found: ${relPath}`);
  }
  return readFile(full, 'utf-8');
}

export async function createWorkspaceFile(
  folder: string,
  name: string,
  content = '',
  workspaceDir?: string,
): Promise<CreatedFile> {
  const ws = await resolveWorkspace(workspaceDir);
  const root = resolve(ws);
  const cleanFolder = (folder ?? '').replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '');

  // Empty folder == workspace root, which is a valid location.
  if (
    cleanFolder.startsWith('.') ||
    cleanFolder.split('/').includes('..') ||
    cleanFolder.split('/')[0] === 'outputs'
  ) {
    throw new Error('Invalid folder name');
  }

  let cleanName = (name ?? '').trim();
  if (!cleanName) throw new Error('File name is required');
  if (!cleanName.toLowerCase().endsWith('.md')) cleanName = `${cleanName}.md`;
  if (
    cleanName.includes('/') ||
    cleanName.includes('\\') ||
    cleanName.startsWith('.') ||
    cleanName.includes('..')
  ) {
    throw new Error('Invalid file name');
  }

  const targetDir = cleanFolder ? resolve(root, cleanFolder) : root;
  const backToRoot = relative(root, targetDir);
  if (backToRoot.startsWith('..') || isAbsolute(backToRoot)) {
    throw new Error('Invalid path: escapes the workspace.');
  }
  await mkdir(targetDir, { recursive: true });
  const targetPath = join(targetDir, cleanName);
  if (await existsFile(targetPath)) {
    throw new Error(
      `File already exists: ${cleanFolder ? `${cleanFolder}/` : ''}${cleanName}`,
    );
  }
  try {
    if ((await stat(targetPath)).isDirectory()) {
      throw new Error(
        `File already exists: ${cleanFolder ? `${cleanFolder}/` : ''}${cleanName}`,
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('File already exists')) {
      throw e;
    }
  }

  const body = content ?? '';
  await writeFile(targetPath, body, 'utf-8');
  const relPath = cleanFolder ? `${cleanFolder}/${cleanName}` : cleanName;
  return { name: cleanName, path: relPath, content: body };
}

export async function writeWorkspaceFile(
  relPath: string,
  content: string,
  workspaceDir?: string,
): Promise<boolean> {
  const ws = await resolveWorkspace(workspaceDir);
  const full = await resolveWorkspacePath(ws, relPath);
  if (!(await existsFile(full))) {
    throw new Error(`File not found: ${relPath}`);
  }
  await writeFile(full, content ?? '', 'utf-8');
  return true;
}

export async function deleteWorkspaceFile(
  relPath: string,
  workspaceDir?: string,
): Promise<boolean> {
  const ws = await resolveWorkspace(workspaceDir);
  const full = await resolveWorkspacePath(ws, relPath);
  if (!(await existsFile(full))) {
    throw new Error(`File not found: ${relPath}`);
  }
  if (!full.toLowerCase().endsWith('.md')) {
    throw new Error('Only markdown files can be deleted via this endpoint');
  }
  await rm(full);
  return true;
}

export async function renameWorkspaceFile(
  relPath: string,
  newName: string,
  workspaceDir?: string,
): Promise<RenamedEntry> {
  const ws = await resolveWorkspace(workspaceDir);
  const root = resolve(ws);
  const oldAbs = await resolveWorkspacePath(ws, relPath);
  if (!(await existsFile(oldAbs))) {
    throw new Error(`File not found: ${relPath}`);
  }
  if (!oldAbs.toLowerCase().endsWith('.md')) {
    throw new Error('Only markdown files can be renamed via this endpoint');
  }

  let clean = (newName ?? '').trim();
  if (!clean) throw new Error('New file name is required');
  if (!clean.toLowerCase().endsWith('.md')) clean = `${clean}.md`;
  if (
    clean.includes('/') ||
    clean.includes('\\') ||
    clean.startsWith('.')
  ) {
    throw new Error('Invalid file name');
  }
  if (clean === basename(oldAbs)) {
    return { name: basename(oldAbs), path: posixRel(oldAbs, root) };
  }
  const newAbs = join(dirname(oldAbs), clean);
  if (await existsFile(newAbs)) {
    throw new Error(`File already exists: ${posixRel(newAbs, root)}`);
  }
  await rename(oldAbs, newAbs);
  return { name: clean, path: posixRel(newAbs, root) };
}

export async function renameFolder(
  relPath: string,
  newName: string,
  workspaceDir?: string,
): Promise<RenamedEntry> {
  const ws = await resolveWorkspace(workspaceDir);
  const root = resolve(ws);
  const oldAbs = await resolveWorkspacePath(ws, relPath);
  if (relative(root, oldAbs) === '') {
    throw new Error('Invalid path: cannot rename workspace root.');
  }
  if (!(await existsDir(oldAbs))) {
    throw new Error(`Folder not found: ${relPath}`);
  }

  const clean = (newName ?? '').trim().toLowerCase().replace(/ /g, '_');
  if (!clean) throw new Error('New folder name is required');
  if (
    clean.includes('/') ||
    clean.includes('\\') ||
    clean.startsWith('.') ||
    clean.includes('..')
  ) {
    throw new Error('Invalid folder name');
  }
  if (!FOLDER_NAME_RE.test(clean)) throw new Error('Invalid folder name');
  if (clean === basename(oldAbs)) {
    return { name: basename(oldAbs), path: posixRel(oldAbs, root) };
  }
  const newAbs = join(dirname(oldAbs), clean);
  if (await existsDir(newAbs)) {
    throw new Error(`Folder already exists: ${posixRel(newAbs, root)}`);
  }
  await rename(oldAbs, newAbs);
  return { name: clean, path: posixRel(newAbs, root) };
}

export async function deleteFolder(
  relPath: string,
  workspaceDir?: string,
): Promise<boolean> {
  const ws = await resolveWorkspace(workspaceDir);
  const full = await resolveWorkspacePath(ws, relPath);
  if (relative(resolve(ws), full) === '') {
    throw new Error('Invalid path: cannot delete workspace root.');
  }
  if (!(await existsDir(full))) {
    throw new Error(`Folder not found: ${relPath}`);
  }
  await rm(full, { recursive: true });
  return true;
}

// ---------------------------------------------------------------------------
// Browse (mirrors _resolve_browse_dir + GET /browse)
// ---------------------------------------------------------------------------

function getSensitivePathPrefixes(): string[] {
  const home = homedir();
  const prefixes: string[] = [
    join(home, '.ssh'),
    join(home, '.gnupg'),
    join(home, '.aws'),
    join(home, '.config'),
    join(home, '.local'),
  ];
  if (process.platform === 'win32') {
    for (const v of [
      'SystemRoot',
      'ProgramFiles',
      'ProgramData',
      'windir',
    ]) {
      const val = process.env[v];
      if (val) prefixes.push(val);
    }
    prefixes.push('C:/Windows', 'C:/Program Files', 'C:/ProgramData');
  } else if (process.platform === 'darwin') {
    prefixes.push(
      '/System',
      '/Library',
      '/usr',
      '/etc',
      '/bin',
      '/sbin',
      '/private/etc',
      '/var/log',
      '/var/lib',
      '/var/root',
      '/var/db',
      '/var/run',
    );
  } else {
    prefixes.push(
      '/etc',
      '/usr',
      '/bin',
      '/sbin',
      '/boot',
      '/root',
      '/sys',
      '/proc',
      '/dev',
      '/var/log',
      '/var/lib',
      '/var/root',
      '/var/db',
      '/var/run',
    );
  }
  return prefixes;
}

export async function browseFolders(path = ''): Promise<BrowseResult> {
  const raw = (path ?? '').trim();
  let resolved: string;
  if (!raw) {
    resolved = resolve(DATA_ROOT);
  } else {
    const candidate = expandUser(raw);
    if (!isAbsolute(candidate)) {
      throw new Error('Path must be absolute.');
    }
    try {
      resolved = await realpath(candidate);
    } catch {
      try {
        resolved = resolve(candidate);
      } catch {
        throw new Error('Invalid path.');
      }
    }
    if (!(await existsDir(resolved))) {
      throw new Error('Directory does not exist.');
    }
    for (const blocked of getSensitivePathPrefixes()) {
      let blockedResolved: string;
      try {
        blockedResolved = await realpath(expandUser(blocked));
      } catch {
        try {
          blockedResolved = resolve(expandUser(blocked));
        } catch {
          continue;
        }
      }
      if (await isSubpath(resolved, blockedResolved)) {
        throw new Error('The selected path is not allowed.');
      }
    }
  }

  let entries;
  try {
    entries = await readdir(resolved, { withFileTypes: true });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error('Permission denied reading this directory.');
    }
    throw e;
  }
  const folders = entries
    .filter((c) => c.isDirectory())
    .sort((a, b) =>
      a.name.toLowerCase() < b.name.toLowerCase()
        ? -1
        : a.name.toLowerCase() > b.name.toLowerCase()
          ? 1
          : 0,
    )
    .map((c) => ({ name: c.name, path: join(resolved, c.name) }));
  const parent = dirname(resolved) !== resolved ? dirname(resolved) : null;
  return {
    path: resolved,
    parent,
    cwd: resolve(process.cwd()),
    folders,
  };
}

// ---------------------------------------------------------------------------
// Git (mirrors is_git_available / _init_git_repo / git endpoints)
// ---------------------------------------------------------------------------

function runGit(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs },
      (
        error: unknown,
        stdout: string | Buffer,
        stderr: string | Buffer,
      ) => {
        const code =
          typeof (error as { code?: unknown } | null)?.code === 'number'
            ? ((error as { code: number }).code as number)
            : error
              ? 1
              : 0;
        res({
          code,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      },
    );
  });
}

/** Mirrors is_git_available (+ GET /git-status). */
export async function gitStatus(): Promise<GitAvailability> {
  try {
    const r = await runGit(['--version'], process.cwd(), 5000);
    if (r.code === 0 && r.stdout.trim()) {
      return { available: true, version: r.stdout.trim() };
    }
  } catch {
    // fall through to unavailable
  }
  return { available: false, version: null };
}

function freshGitInfo(): GitInfo {
  return {
    initialized: false,
    committed: false,
    already_tracked: false,
    git_parent: null,
    git_unavailable: false,
    init_failed: false,
    error: null,
  };
}

async function initGitRepo(pathObj: string): Promise<GitInfo> {
  const gitInfo = freshGitInfo();
  const check = await gitStatus();
  if (!check.available) {
    gitInfo.git_unavailable = true;
    gitInfo.error = 'Git is not installed or not available in PATH.';
    return gitInfo;
  }

  try {
    const top = await runGit(['rev-parse', '--show-toplevel'], pathObj, 5000);
    if (top.code === 0) {
      gitInfo.already_tracked = true;
      gitInfo.git_parent = top.stdout.trim();
      return gitInfo;
    }
  } catch {
    // rev-parse failed -> fresh directory, safe to init
  }

  await writeFile(
    join(pathObj, '.gitignore'),
    'outputs/\n.DS_Store\nThumbs.db\n*.tmp\n*.log\n',
    'utf-8',
  );
  const init = await runGit(['init'], pathObj, 10000);
  if (init.code !== 0) {
    gitInfo.init_failed = true;
    gitInfo.error = 'git init failed.';
    return gitInfo;
  }
  gitInfo.initialized = true;

  try {
    const add = await runGit(['add', '.'], pathObj, 10000);
    if (add.code !== 0) {
      gitInfo.committed = false;
      gitInfo.error = 'git add/commit failed.';
      return gitInfo;
    }
    const commit = await runGit(
      ['commit', '-m', 'Initial workspace scaffold'],
      pathObj,
      10000,
    );
    if (commit.code === 0) {
      gitInfo.committed = true;
    } else {
      gitInfo.committed = false;
      const stderr = commit.stderr.trim();
      gitInfo.error = /user/i.test(stderr)
        ? 'Initial commit failed — Git user identity not configured. ' +
          'Run: git config --global user.name / user.email'
        : 'Initial commit failed.';
    }
  } catch {
    gitInfo.committed = false;
    gitInfo.error = 'git add/commit failed.';
  }
  return gitInfo;
}

/** Shared absolute-existing-directory validation (mirrors _resolve_existing_dir). */
async function resolveExistingDir(raw: string | null | undefined): Promise<string> {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw new Error('Workspace path is required.');
  const expanded = expandUser(trimmed);
  if (!isAbsolute(expanded)) {
    throw new Error('Workspace path must be absolute.');
  }
  let resolved: string;
  try {
    try {
      resolved = await realpath(expanded);
    } catch {
      resolved = resolve(expanded);
    }
  } catch {
    throw new Error('Invalid workspace path.');
  }
  if (!(await existsDir(resolved))) {
    throw new Error('The selected directory does not exist.');
  }
  return resolved;
}

/** Mirrors POST /git-init. Never throws for expected git outcomes. */
export async function gitInit(
  path: string,
): Promise<{ success: boolean; path: string; git: GitInfo }> {
  const resolved = await resolveExistingDir(path);
  const git = await initGitRepo(resolved);
  return { success: true, path: resolved, git };
}

/** Mirrors GET /git-tracked. "Not a repo" is a normal answer, never an error. */
export async function gitTracked(
  path: string,
): Promise<{ tracked: boolean }> {
  const resolved = await resolveExistingDir(path);
  return { tracked: await existsDir(join(resolved, '.git')) };
}

/** Mirrors DELETE /git: remove <path>/.git (history lost, files kept). */
export async function gitRemove(
  path: string,
): Promise<{ success: boolean; path: string }> {
  const resolved = await resolveExistingDir(path);
  const gitDir = join(resolved, '.git');
  if (!(await existsDir(gitDir))) {
    throw new Error('No Git repository in this folder.');
  }
  try {
    await rm(gitDir, { recursive: true });
  } catch (e) {
    throw new Error(`Could not remove the Git repository: ${errMsg(e)}`);
  }
  return { success: true, path: resolved };
}

// ---------------------------------------------------------------------------
// Workspaces + profiles (mirrors create_workspace, /link, /profiles)
// ---------------------------------------------------------------------------

export function validateWorkspaceName(name: string): string {
  const cleaned = (name ?? '').trim();
  if (!cleaned) throw new Error('Workspace name is required.');
  if (
    cleaned === '.' ||
    cleaned === '..' ||
    cleaned.includes('/') ||
    cleaned.includes('\\') ||
    cleaned.startsWith('.')
  ) {
    throw new Error(
      'Workspace name must be a single folder name without path separators.',
    );
  }
  return cleaned;
}

export async function resolveWorkspaceCreateTarget(
  parentPath: string,
  name: string,
): Promise<string> {
  const rawParent = (parentPath ?? '').trim();
  if (!rawParent) throw new Error('Parent workspace path is required.');
  const parentInput = expandUser(rawParent);
  if (!isAbsolute(parentInput)) {
    throw new Error('Parent workspace path must be absolute.');
  }
  let parentResolved: string;
  try {
    try {
      parentResolved = await realpath(parentInput);
    } catch {
      parentResolved = resolve(parentInput);
    }
  } catch {
    throw new Error('Invalid parent workspace path.');
  }

  const target = resolve(parentResolved, validateWorkspaceName(name));
  if (target.split(sep).some((part) => part.startsWith('.'))) {
    throw new Error('The selected path is not allowed as a workspace location.');
  }
  for (const blocked of getSensitivePathPrefixes()) {
    let blockedResolved: string;
    try {
      blockedResolved = await realpath(expandUser(blocked));
    } catch {
      try {
        blockedResolved = resolve(expandUser(blocked));
      } catch {
        continue;
      }
    }
    if (await isSubpath(target, blockedResolved)) {
      throw new Error(
        'The selected path is not allowed as a workspace location.',
      );
    }
  }

  let homeResolved = homedir();
  try {
    homeResolved = await realpath(homedir());
  } catch {
    homeResolved = resolve(homedir());
  }
  if (dirname(target) === target || target === homeResolved) {
    throw new Error(
      'Root directories and home directory root cannot be used as a workspace.',
    );
  }
  if (!(await existsDir(parentResolved))) {
    throw new Error('The selected parent directory does not exist.');
  }

  let targetStat: Awaited<ReturnType<typeof stat>> | null = null;
  try {
    targetStat = await stat(target);
  } catch {
    targetStat = null;
  }
  if (targetStat) {
    if (targetStat.isDirectory()) {
      throw new Error('Workspace path must not exist.');
    }
  }
  return target;
}

const DEFAULT_GENERAL_STYLE = `## Writer Guidelines

- Write clear, engaging prose
- Balance narration, action, and character reaction
- Maintain consistent voice and pacing
- Use natural paragraph breaks for scene shifts

## Narration Guidelines

- Ground the scene physically before any emotional interiority
- Use concrete, sensory detail — what characters see, hear, and feel
- Keep action beats tight; one action per sentence for tension
- Use character interiority sparingly: one key internal reaction per beat

## Dialogue Guidelines

- Characters speak in declarations, not questions
- Dialogue builds toward a rallying cry or turning point
- Use callbacks to earlier self-doubt for emotional payoff
- One character inspires; the other resists before yielding
- Short exchanges for tension, longer speeches for catharsis
`;

const DEFAULT_CINEMATIC_STYLE = `## Narration Guidelines

- Paint the environment with sensory detail — sight, sound, smell, texture
- Use weather and light to mirror emotional subtext
- Keep narration tight during dialogue, expansive during action beats
- Camera moves like a film: wide shot → close-up on detail → reaction

## Dialogue Guidelines

- Characters speak in distinct rhythms — no two voices sound the same
- Subtext over exposition; what they don't say matters more
- Interruptions and pauses for realism
- Power shifts mid-conversation (one character starts strong, ends defensive)

## Writer Guidelines

- Weave narration and dialogue into a seamless rhythm
- Use paragraph breaks to control pacing — short paragraphs for tension
- End each beat on a hook, image, or unresolved question
- Match prose density to emotional intensity
`;

const DEFAULT_SUPERMAN_STYLE = `## Tone & Atmosphere

- Mythic, larger-than-life, soaring and earnest
- Unapologetic heroism and moral clarity under extreme pressure
- Contrast intimate human vulnerability against epic stakes

## Narration Guidelines

- Kinetic, sensory-rich descriptions of scale and momentum
- Focus on sensory impact: sound of wind, blinding light, physical resonance
- Ground extraordinary feats in physical toll and resolve

## Dialogue Guidelines

- Resonant, direct, and principled
- Speech inspires hope and resolve in others
- Quiet convictions delivered with calm certainty
`;

async function writeIfMissing(abs: string, content: string): Promise<void> {
  if (await existsFile(abs)) return;
  await writeFile(abs, content, 'utf-8');
}

/** Mirrors FileStorageService.create_workspace (scaffold + optional git). */
export async function createWorkspace(
  opts: CreateWorkspaceOptions,
): Promise<CreateWorkspaceResult> {
  const parent =
    (opts.parent_path ?? '').trim() || join(DATA_ROOT, 'workspaces');
  await mkdir(resolve(expandUser(parent)), { recursive: true });
  const target = await resolveWorkspaceCreateTarget(parent, opts.name);

  await mkdir(target, { recursive: true });
  for (const sub of [
    'chapters',
    'characters',
    'styles',
    'prompts',
    'outputs',
    'assets',
  ]) {
    await mkdir(join(target, sub), { recursive: true });
  }

  await writeIfMissing(
    join(target, 'chapters', 'CHAPTERS.md'),
    '- chapter-1.md — Chapter 1: Introduction. Opening scene.\n',
  );
  await writeIfMissing(
    join(target, 'chapters', 'chapter-1.md'),
    '# Chapter 1\n\nBegin drafting your opening chapter here.\n',
  );
  await writeIfMissing(
    join(target, 'characters', 'CHARACTERS.md'),
    '- protagonist.md — Protagonist: Main character overview and motivations.\n',
  );
  await writeIfMissing(
    join(target, 'characters', 'protagonist.md'),
    '# Protagonist\n\n## Overview\nMain character description, background, and motivation.\n\n## Key Traits\n- **Goal:** Core driving objective.\n- **Conflict:** Internal and external obstacles.\n',
  );
  await writeIfMissing(
    join(target, 'styles', 'STYLES.md'),
    '- general — General-purpose scene writing with balanced narration and action\n' +
      '- cinematic — Full cinematic scene — narration sets the atmosphere, dialogue drives the conflict\n' +
      '- superman — Heroic, inspirational tone — characters rising to meet impossible odds with dramatic, cinematic prose\n',
  );
  await writeIfMissing(
    join(target, 'styles', 'general.md'),
    DEFAULT_GENERAL_STYLE,
  );
  await writeIfMissing(
    join(target, 'styles', 'cinematic.md'),
    DEFAULT_CINEMATIC_STYLE,
  );
  await writeIfMissing(
    join(target, 'styles', 'superman.md'),
    DEFAULT_SUPERMAN_STYLE,
  );
  await writeIfMissing(
    join(target, 'story_state.yaml'),
    '# Story State & Continuity Tracking\n' +
      'current_chapter: "chapter-1.md"\n' +
      'timeline: []\n' +
      'key_items: []\n' +
      'notes: "Project workspace initialized."\n',
  );

  const git = opts.init_git ? await initGitRepo(target) : freshGitInfo();
  return { success: true, path: target, git };
}

// --- profiles (mirrors _upsert_profile_entry + /profiles + /link) ---

function readProfiles(settings: Settings): WorkspaceProfile[] {
  const raw = settings['workspace_profiles'];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p): p is WorkspaceProfile =>
      typeof p === 'object' &&
      p !== null &&
      typeof (p as WorkspaceProfile).path === 'string',
  );
}

function upsertProfileEntry(
  profiles: WorkspaceProfile[],
  key: string,
  name: string,
): { profiles: WorkspaceProfile[]; profile: WorkspaceProfile } {
  const existing = profiles.find((p) => p.path === key);
  if (existing) {
    existing.name = name;
    return {
      profiles: [existing, ...profiles.filter((p) => p !== existing)],
      profile: existing,
    };
  }
  const profile: WorkspaceProfile = { id: randomHexId(), name, path: key };
  return { profiles: [profile, ...profiles], profile };
}

export async function listProfiles(): Promise<WorkspaceProfile[]> {
  return readProfiles(await getSettings());
}

export async function upsertProfile(
  path: string,
  name?: string,
): Promise<{
  success: boolean;
  profiles: WorkspaceProfile[];
  profile: WorkspaceProfile;
}> {
  const trimmed = (path ?? '').trim();
  if (!trimmed) throw new Error('Workspace path is required.');
  const expanded = expandUser(trimmed);
  if (!isAbsolute(expanded)) {
    throw new Error('Workspace path must be absolute.');
  }
  let resolved: string;
  try {
    try {
      resolved = await realpath(expanded);
    } catch {
      resolved = resolve(expanded);
    }
  } catch {
    throw new Error('Invalid workspace path.');
  }
  if (!(await existsDir(resolved))) {
    throw new Error('The selected directory does not exist.');
  }
  const profileName = (name ?? '').trim() || basename(resolved);
  const settings = await getSettings();
  const { profiles, profile } = upsertProfileEntry(
    readProfiles(settings),
    resolved,
    profileName,
  );
  await updateSettings({ workspace_profiles: profiles });
  return { success: true, profiles, profile };
}

/** Mirrors POST /link: link dir + record profile (+ optional git) atomically. */
export async function linkWorkspace(
  path: string,
  opts: LinkWorkspaceOptions = {},
): Promise<{
  success: boolean;
  linked_workspace_dir: unknown;
  profiles: WorkspaceProfile[];
  profile: WorkspaceProfile;
  git: GitInfo;
  git_requested: boolean;
}> {
  const trimmed = (path ?? '').trim();
  if (!trimmed) throw new Error('Workspace path is required.');
  const expanded = expandUser(trimmed);
  if (!isAbsolute(expanded)) {
    throw new Error('Workspace path must be absolute.');
  }
  let resolved: string;
  try {
    try {
      resolved = await realpath(expanded);
    } catch {
      resolved = resolve(expanded);
    }
  } catch {
    throw new Error('Invalid workspace path.');
  }
  if (!(await existsDir(resolved))) {
    throw new Error('The selected directory does not exist.');
  }

  const git = opts.init_git ? await initGitRepo(resolved) : freshGitInfo();
  const profileName = (opts.name ?? '').trim() || basename(resolved);
  const settings = await getSettings();
  const { profiles, profile } = upsertProfileEntry(
    readProfiles(settings),
    resolved,
    profileName,
  );
  const merged = await updateSettings({
    linked_workspace_dir: resolved,
    workspace_profiles: profiles,
  });
  return {
    success: true,
    linked_workspace_dir: merged['linked_workspace_dir'],
    profiles,
    profile,
    git,
    git_requested: Boolean(opts.init_git),
  };
}

export async function renameProfile(
  profileId: string,
  name: string,
): Promise<{
  success: boolean;
  profiles: WorkspaceProfile[];
  profile: WorkspaceProfile;
}> {
  const clean = (name ?? '').trim();
  if (!clean) throw new Error('Profile name is required.');
  const settings = await getSettings();
  const profiles = readProfiles(settings);
  const target = profiles.find((p) => p.id === profileId);
  if (!target) throw new Error('Profile not found.');
  target.name = clean;
  await updateSettings({ workspace_profiles: profiles });
  return { success: true, profiles, profile: target };
}

export async function deleteProfile(
  profileId: string,
  mode: 'forget' | 'delete' = 'forget',
): Promise<{
  success: boolean;
  profiles: WorkspaceProfile[];
  linked_workspace_dir: unknown;
  dir_removed: boolean;
}> {
  if (mode !== 'forget' && mode !== 'delete') {
    throw new Error("mode must be 'forget' or 'delete'.");
  }
  const settings = await getSettings();
  const profiles = readProfiles(settings);
  const removed = profiles.find((p) => p.id === profileId);
  if (!removed) throw new Error('Profile not found.');
  const kept = profiles.filter((p) => p.id !== profileId);

  let dirRemoved = false;
  if (mode === 'delete') {
    let target: string;
    try {
      try {
        target = await realpath(expandUser(String(removed.path)));
      } catch {
        target = resolve(expandUser(String(removed.path)));
      }
    } catch {
      throw new Error('Invalid workspace path.');
    }
    if (!(await existsDir(target))) {
      throw new Error('The workspace directory does not exist.');
    }
    if (target.split(sep).some((part) => part.startsWith('.'))) {
      throw new Error('The selected path is not allowed.');
    }
    for (const blocked of getSensitivePathPrefixes()) {
      let blockedResolved: string;
      try {
        blockedResolved = await realpath(expandUser(blocked));
      } catch {
        try {
          blockedResolved = resolve(expandUser(blocked));
        } catch {
          continue;
        }
      }
      if (await isSubpath(target, blockedResolved)) {
        throw new Error('The selected path is not allowed.');
      }
    }
    try {
      await rm(target, { recursive: true });
      dirRemoved = true;
    } catch {
      throw new Error('Failed to delete the workspace directory.');
    }
  }

  const updates: Record<string, unknown> = { workspace_profiles: kept };
  const current = settings['linked_workspace_dir'];
  if (typeof current === 'string' && current) {
    let currentResolved = current;
    try {
      currentResolved = await realpath(expandUser(current));
    } catch {
      currentResolved = current;
    }
    if (currentResolved === String(removed.path)) {
      updates['linked_workspace_dir'] = null;
    }
  }
  const merged = await updateSettings(updates);
  return {
    success: true,
    profiles: kept,
    linked_workspace_dir: merged['linked_workspace_dir'],
    dir_removed: dirRemoved,
  };
}

// ---------------------------------------------------------------------------
// Media (mirrors save_media_bytes/_sniff_image_ext/_slugify_media_name,
// _media_resolve/read_media)
// ---------------------------------------------------------------------------

function bytesStartWith(head: Uint8Array, sig: number[]): boolean {
  if (head.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (head[i] !== sig[i]) return false;
  }
  return true;
}

/** Magic-byte sniff (mirrors _sniff_image_ext). WEBP is RIFF....WEBP. */
export function sniffImageExt(head: Uint8Array): string | null {
  if (bytesStartWith(head, [0x89, 0x50, 0x4e, 0x47])) return 'png';
  if (bytesStartWith(head, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (
    bytesStartWith(head, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    bytesStartWith(head, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return 'gif';
  }
  if (
    bytesStartWith(head, [0x52, 0x49, 0x46, 0x46]) &&
    head.length >= 12 &&
    head[8] === 0x57 &&
    head[9] === 0x45 &&
    head[10] === 0x42 &&
    head[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
}

/** Filesystem-safe stem (mirrors _slugify_media_name). */
export function slugifyMediaName(name: string): string {
  const noDirs = (name ?? '').split('/').pop()?.split('\\').pop() ?? '';
  const stem = noDirs.includes('.')
    ? noDirs.slice(0, noDirs.lastIndexOf('.'))
    : noDirs;
  const slug = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, 60) || 'image';
}

async function mediaDir(workspaceDir: string): Promise<string> {
  const d = join(resolve(workspaceDir), 'assets');
  await mkdir(d, { recursive: true });
  return d;
}

/** Strictly resolve a path inside workspace/assets/ (mirrors _media_resolve). */
async function mediaResolve(
  workspaceDir: string,
  relPath: string,
): Promise<string> {
  const dir = await mediaDir(workspaceDir);
  const dirResolved = resolve(dir);
  let cleaned = (relPath ?? '').replace(/\\/g, '/').trim();
  if (cleaned.startsWith('assets/')) cleaned = cleaned.slice('assets/'.length);
  if (
    !cleaned ||
    cleaned.startsWith('.') ||
    cleaned.startsWith('/') ||
    cleaned.split('/').includes('..')
  ) {
    throw new Error('Access denied');
  }
  const full = resolve(dirResolved, cleaned);
  const back = relative(dirResolved, full);
  if (back === '' || back.startsWith('..') || isAbsolute(back)) {
    throw new Error('Access denied');
  }
  return full;
}

export async function saveMediaBuffer(
  filename: string,
  bytes: Uint8Array,
  mime?: string,
  workspaceDir?: string,
): Promise<MediaRef> {
  void mime;
  const ws = await resolveWorkspace(workspaceDir);
  const dir = await mediaDir(ws);
  if (!bytes || bytes.length === 0) throw new Error('Empty file');
  const sniffed = sniffImageExt(bytes.subarray(0, 12));
  if (sniffed === null || !ALLOWED_IMAGE_EXTS.has(sniffed)) {
    throw new Error('Not a supported image (png, jpg, webp, gif)');
  }
  // Trust magic bytes over the claimed name/type; normalize jpeg->jpg.
  const ext = sniffed === 'jpeg' ? 'jpg' : sniffed;
  const fname = `${slugifyMediaName(filename)}-${Math.floor(Date.now() / 1000)}.${ext}`;
  await writeFile(join(dir, fname), bytes);
  return { name: fname, path: `assets/${fname}` };
}

export async function readMedia(
  relPath: string,
  workspaceDir?: string,
): Promise<MediaData> {
  const ws = await resolveWorkspace(workspaceDir);
  const full = await mediaResolve(ws, relPath);
  if (!(await existsFile(full))) {
    throw new Error(`Media not found: ${relPath}`);
  }
  const ext = full
    .slice(full.lastIndexOf('.') + 1)
    .toLowerCase();
  const bytes = await readFile(full);
  return { bytes, mime: EXT_TO_MIME[ext] ?? 'application/octet-stream' };
}

// ---------------------------------------------------------------------------
// Stats (mirrors get_workspace_stats + _parse_log_time + _is_manifest_file)
// ---------------------------------------------------------------------------

function parseLogTime(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Scaffold manifests (chapters/CHAPTERS.md) don't count as content. */
function isManifestFile(relPosixPath: string): boolean {
  const segments = relPosixPath.split('/');
  if (segments.length < 2) return false;
  const file = segments[segments.length - 1] ?? '';
  const parent = segments[segments.length - 2] ?? '';
  if (!file.toLowerCase().endsWith('.md') || !parent) return false;
  return file.slice(0, -3).toUpperCase() === parent.toUpperCase();
}

interface DayBuckets {
  chatDays: Map<string, number>;
  imageDays: Map<string, number>;
}

async function collectChatLogStats(
  outputsDir: string,
  buckets: DayBuckets,
): Promise<{
  chatSessions: number;
  promptTokens: number;
  completionTokens: number;
  latest: Date | null;
}> {
  let chatSessions = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let latest: Date | null = null;
  const logsDir = join(outputsDir, 'ai_logs');
  let sessionFiles: string[] = [];
  try {
    sessionFiles = (await readdir(logsDir)).filter((f) =>
      f.toLowerCase().endsWith('.json'),
    );
  } catch {
    return { chatSessions, promptTokens, completionTokens, latest };
  }
  for (const file of sessionFiles) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(logsDir, file), 'utf-8'));
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    chatSessions += 1;
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const p = Number(rec['prompt_tokens'] ?? 0);
      const c = Number(rec['completion_tokens'] ?? 0);
      if (Number.isFinite(p)) promptTokens += Math.trunc(p);
      if (Number.isFinite(c)) completionTokens += Math.trunc(c);
      const stamped = parseLogTime(rec['timestamp']);
      if (stamped) {
        const day = stamped.toISOString().slice(0, 10);
        buckets.chatDays.set(day, (buckets.chatDays.get(day) ?? 0) + 1);
        if (!latest || stamped > latest) latest = stamped;
      }
    }
  }
  return { chatSessions, promptTokens, completionTokens, latest };
}

async function collectImageLogStats(
  outputsDir: string,
  buckets: DayBuckets,
): Promise<{ count: number; latest: Date | null }> {
  const path = join(outputsDir, 'image_logs', 'images.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return { count: 0, latest: null };
  }
  const logs = Array.isArray(parsed) ? parsed : [];
  logs.sort((a, b) =>
    String((a as Record<string, unknown>)?.['timestamp'] ?? '') <
    String((b as Record<string, unknown>)?.['timestamp'] ?? '')
      ? -1
      : 1,
  );
  let latest: Date | null = null;
  for (const entry of logs) {
    if (!entry || typeof entry !== 'object') continue;
    const stamped = parseLogTime(
      (entry as Record<string, unknown>)['timestamp'],
    );
    if (stamped) {
      const day = stamped.toISOString().slice(0, 10);
      buckets.imageDays.set(day, (buckets.imageDays.get(day) ?? 0) + 1);
      if (!latest || stamped > latest) latest = stamped;
    }
  }
  return { count: logs.length, latest };
}

export async function workspaceStats(
  workspaceDir?: string,
): Promise<WorkspaceStats> {
  const ws = await resolveWorkspace(workspaceDir);
  const root = resolve(ws);

  let files: InputFileEntry[] = [];
  try {
    files = await listInputFiles(root);
  } catch {
    files = [];
  }
  const contentFiles = files.filter(
    (f) => !f.path.startsWith('styles/') && !isManifestFile(f.path),
  );

  const buckets: DayBuckets = { chatDays: new Map(), imageDays: new Map() };
  const outputsDir = join(root, 'outputs');
  const chat = await collectChatLogStats(outputsDir, buckets);
  const images = await collectImageLogStats(outputsDir, buckets);

  let latest: Date | null = chat.latest;
  if (images.latest && (!latest || images.latest > latest)) {
    latest = images.latest;
  }
  let totalBytes = 0;
  for (const f of contentFiles) {
    try {
      const st = await stat(join(root, f.path));
      totalBytes += st.size;
      const mtime = new Date(st.mtimeMs);
      if (!latest || mtime > latest) latest = mtime;
    } catch {
      continue;
    }
  }

  const activity: ActivityDay[] = [];
  for (let back = 13; back >= 0; back--) {
    const day = new Date(Date.now() - back * 86400000)
      .toISOString()
      .slice(0, 10);
    activity.push({
      date: day,
      chats: buckets.chatDays.get(day) ?? 0,
      images: buckets.imageDays.get(day) ?? 0,
    });
  }

  return {
    markdown_files: contentFiles.length,
    chat_sessions: chat.chatSessions,
    prompt_tokens: chat.promptTokens,
    completion_tokens: chat.completionTokens,
    images_generated: images.count,
    last_activity: latest ? latest.toISOString() : null,
    activity,
    total_bytes: totalBytes,
  };
}

// ---------------------------------------------------------------------------
// Singleton (mirrors the global `storage = FileStorageService()`)
// ---------------------------------------------------------------------------

export const storage = {
  getSettings,
  updateSettings,
  migrateImageEndpoints,
  isSubpath,
  resolveWorkspacePath,
  getActiveWorkspaceDir,
  listInputFiles,
  readWorkspaceFile,
  createWorkspaceFile,
  writeWorkspaceFile,
  deleteWorkspaceFile,
  renameWorkspaceFile,
  renameFolder,
  deleteFolder,
  browseFolders,
  validateWorkspaceName,
  resolveWorkspaceCreateTarget,
  createWorkspace,
  linkWorkspace,
  listProfiles,
  upsertProfile,
  renameProfile,
  deleteProfile,
  gitInit,
  gitStatus,
  gitTracked,
  gitRemove,
  workspaceStats,
  saveMediaBuffer,
  readMedia,
};

export type StorageService = typeof storage;
