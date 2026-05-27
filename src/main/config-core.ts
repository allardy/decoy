import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { defaultFilters } from './recording/filters.js'
import type { FilterConfig } from './recording/types.js'

// Pure config logic, decoupled from Electron so it unit-tests without an app.
// The Electron wrapper (config.ts) supplies the real userData dir + default root.

export interface DecoyConfig {
  /** Folder Decoy writes recordings into (the last folder the user picked). */
  sessionsRoot: string
  /** Recently used start URLs, most-recent-first, for autocomplete. */
  urlHistory: string[]
  /** Capture filter — which resource types / hosts to skip. */
  filters: FilterConfig
}

const FILE = 'decoy.json'
const HISTORY_MAX = 25

function defaults(fallbackRoot: string): DecoyConfig {
  return { sessionsRoot: fallbackRoot, urlHistory: [], filters: defaultFilters() }
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.filter((x: unknown): x is string => typeof x === 'string') : fallback
}

function parseFilters(raw: unknown): FilterConfig {
  const d = defaultFilters()

  if (!raw || typeof raw !== 'object') {
    return d
  }

  const r = raw as { skipResourceTypes?: unknown; blockHosts?: unknown }

  return {
    skipResourceTypes: asStringArray(r.skipResourceTypes, d.skipResourceTypes),
    blockHosts: asStringArray(r.blockHosts, d.blockHosts),
  }
}

export function parseConfig(raw: string, fallbackRoot: string): DecoyConfig {
  try {
    const parsed = JSON.parse(raw)
    const sessionsRoot =
      typeof parsed?.sessionsRoot === 'string' && parsed.sessionsRoot.trim() ? parsed.sessionsRoot : fallbackRoot
    const urlHistory = asStringArray(parsed?.urlHistory, [])

    return { sessionsRoot, urlHistory, filters: parseFilters(parsed?.filters) }
  } catch {
    return defaults(fallbackRoot)
  }
}

/** Add a URL to the front of the history, de-duplicated and capped. */
export function pushHistory(history: string[], url: string, max = HISTORY_MAX): string[] {
  const u = url.trim()

  if (!u) {
    return history
  }

  return [u, ...history.filter((h) => h !== u)].slice(0, max)
}

export async function readConfig(configDir: string, fallbackRoot: string): Promise<DecoyConfig> {
  try {
    const raw = await readFile(join(configDir, FILE), 'utf8')

    return parseConfig(raw, fallbackRoot)
  } catch {
    // missing file → defaults
    return defaults(fallbackRoot)
  }
}

export async function writeConfig(configDir: string, config: DecoyConfig): Promise<void> {
  await mkdir(configDir, { recursive: true })
  await writeFile(join(configDir, FILE), JSON.stringify(config, null, 2), 'utf8')
}
