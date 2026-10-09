import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

function dataRoot(): string {
  const fromEnv = process.env.MARGIN_DATA_DIR?.trim()
  if (fromEnv) return resolve(fromEnv)
  if (process.env.NODE_ENV === 'test') {
    const tmp = process.env.MARGIN_TEST_DIR?.trim()
    if (tmp) return resolve(tmp)
  }
  // Docker: /data (volume). Local dev fallback: ~/.margin to match
  // platformdirs user_config_dir behavior on Linux.
  if (existsSync('/data')) return '/data'
  return join(homedir(), '.margin')
}

export const DATA_ROOT = dataRoot()
export const SETTINGS_PATH = join(DATA_ROOT, 'settings.json')

export function defaultWorkspaceDir(): string {
  return join(DATA_ROOT, 'workspaces', 'default')
}

export function ensureDataDirs(workspaceDir?: string) {
  mkdirSync(DATA_ROOT, { recursive: true })
  const ws = workspaceDir ?? defaultWorkspaceDir()
  for (const sub of ['chapters', 'characters', 'styles', 'assets', 'outputs']) {
    mkdirSync(join(ws, sub), { recursive: true })
  }
  return ws
}
